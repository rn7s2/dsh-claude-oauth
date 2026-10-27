/**
 * Claude OAuth token storage and access-token lifecycle.
 *
 * The token record is the only place this plugin keeps a secret. It lives in
 * the private plugin data directory as JSON with mode 0600 (directory 0700)
 * and is always written atomically through lib/files.js.
 *
 * Refresh is the delicate part: the refresh token is single-use and rotates,
 * so two concurrent refreshes can invalidate one another. Therefore a refresh
 * happens while holding a cross-process lock file, the stored record is
 * re-read inside the lock (a token refreshed by another process is reused
 * instead of spending the single-use grant again), and callers inside this
 * process share one in-flight refresh.
 *
 * Nothing here logs, and no error message, detail object, URL, or return value
 * carries an access or refresh token value.
 */
import { join } from 'node:path';
import {
  CC_USER_AGENT,
  CLIENT_ID,
  DEFAULT_REFRESH_TOKEN_LIFETIME_MS,
  ERROR_CODES,
  OAUTH_BETA,
  REFRESH_BEFORE_EXPIRY_SECONDS,
  REFRESH_SCOPES,
  TOKEN_FILE_NAME,
  TOKEN_LOCK_NAME,
  TOKEN_REQUEST_TIMEOUT_MS,
  TOKEN_URL,
} from './constants.js';
import { PluginError } from './errors.js';
import {
  ensurePrivateDir,
  pluginDataDir,
  readJsonFile,
  removeFile,
  withFileLock,
  writeJsonFile,
} from './files.js';

/** The one token-record schema version this module understands. */
const TOKEN_VERSION = 1;
/** Every Claude Code OAuth access token starts with this prefix. */
const ACCESS_TOKEN_PREFIX = 'sk-ant-oat';
/** `expires_in` fallback for an otherwise well-formed token response. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
/** Bound on how many times a forced refresh follows another in-flight refresh. */
const FORCE_JOIN_ATTEMPTS = 3;

/** Absolute path of the token record file. */
export function tokenFilePath() {
  return join(pluginDataDir(), TOKEN_FILE_NAME);
}

/** Absolute path of the cross-process refresh lock file. */
export function tokenLockPath() {
  return join(pluginDataDir(), TOKEN_LOCK_NAME);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFinitePositive(value) {
  return isFiniteNumber(value) && value > 0;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function nowMs(now) {
  if (typeof now === 'function') {
    const value = now();
    return isFiniteNumber(value) ? value : Date.now();
  }
  return isFiniteNumber(now) ? now : Date.now();
}

/**
 * Coerce an arbitrary value into the canonical token-record shape.
 * @returns the normalized record, or `null` when the value is not a record.
 */
function normalizeTokenRecord(value) {
  if (!isPlainObject(value)) return null;
  if (value.version !== TOKEN_VERSION) return null;
  if (!isNonEmptyString(value.accessToken) || !value.accessToken.startsWith(ACCESS_TOKEN_PREFIX)) return null;
  if (!isNonEmptyString(value.refreshToken)) return null;
  if (!isFinitePositive(value.expiresAt)) return null;
  if (!isFinitePositive(value.refreshTokenExpiresAt)) return null;
  if (typeof value.scopes !== 'string') return null;
  if (!isFinitePositive(value.obtainedAt)) return null;
  return {
    version: TOKEN_VERSION,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    refreshTokenExpiresAt: value.refreshTokenExpiresAt,
    scopes: value.scopes,
    obtainedAt: value.obtainedAt,
  };
}

function notLoggedIn() {
  return new PluginError(ERROR_CODES.NOT_LOGGED_IN, 'Not signed in to Claude. Please sign in first.');
}

function refreshTokenExpired() {
  return new PluginError(
    ERROR_CODES.REFRESH_TOKEN_EXPIRED,
    'The Claude session has expired. Please sign in again.',
  );
}

function corruptTokens(reason) {
  const message =
    reason === 'unreadable'
      ? 'Stored Claude sign-in data could not be read. Please sign in again.'
      : 'Stored Claude sign-in data is invalid. Please sign in again.';
  return new PluginError(ERROR_CODES.TOKEN_EXPIRED, message, { reason });
}

/**
 * Read the stored token record.
 * @returns {Promise<object|null>} the record, or `null` when no token is stored.
 * @throws {PluginError} `TOKEN_EXPIRED` when the file exists but is unreadable
 *   or no longer matches the token-record schema.
 */
export async function readTokens() {
  let raw;
  try {
    raw = await readJsonFile(tokenFilePath());
  } catch {
    throw corruptTokens('unreadable');
  }
  if (raw === undefined) return null;
  const tokens = normalizeTokenRecord(raw);
  if (tokens === null) throw corruptTokens('invalid');
  return tokens;
}

/**
 * Persist a token record atomically (mode 0600, directory 0700).
 * Unknown fields are dropped so the file stays exactly the documented shape.
 * @throws {PluginError} `INVALID_REQUEST` when the record is malformed.
 */
export async function writeTokens(tokens) {
  const candidate = isPlainObject(tokens) ? { ...tokens, version: tokens.version ?? TOKEN_VERSION } : tokens;
  const normalized = normalizeTokenRecord(candidate);
  if (normalized === null) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'Refusing to store an invalid Claude token record.');
  }
  await ensurePrivateDir();
  await writeJsonFile(tokenFilePath(), normalized);
}

