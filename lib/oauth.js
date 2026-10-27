/**
 * Claude OAuth browser sign-in: PKCE (S256), a dual-stack loopback callback
 * listener, and the authorization-code exchange.
 *
 * The flow is deliberately self-contained:
 *  - `generatePkce()` makes a fresh verifier/challenge pair, `state` is a
 *    second independent random value, and the callback compares it in
 *    constant time;
 *  - the loopback listener binds `127.0.0.1` and `::1` on one port, tries the
 *    Claude Code preferred port first and falls back to an ephemeral one;
 *  - every request needs a GET, the exact callback path, and a loopback Host
 *    header, so a hostile page cannot drive the callback through
 *    DNS-rebinding;
 *  - the first valid claim is exchanged immediately (inside the flow, before
 *    `wait` resolves) and later requests get a 409 while the listener keeps
 *    answering 404 for harmless extras (favicon) until `dispose`;
 *  - the token record is returned, never written: persistence is the token
 *    store's job.
 *
 * No error message, detail object, URL, or page ever contains a token value.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import {
  AUTHORIZE_URL,
  CALLBACK_HOST,
  CALLBACK_HOST_V6,
  CALLBACK_PATH,
  CALLBACK_PREFERRED_PORT,
  CALLBACK_REDIRECT_HOST,
  CC_USER_AGENT,
  CLIENT_ID,
  DEFAULT_REFRESH_TOKEN_LIFETIME_MS,
  ERROR_CODES,
  LOGIN_SCOPES,
  LOGIN_TIMEOUT_MS,
  OAUTH_BETA,
  TOKEN_REQUEST_TIMEOUT_MS,
  TOKEN_URL,
} from './constants.js';
import { PluginError } from './errors.js';

/** Every Claude Code OAuth access token starts with this prefix. */
const ACCESS_TOKEN_PREFIX = 'sk-ant-oat';
/** `expires_in` fallback for an otherwise well-formed token response. */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;
/** Cap on provider-supplied text echoed into the static browser page. */
const MAX_PAGE_DETAIL = 200;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPositiveNumber(value) {
  return isFiniteNumber(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
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

/** Wrap an IPv6 literal for use in a URL authority. */
function hostForUrl(host) {
  return host.includes(':') ? `[${host}]` : host;
}

/** Keep only a plausible OAuth error code; never echo an arbitrary string. */
function oauthErrorCode(value) {
  if (typeof value !== 'string') return undefined;
  const match = /^[A-Za-z0-9_.-]{1,64}$/.exec(value.trim());
  return match === null ? undefined : match[0];
}

/** Trim and cap provider-supplied text before it is escaped into HTML. */
function sanitizePageDetail(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return text.length > MAX_PAGE_DETAIL ? `${text.slice(0, MAX_PAGE_DETAIL)}...` : text;
}

/** Escape text for HTML element content and quoted attributes. */
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const PAGE_STYLE = [
  'body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;',
  'font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#18181b;color:#f4f4f5}',
  'main{max-width:420px;padding:32px;border:1px solid #3f3f46;border-radius:16px;background:#27272a;text-align:center}',
  'h1{margin:0 0 12px;font-size:20px}',
  'p{margin:0;font-size:14px;line-height:1.55;color:#a1a1aa}',
].join('');

/** Static, script-free result page. */
function pageHtml(title, message) {
  return [
    '<!doctype html>',
    '<html lang="en"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title><style>${PAGE_STYLE}</style></head>`,
    `<body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></main></body></html>`,
  ].join('');
}

const HTML_HEADERS = Object.freeze({
  'content-type': 'text/html; charset=utf-8',
  'cache-control': 'no-store, max-age=0',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
});

function sendHtml(response, statusCode, html) {
  try {
    response.writeHead(statusCode, HTML_HEADERS);
    response.end(html);
  } catch {
    // The browser went away before we could answer; nothing safe to do here.
  }
}

/** Constant-time comparison of the OAuth state value. */
function stateMatches(expected, actual) {
  if (typeof actual !== 'string' || actual.length === 0) return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const actualBytes = Buffer.from(actual, 'utf8');
  if (expectedBytes.length !== actualBytes.length) {
    // Constant work on the failure path too; timingSafeEqual needs equal lengths.
    timingSafeEqual(expectedBytes, expectedBytes);
    return false;
  }
  return timingSafeEqual(expectedBytes, actualBytes);
}

function signInFailure(message, details) {
  return new PluginError(ERROR_CODES.LOGIN_FAILED, message, details);
}

/** A brand-new PKCE verifier/challenge pair for one sign-in attempt. */
export function generatePkce() {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createPkceChallenge(verifier) };
}

/** `BASE64URL(SHA256(ASCII(verifier)))`, RFC 7636 S256. */
export function createPkceChallenge(verifier) {
  if (typeof verifier !== 'string' || verifier.length === 0) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'A PKCE verifier is required.');
  }
  return createHash('sha256').update(verifier, 'utf8').digest('base64url');
}

/**
 * Build the browser authorization URL. Pure; used by the flow and by tests.
 * @param {{authorizeUrl?: string, clientId?: string, redirectUri: string, scopes?: string,
 *   state: string, codeChallenge: string}} options
 */
export function buildAuthorizeUrl(options = {}) {
  if (!isPlainObject(options)) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'Invalid Claude authorize URL options.');
  }
  const redirectUri = options.redirectUri;
  const state = options.state;
  const codeChallenge = options.codeChallenge;
  if (!isNonEmptyString(redirectUri)) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'A redirect URI is required.');
  }
  if (!isNonEmptyString(state)) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'A sign-in state value is required.');
  }
  if (!isNonEmptyString(codeChallenge)) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'A PKCE challenge is required.');
  }
  let url;
  try {
    url = new URL(isNonEmptyString(options.authorizeUrl) ? options.authorizeUrl : AUTHORIZE_URL);
  } catch {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'Invalid Claude authorize URL.');
  }
  const params = url.searchParams;
  params.set('code', 'true');
  params.set('client_id', isNonEmptyString(options.clientId) ? options.clientId : CLIENT_ID);
  params.set('response_type', 'code');
  params.set('redirect_uri', redirectUri);
  params.set('scope', isNonEmptyString(options.scopes) ? options.scopes : LOGIN_SCOPES);
  params.set('state', state);
  params.set('code_challenge', codeChallenge);
  params.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Turn a token-endpoint payload into the canonical token record. Pure; the
 * record is returned to the caller and never written here.
 *
 * @param {object} payload decoded JSON token response
 * @param {{now?: number|(() => number), scopes?: string, previousRefreshToken?: string}} [options]
 * @returns {{version: 1, accessToken: string, refreshToken: string, expiresAt: number,
 *   refreshTokenExpiresAt: number, scopes: string, obtainedAt: number}}
 * @throws {PluginError} LOGIN_FAILED when the payload is not a usable session
 */
export function parseTokenResponse(payload, options = {}) {
  if (!isPlainObject(payload)) throw signInFailure('Claude sign-in returned an invalid response.');
  const accessToken = typeof payload.access_token === 'string' ? payload.access_token : '';
  if (!accessToken.startsWith(ACCESS_TOKEN_PREFIX)) {
    throw signInFailure('Claude sign-in returned an invalid access token.');
  }
  const refreshToken = isNonEmptyString(payload.refresh_token)
    ? payload.refresh_token
    : options.previousRefreshToken;
  if (!isNonEmptyString(refreshToken)) {
    throw signInFailure('Claude sign-in did not return a refresh token.');
  }
  const now = nowMs(options.now);
  const expiresIn = isPositiveNumber(payload.expires_in) ? payload.expires_in : DEFAULT_EXPIRES_IN_SECONDS;
  const refreshLifetimeMs = isPositiveNumber(payload.refresh_token_expires_in)
    ? payload.refresh_token_expires_in * 1000
    : DEFAULT_REFRESH_TOKEN_LIFETIME_MS;
  const scopes = isNonEmptyString(payload.scope)
    ? payload.scope
    : isNonEmptyString(options.scopes)
      ? options.scopes
      : LOGIN_SCOPES;
  return {
    version: 1,
    accessToken,
    refreshToken,
    expiresAt: now + expiresIn * 1000,
    refreshTokenExpiresAt: now + refreshLifetimeMs,
    scopes,
    obtainedAt: now,
  };
}

/** Combine the caller signal (if any) with the bounded request timeout. */
function requestSignal(options) {
  const timeout = AbortSignal.timeout(options.timeoutMs);
  return options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
}

function transportFailure(error, options) {
  if (options.signal !== undefined && options.signal.aborted) {
    return signInFailure('Claude sign-in was cancelled.', { reason: 'aborted' });
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError') {
    return signInFailure('Claude sign-in timed out.', { reason: 'timeout' });
  }
  return signInFailure('Claude sign-in request failed.', { reason: 'network' });
}