/** Remove the stored token record; missing files are not an error. */
export async function clearTokens() {
  await removeFile(tokenFilePath());
}

/**
 * Whether the access token is still comfortably valid.
 * A token is refreshed when less than `refreshBeforeExpirySeconds` remain, so
 * it counts as fresh while at least that much lifetime is left.
 */
export function isAccessTokenFresh(tokens, options = {}) {
  if (tokens === null || typeof tokens !== 'object') return false;
  const now = nowMs(options.now);
  const before =
    isFiniteNumber(options.refreshBeforeExpirySeconds) && options.refreshBeforeExpirySeconds >= 0
      ? options.refreshBeforeExpirySeconds
      : REFRESH_BEFORE_EXPIRY_SECONDS;
  return tokens.expiresAt - now >= before * 1000;
}

function normalizeRefreshOptions(options) {
  if (options === null || options === undefined) options = {};
  if (!isPlainObject(options)) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'Invalid Claude token request options.');
  }
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'No fetch implementation is available.');
  }
  const signal = options.signal ?? undefined;
  if (signal !== undefined) {
    const usable =
      typeof signal === 'object' &&
      signal !== null &&
      typeof signal.aborted === 'boolean' &&
      typeof signal.addEventListener === 'function';
    if (!usable) {
      throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'Invalid Claude token request signal.');
    }
  }
  return {
    signal,
    fetchImpl,
    now: options.now,
    timeoutMs: isFinitePositive(options.timeoutMs) ? options.timeoutMs : TOKEN_REQUEST_TIMEOUT_MS,
    refreshBeforeExpirySeconds:
      isFiniteNumber(options.refreshBeforeExpirySeconds) && options.refreshBeforeExpirySeconds >= 0
        ? options.refreshBeforeExpirySeconds
        : REFRESH_BEFORE_EXPIRY_SECONDS,
    // Test seam: production always talks to the fixed Anthropic token endpoint.
    tokenUrl: isNonEmptyString(options.tokenUrl) ? options.tokenUrl : TOKEN_URL,
  };
}

/** Combine the caller signal with the bounded request timeout. */
function requestSignal(options) {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
}

function transportError(error, options) {
  if (options.signal !== undefined && options.signal.aborted) {
    return new PluginError(ERROR_CODES.REFRESH_FAILED, 'Claude token refresh was cancelled.', {
      reason: 'aborted',
    });
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') {
    return new PluginError(ERROR_CODES.REFRESH_FAILED, 'Claude token refresh timed out.', {
      reason: 'timeout',
    });
  }
  return new PluginError(ERROR_CODES.REFRESH_FAILED, 'Claude token refresh request failed.', {
    reason: 'network',
  });
}

/** Keep only a plausible OAuth error code; never echo an arbitrary body string. */
function oauthErrorCode(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^[A-Za-z0-9_.-]{1,64}$/.exec(value.trim());
  return match === null ? undefined : match[0];
}