/**
 * POST one token-endpoint request with the Claude Code fingerprint headers.
 * @returns {Promise<object>} the decoded JSON payload on success
 * @throws {PluginError} LOGIN_FAILED with a status/OAuth-code-only message
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
    throw transportFailure(error, options);
  }
  let text = '';
  try {
    text = await response.text();
  } catch (error) {
    throw transportFailure(error, options);
  }
  let payload = null;
  if (text !== '') {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const code = isPlainObject(payload) ? oauthErrorCode(payload.error) : undefined;
    const suffix = code === undefined ? '' : `, ${code}`;
    const details = code === undefined ? { status: response.status } : { status: response.status, oauthError: code };
    throw signInFailure(`Claude sign-in failed (HTTP ${response.status}${suffix}).`, details);
  }
  if (!isPlainObject(payload)) throw signInFailure('Claude sign-in returned an invalid response.');
  return payload;
}

/**
 * Start the loopback callback listener(s).
 *
 * Resolves once the IPv4 listener (and, best effort, the IPv6 one) is bound,
 * so a caller can open the browser immediately. `complete(code, {redirectUri})`
 * runs inside the listener's request handler; its result resolves `wait`.
 *
 * @param {{state: string, complete: (code: string, context: {redirectUri: string}) => Promise<object>,
 *   path?: string, hostV4?: string, hostV6?: string, port?: number, redirectHost?: string,
 *   timeoutMs?: number}} options
 * @returns {Promise<{redirectUri: string, port: number, path: string, ipv6Bound: boolean,
 *   wait: () => Promise<object>, cancel: () => Promise<void>, dispose: () => Promise<void>}>}
 */