/**
 * POST one token-endpoint request and classify the outcome.
 * @returns {Promise<{ok: true, payload: object} | {ok: false, status: number, oauthError?: string}>}
 */
async function postTokenRequest(url, body, options) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json',
    'anthropic-beta': OAUTH_BETA,
    'user-agent': CC_USER_AGENT,
  };
  let response;
  try {
    response = await options.fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: requestSignal(options),
    });
  } catch (error) {
    throw transportError(error, options);
  }
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    throw transportError(error, options);
  }
  let payload = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (response.ok) {
    if (!isPlainObject(payload)) {
      throw new PluginError(ERROR_CODES.REFRESH_FAILED, 'Claude token refresh returned an invalid response.');
    }
    return { ok: true, payload };
  }
  const code = isPlainObject(payload) ? oauthErrorCode(payload.error) : undefined;
  return code === undefined
    ? { ok: false, status: response.status }
    : { ok: false, status: response.status, oauthError: code };
}

function refreshFailure(result) {
  const suffix = result.oauthError === undefined ? '' : `, ${result.oauthError}`;
  const details =
    result.oauthError === undefined
      ? { status: result.status }
      : { status: result.status, oauthError: result.oauthError };
  if ((result.status === 400 || result.status === 401) && result.oauthError === 'invalid_grant') {
    return new PluginError(ERROR_CODES.REFRESH_TOKEN_EXPIRED, 'The Claude session has expired. Please sign in again.', details);
  }
  return new PluginError(
    ERROR_CODES.REFRESH_FAILED,
    `Claude token refresh failed (HTTP ${result.status}${suffix}).`,
    details,
  );
}

/** Turn a successful refresh payload into a canonical token record. */
function parseRefreshPayload(payload, { now, previous }) {
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!accessToken.startsWith(ACCESS_TOKEN_PREFIX)) {
    throw new PluginError(ERROR_CODES.REFRESH_FAILED, 'Claude token refresh returned an invalid access token.');
  }
  const refreshToken = isNonEmptyString(payload.refresh_token) ? payload.refresh_token : previous.refreshToken;
  const expiresIn = isFinitePositive(payload.expires_in) ? payload.expires_in : DEFAULT_EXPIRES_IN_SECONDS;
  const refreshLifetimeMs = isFinitePositive(payload.refresh_token_expires_in)
    ? payload.refresh_token_expires_in * 1000
    : DEFAULT_REFRESH_TOKEN_LIFETIME_MS;
  const scopes = isNonEmptyString(payload.scope) ? payload.scope : previous.scopes;
  const record = normalizeTokenRecord({
    version: TOKEN_VERSION,
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    refreshTokenExpiresAt: now + refreshLifetimeMs,
    scopes,
    obtainedAt: now,
  });
  if (record === null) {
    throw new PluginError(ERROR_CODES.REFRESH_FAILED, 'Claude token refresh returned an invalid response.');
  }
  return record;
}

/**
 * Spend the stored refresh token once.
 * A server-side `invalid_scope` rejection is retried once without the scope
 * (older grants predate the narrower refresh scope set).
 */
async function requestRefresh(stored, options) {
  const granted = await postTokenRequest(
    options.tokenUrl,
    {
      grant_type: 'refresh_token',
      client_id: CLIENT_ID,
      refresh_token: stored.refreshToken,
      scope: REFRESH_SCOPES,
    },
    options,
  );
  let result = granted;
  if (result.ok === false && result.status === 400 && result.oauthError === 'invalid_scope') {
    result = await postTokenRequest(
      options.tokenUrl,
      {
        grant_type: 'refresh_token',
        client_id: CLIENT_ID,
        refresh_token: stored.refreshToken,
      },
      options,
    );
  }
  if (result.ok === false) throw refreshFailure(result);
  return parseRefreshPayload(result.payload, { now: nowMs(options.now), previous: stored });
}

/**
 * The locked read-check-refresh-write section. Resolves with the effective
 * token record (either a token that became fresh while this caller waited for
 * the lock, or a freshly rotated record).
 */
async function refreshUnderLock(options) {
  try {
    await ensurePrivateDir();
    return await withFileLock(tokenLockPath(), async () => {
      const now = nowMs(options.now);
      const stored = await readTokens();
      if (stored === null) throw notLoggedIn();
      const fresh = isAccessTokenFresh(stored, {
        now,
        refreshBeforeExpirySeconds: options.refreshBeforeExpirySeconds,
      });
      // A forced refresh still reuses a token that *another* writer produced
      // after this caller started waiting: that token has not been rejected yet
      // and reusing it avoids spending the single-use grant twice.
      const refreshedElsewhere =
        options.force === true && isFiniteNumber(options.startedAt) && stored.obtainedAt >= options.startedAt;
      if (fresh && (options.force !== true || refreshedElsewhere)) return stored;
      if (stored.refreshTokenExpiresAt <= now) throw refreshTokenExpired();
      const next = await requestRefresh(stored, options);
      await writeTokens(next);
      return next;
    });
  } catch (error) {
    if (error instanceof PluginError) throw error;
    // Lock contention or unexpected storage I/O must still surface as a typed,
    // secret-free failure: consumers route on `code`, never on message text.
    throw new PluginError(ERROR_CODES.REFRESH_FAILED, 'Claude token refresh could not be completed.', {
      reason: 'storage',
    });
  }
}

/** Promise of the one in-process refresh currently in flight, if any. */
let inFlightRefresh = null;

function startRefresh(options) {
  const promise = refreshUnderLock(options).finally(() => {
    if (inFlightRefresh === promise) inFlightRefresh = null;
  });
  inFlightRefresh = promise;
  // A cancelled waiter must not turn the shared promise into an unhandled rejection.
  promise.catch(() => {});
  return promise;
}

/**
 * Return a usable access token, refreshing proactively when the stored token
 * is within `REFRESH_BEFORE_EXPIRY_SECONDS` of expiry.
 *
 * @param {{ signal?: AbortSignal, fetchImpl?: typeof fetch, now?: number|(() => number),
 *   refreshBeforeExpirySeconds?: number, timeoutMs?: number, tokenUrl?: string }} [options]
 * @returns {Promise<string>} a non-expired access token
 * @throws {PluginError} NOT_LOGGED_IN, TOKEN_EXPIRED, REFRESH_TOKEN_EXPIRED,
 *   REFRESH_FAILED, or INVALID_REQUEST
 */
export async function ensureAccessToken(options = {}) {
  const resolved = normalizeRefreshOptions(options);
  const stored = await readTokens();
  if (stored === null) throw notLoggedIn();
  const fresh = isAccessTokenFresh(stored, {
    now: nowMs(resolved.now),
    refreshBeforeExpirySeconds: resolved.refreshBeforeExpirySeconds,
  });
  if (fresh) return stored.accessToken;
  const pending = inFlightRefresh;
  if (pending !== null) return (await pending).accessToken;
  return (await startRefresh({ ...resolved, force: false })).accessToken;
}

/**
 * Force one rotation regardless of the stored access-token expiry, used after
 * a 401 from the inference API. Concurrent callers in this process share one
 * refresh, and a token rotated by another writer while this caller waited is
 * reused instead of rotating twice.
 *
 * @param {Parameters<typeof ensureAccessToken>[0]} [options]
 * @returns {Promise<string>} the rotated (or concurrently rotated) access token
 */
export async function forceRefreshAccessToken(options = {}) {
  const resolved = normalizeRefreshOptions(options);
  const startedAt = nowMs(resolved.now);
  for (let attempt = 0; attempt < FORCE_JOIN_ATTEMPTS; attempt += 1) {
    const pending = inFlightRefresh;
    if (pending === null) {
      return (await startRefresh({ ...resolved, force: true, startedAt })).accessToken;
    }
    let record = null;
    try {
      record = await pending;
    } catch {
      record = null;
    }
    if (record !== null && record.obtainedAt >= startedAt) return record.accessToken;
  }
  return (await startRefresh({ ...resolved, force: true, startedAt })).accessToken;
}