export async function startCallbackServer(options = {}) {
  if (!isPlainObject(options)) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'Invalid sign-in callback options.');
  }
  const state = options.state;
  if (!isNonEmptyString(state)) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'A sign-in state value is required.');
  }
  const complete = options.complete;
  if (typeof complete !== 'function') {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'A callback completion handler is required.');
  }
  const callbackPath = isNonEmptyString(options.path) ? options.path : CALLBACK_PATH;
  if (!callbackPath.startsWith('/')) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'The callback path must start with "/".');
  }
  const hostV4 = isNonEmptyString(options.hostV4) ? options.hostV4 : CALLBACK_HOST;
  const hostV6 = isNonEmptyString(options.hostV6) ? options.hostV6 : CALLBACK_HOST_V6;
  const preferredPort = isNonNegativeInteger(options.port) ? options.port : CALLBACK_PREFERRED_PORT;
  const redirectHost = isNonEmptyString(options.redirectHost) ? options.redirectHost : CALLBACK_REDIRECT_HOST;
  const timeoutMs = isPositiveNumber(options.timeoutMs) ? options.timeoutMs : LOGIN_TIMEOUT_MS;

  const servers = [];
  let boundPort = Number.NaN;
  let allowedHosts = new Set();
  let claimed = false;
  let settled = false;
  let timer = null;
  let closePromise = null;
  let disposePromise = null;

  let resolveWait = () => {};
  let rejectWait = () => {};
  const waitPromise = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  // A flow that is cancelled or disposed before anyone waits must not produce
  // an unhandled rejection.
  waitPromise.catch(() => {});

  const makeRedirectUri = () =>
    `http://${hostForUrl(redirectHost)}:${boundPort}${callbackPath}`;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const settleResolve = (value) => {
    if (settled) return;
    settled = true;
    clearTimer();
    resolveWait(value);
  };

  const settleReject = (error) => {
    if (settled) return;
    settled = true;
    clearTimer();
    rejectWait(error);
  };

  const closeServers = () => {
    if (closePromise !== null) return closePromise;
    closePromise = Promise.all(
      servers.map(
        (server) =>
          new Promise((resolve) => {
            try {
              server.closeAllConnections?.();
              server.close(() => resolve());
            } catch {
              resolve();
            }
          }),
      ),
    );
    return closePromise;
  };

  const rejectCancelled = () => {
    settleReject(new PluginError(ERROR_CODES.LOGIN_CANCELLED, 'Claude sign-in was cancelled.'));
  };

  const handleRequest = (request, response) => {
    void (async () => {
      try {
        let url;
        try {
          url = new URL(request.url ?? '/', 'http://localhost');
        } catch {
          sendHtml(response, 400, pageHtml('Bad request', 'The request could not be understood.'));
          return;
        }
        if (url.pathname !== callbackPath) {
          sendHtml(response, 404, pageHtml('Not found', 'There is nothing at this address.'));
          return;
        }
        if (request.method !== 'GET') {
          sendHtml(response, 405, pageHtml('Method not allowed', 'The sign-in callback only accepts GET requests.'));
          return;
        }
        const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : '';
        if (!allowedHosts.has(host)) {
          sendHtml(
            response,
            400,
            pageHtml('Sign-in rejected', 'The request did not arrive on the expected local address.'),
          );
          return;
        }
        if (claimed || settled) {
          sendHtml(response, 409, pageHtml('Already handled', 'This sign-in has already been processed.'));
          return;
        }
        const query = url.searchParams;
        const returnedState = query.get('state');
        if (!stateMatches(state, returnedState ?? '')) {
          sendHtml(
            response,
            400,
            pageHtml('Sign-in rejected', 'The sign-in response did not match this request.'),
          );
          return;
        }
        const errorCode = query.get('error');
        if (isNonEmptyString(errorCode)) {
          const safeCode = oauthErrorCode(errorCode) ?? 'unknown_error';
          const description = sanitizePageDetail(query.get('error_description') ?? '');
          const detail = description === '' ? safeCode : `${safeCode}: ${description}`;
          sendHtml(
            response,
            400,
            pageHtml('Sign-in not completed', `Claude reported an error (${detail}). You can close this tab.`),
          );
          settleReject(
            signInFailure(`Claude sign-in was not completed (${safeCode}).`, { oauthError: safeCode }),
          );
          return;
        }
        const code = query.get('code');
        if (!isNonEmptyString(code)) {
          sendHtml(
            response,
            400,
            pageHtml('Missing authorization code', 'Return to DeepSeek Harness and start the sign-in again.'),
          );
          return;
        }
        claimed = true;
        let record;
        try {
          record = await complete(code, { redirectUri: makeRedirectUri() });
        } catch (error) {
          settleReject(asLoginFailure(error));
          sendHtml(
            response,
            502,
            pageHtml('Sign-in failed', 'The authorization code could not be exchanged. Please try again.'),
          );
          return;
        }
        if (record === null || record === undefined) {
          settleReject(signInFailure('Claude sign-in did not produce a session.'));
          sendHtml(response, 502, pageHtml('Sign-in failed', 'The sign-in did not produce a session. Please try again.'));
          return;
        }
        settleResolve(record);
        sendHtml(response, 200, pageHtml('Signed in to Claude', 'You can close this tab and return to DeepSeek Harness.'));
      } catch {
        sendHtml(response, 500, pageHtml('Sign-in failed', 'An unexpected error occurred. Please try again.'));
      }
    })();
  };

  const listen = (host, port) =>
    new Promise((resolve, reject) => {
      const server = createServer(handleRequest);
      const onError = (error) => {
        server.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.removeListener('error', onError);
        server.on('error', () => {});
        resolve(server);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen({ host, port, exclusive: true });
    });

  const bindFailure = () =>
    signInFailure('Could not start the local Claude sign-in listener.', { reason: 'bind_failed' });

  let primary;
  try {
    primary = await listen(hostV4, preferredPort);
  } catch {
    if (preferredPort === 0) throw bindFailure();
    try {
      primary = await listen(hostV4, 0);
    } catch {
      throw bindFailure();
    }
  }
  servers.push(primary);
  const address = primary.address();
  if (address === null || typeof address !== 'object') {
    await closeServers();
    throw bindFailure();
  }
  boundPort = address.port;
  allowedHosts = new Set([
    `localhost:${boundPort}`,
    `127.0.0.1:${boundPort}`,
    `[::1]:${boundPort}`,
  ]);

  let ipv6Bound = false;
  if (hostV6 !== hostV4) {
    try {
      const secondary = await listen(hostV6, boundPort);
      servers.push(secondary);
      ipv6Bound = true;
    } catch {
      // IPv6 loopback is a convenience; IPv4/Host-header checks still apply.
      ipv6Bound = false;
    }
  }

  timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    clearTimer();
    rejectWait(new PluginError(ERROR_CODES.LOGIN_TIMEOUT, 'Claude sign-in timed out.'));
    void closeServers();
  }, timeoutMs);
  timer.unref?.();

  const wait = () => waitPromise;
  // Accept both `await flow.wait()` and `await flow.wait` so either calling
  // convention from a consumer works.
  Object.defineProperty(wait, 'then', {
    configurable: true,
    value: (onFulfilled, onRejected) => waitPromise.then(onFulfilled, onRejected),
  });

  const cancel = async () => {
    rejectCancelled();
    await closeServers();
  };

  const dispose = () => {
    rejectCancelled();
    if (disposePromise === null) disposePromise = closeServers();
    return disposePromise;
  };

  return {
    redirectUri: makeRedirectUri(),
    port: boundPort,
    path: callbackPath,
    ipv6Bound,
    wait,
    cancel,
    dispose,
  };
}

/** Normalize an arbitrary callback-handler failure into a safe PluginError. */
function asLoginFailure(error) {
  if (error instanceof PluginError && typeof error.code === 'string') {
    return error;
  }
  return signInFailure('Claude sign-in failed. Please try again.');
}

/**
 * Create one browser sign-in flow.
 *
 * Resolves only after the loopback listener(s) are bound, so the caller may
 * open `authUrl` immediately. `wait` resolves with the token record once the
 * authorization code has been exchanged (the record is not written anywhere);
 * it rejects with `LOGIN_TIMEOUT`, `LOGIN_CANCELLED`, or `LOGIN_FAILED`.
 *
 * @param {{fetchImpl?: typeof fetch, now?: number|(() => number), timeoutMs?: number,
 *   requestTimeoutMs?: number, preferredPort?: number, authorizeUrl?: string,
 *   tokenUrl?: string, clientId?: string, scopes?: string, callbackPath?: string,
 *   bindHostV4?: string, bindHostV6?: string, redirectHost?: string}} [options]
 */
export async function createLoginFlow(options = {}) {
  if (options === null || options === undefined) options = {};
  if (!isPlainObject(options)) {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'Invalid Claude sign-in options.');
  }
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new PluginError(ERROR_CODES.INVALID_REQUEST, 'No fetch implementation is available.');
  }
  const authorizeUrl = isNonEmptyString(options.authorizeUrl) ? options.authorizeUrl : AUTHORIZE_URL;
  const tokenUrl = isNonEmptyString(options.tokenUrl) ? options.tokenUrl : TOKEN_URL;
  const clientId = isNonEmptyString(options.clientId) ? options.clientId : CLIENT_ID;
  const scopes = isNonEmptyString(options.scopes) ? options.scopes : LOGIN_SCOPES;
  const callbackPath = isNonEmptyString(options.callbackPath) ? options.callbackPath : CALLBACK_PATH;
  const bindHostV4 = isNonEmptyString(options.bindHostV4) ? options.bindHostV4 : CALLBACK_HOST;
  const bindHostV6 = isNonEmptyString(options.bindHostV6) ? options.bindHostV6 : CALLBACK_HOST_V6;
  const redirectHost = isNonEmptyString(options.redirectHost) ? options.redirectHost : CALLBACK_REDIRECT_HOST;
  const preferredPort = isNonNegativeInteger(options.preferredPort)
    ? options.preferredPort
    : CALLBACK_PREFERRED_PORT;
  const timeoutMs = isPositiveNumber(options.timeoutMs) ? options.timeoutMs : LOGIN_TIMEOUT_MS;
  const requestTimeoutMs = isPositiveNumber(options.requestTimeoutMs)
    ? options.requestTimeoutMs
    : TOKEN_REQUEST_TIMEOUT_MS;
  const now = options.now;

  const { verifier, challenge } = generatePkce();
  // The state is independent of the PKCE verifier: one protects the redirect,
  // the other protects the code exchange.
  const state = randomBytes(32).toString('base64url');

  const callback = await startCallbackServer({
    state,
    path: callbackPath,
    hostV4: bindHostV4,
    hostV6: bindHostV6,
    port: preferredPort,
    redirectHost,
    timeoutMs,
    complete: async (code, context) => {
      const payload = await postTokenRequest(
        tokenUrl,
        {
          grant_type: 'authorization_code',
          client_id: clientId,
          code,
          state,
          redirect_uri: context.redirectUri,
          code_verifier: verifier,
        },
        { fetchImpl, timeoutMs: requestTimeoutMs },
      );
      return parseTokenResponse(payload, { now, scopes });
    },
  });

  let authUrl;
  try {
    authUrl = buildAuthorizeUrl({
      authorizeUrl,
      clientId,
      redirectUri: callback.redirectUri,
      scopes,
      state,
      codeChallenge: challenge,
    });
  } catch (error) {
    await callback.dispose();
    throw error;
  }

  return {
    authUrl,
    wait: callback.wait,
    cancel: callback.cancel,
    dispose: callback.dispose,
    // Exposed for the settings host route and tests; not secret.
    redirectUri: callback.redirectUri,
  };
}
