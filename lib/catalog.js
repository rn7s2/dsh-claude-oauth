/**
 * Claude model-catalog discovery and account-profile lookup.
 *
 * `refreshCatalog` is the only network call in this module. It asks the
 * authenticated `/v1/models` endpoint for the models the signed-in account can
 * use, accepts both the flat `{ data: [...] }` listing shape and the enriched
 * `{ models: { id: {...} } }` map, keeps `claude-*` chat models, and merges
 * the reported metadata over the versioned `MODEL_CAPABILITIES` table. Listing
 * values win when present and sane, because the account's own catalog is
 * authoritative; models absent from the table are still registered with the
 * metadata the listing reports plus conservative fallbacks.
 *
 * `fetchAccountProfile` is best effort on purpose: it decorates the settings
 * page when the profile endpoint answers, and returns `undefined` for every
 * failure so signing in never depends on it.
 *
 * Persistence goes through `lib/files.js` (`$DSH_HOME/claude-oauth`, mode
 * 0600). Loaders are deliberately forgiving: a missing, corrupt, or
 * newer-schema cache is reported as "no cache", invalid rows are dropped, and
 * they never throw. Account e-mail addresses are PII, so nothing here logs at
 * all (the cached e-mail is also trimmed and length-capped on the way in).
 */

import { join } from 'node:path';

import {
  ACCOUNT_FILE_NAME,
  ADAPTIVE_EFFORTS,
  ANTHROPIC_VERSION,
  CC_USER_AGENT,
  DEFAULT_EFFORT,
  ERROR_CODES,
  INFERENCE_BETAS,
  MODEL_CAPABILITIES,
  MODELS_FILE_NAME,
  MODELS_LIST_URL,
  MODELS_REQUEST_TIMEOUT_MS,
  PROFILE_REQUEST_TIMEOUT_MS,
  PROFILE_URL,
} from './constants.js';
import { PluginError } from './errors.js';
import { pluginDataDir, readJsonFile, removeFile, writeJsonFile } from './files.js';

/** Envelope versions. A cache written by another version is ignored. */
const CATALOG_CACHE_VERSION = 1;
const ACCOUNT_CACHE_VERSION = 1;

/** Metadata for a `claude-*` id the capability table does not know yet. */
const FALLBACK_CONTEXT_WINDOW = 200_000;
const FALLBACK_MAX_TOKENS = 32_000;
const FALLBACK_INPUT = Object.freeze(['text', 'image']);

/** Profile strings are informational only; cap them like the settings UI. */
const PROFILE_VALUE_MAX_LENGTH = 200;

const CLAUDE_MODEL_ID = /^claude-/i;

const PROFILE_EMAIL_PATHS = Object.freeze([
  ['account', 'email'],
  ['email'],
  ['account_email'],
]);

const PROFILE_PLAN_PATHS = Object.freeze([
  ['subscriptionType'],
  ['subscription_type'],
  ['account', 'subscription_type'],
  ['organization', 'subscription_type'],
]);

/** Whether `value` is a plain (non-array) object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** A trimmed non-empty string, or `undefined` for anything else. */
function trimmedString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/** A finite number greater than zero, or `undefined` for anything else. */
function positiveNumber(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined;
  return value;
}

/** The known capability entry for one model id, if the table has it. */
export function capabilityFor(id) {
  if (typeof id !== 'string') return undefined;
  const key = id.trim();
  if (key === '') return undefined;
  return Object.hasOwn(MODEL_CAPABILITIES, key) ? MODEL_CAPABILITIES[key] : undefined;
}

/**
 * The reasoning menu advertised for adaptive-thinking models. The adapter
 * turns these ids into display objects, so the ids stay plain strings.
 */
function adaptiveReasoning() {
  return { efforts: [...ADAPTIVE_EFFORTS], defaultEffort: DEFAULT_EFFORT };
}

/**
 * Flatten any accepted catalog payload into a list of raw entries.
 *
 * Accepted shapes: a bare array of entries, `{ data: [...] }` (the real
 * listing), and `{ models: { id: {...} } }` (the enriched map), plus a
 * `{ models: [...] }` array as a tolerant variant. Anything else yields [].
 */
function catalogEntries(payload) {
  if (Array.isArray(payload)) return payload;
  if (!isRecord(payload)) return [];
  if (Array.isArray(payload.data)) return payload.data;
  if (Array.isArray(payload.models)) return payload.models;
  if (isRecord(payload.models)) {
    return Object.entries(payload.models).map(([id, value]) => {
      if (isRecord(value)) {
        const entry = { ...value };
        if (trimmedString(entry.id) === undefined) entry.id = id;
        return entry;
      }
      if (typeof value === 'string') return { id, display_name: value };
      return { id };
    });
  }
  return [];
}

/** Convert one raw listing entry into the provider's model shape. */
function modelFromEntry(raw) {
  if (!isRecord(raw)) return undefined;
  const id = trimmedString(raw.id);
  if (id === undefined || !CLAUDE_MODEL_ID.test(id)) return undefined;

  // `type` is only present on the flat listing; anything that is not a chat
  // model (embeddings, tool definitions, ...) must not be registered.
  const type = trimmedString(raw.type);
  if (type !== undefined && type.toLowerCase() !== 'model') return undefined;

  const capability = capabilityFor(id);
  const listedName = trimmedString(raw.display_name) ?? trimmedString(raw.displayName);
  const listedContextWindow =
    positiveNumber(raw.max_input_tokens) ?? positiveNumber(raw.max_context_tokens);
  const listedMaxTokens = positiveNumber(raw.max_tokens);

  const model = {
    id,
    name: listedName ?? trimmedString(capability?.name) ?? id,
    contextWindow:
      listedContextWindow ?? positiveNumber(capability?.contextWindow) ?? FALLBACK_CONTEXT_WINDOW,
    maxTokens: listedMaxTokens ?? positiveNumber(capability?.maxTokens) ?? FALLBACK_MAX_TOKENS,
    input:
      Array.isArray(capability?.input) && capability.input.length > 0
        ? [...capability.input]
        : [...FALLBACK_INPUT],
  };

  // Unknown models get no reasoning surface: guessing `adaptive` for an
  // unknown id would send an unsupported thinking shape to the API.
  if (capability?.adaptive === true) model.reasoning = adaptiveReasoning();

  return model;
}

/**
 * Normalize a raw `/v1/models` payload into provider models.
 *
 * Pure and total: malformed input yields an empty list. Non-model types and
 * non-`claude-` ids are dropped, duplicates keep their first occurrence, and
 * response order is preserved.
 *
 * @param {unknown} entries bare array, `{data: [...]}`, or `{models: {...}}`
 * @returns {Array<{id: string, name: string, contextWindow: number, maxTokens: number, input: string[], reasoning?: {efforts: string[], defaultEffort: string}}>}
 */
export function normalizeCatalogEntries(entries) {
  const models = [];
  const seen = new Set();
  for (const raw of catalogEntries(entries)) {
    const model = modelFromEntry(raw);
    if (model === undefined || seen.has(model.id)) continue;
    seen.add(model.id);
    models.push(model);
  }
  return models;
}

/** The auth headers shared by the models listing and the profile request. */
function authHeaders(accessToken) {
  return {
    authorization: `Bearer ${typeof accessToken === 'string' ? accessToken.trim() : ''}`,
    'anthropic-version': ANTHROPIC_VERSION,
    'anthropic-beta': INFERENCE_BETAS,
    'user-agent': CC_USER_AGENT,
    'x-app': 'cli',
    accept: 'application/json',
  };
}

/** Use the injected fetch (tests) or the global one (production). */
function resolveFetch(fetchImpl) {
  return typeof fetchImpl === 'function' ? fetchImpl : fetch;
}

/**
 * Build the per-request abort signal: the mandatory timeout combined with an
 * optional caller signal (a later integration may pass its own cancellation).
 */
function requestSignal(timeoutMs, fallbackTimeoutMs, callerSignal) {
  const duration =
    typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : fallbackTimeoutMs;
  const timeoutSignal = AbortSignal.timeout(duration);
  if (callerSignal === undefined || callerSignal === null) return timeoutSignal;
  try {
    return AbortSignal.any([timeoutSignal, callerSignal]);
  } catch {
    return timeoutSignal;
  }
}

/** A numeric HTTP status if the response exposes one. */
function httpStatusOf(response) {
  if (response === null || typeof response !== 'object') return undefined;
  const status = response.status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 ? status : undefined;
}

/** Whether a response is 2xx, trusting `ok` when the mock/fetch provides it. */
function isSuccessResponse(response) {
  if (response === null || typeof response !== 'object') return false;
  if (typeof response.ok === 'boolean') return response.ok;
  const status = httpStatusOf(response);
  return status !== undefined && status >= 200 && status < 300;
}

/** Parse the response body, tolerating mocks that only expose `json()`. */
async function readJsonBody(response) {
  if (response !== null && typeof response === 'object' && typeof response.json === 'function') {
    return response.json();
  }
  const text = await response.text();
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  return JSON.parse(text);
}

/** Whether a parsed payload contains a catalog collection at all. */
function hasCatalogShape(payload) {
  if (Array.isArray(payload)) return true;
  if (!isRecord(payload)) return false;
  return Array.isArray(payload.data) || Array.isArray(payload.models) || isRecord(payload.models);
}

/** A `MODELS_FETCH_FAILED` PluginError with a safe, body-free message. */
function modelsFetchError(message, details = {}) {
  return new PluginError(ERROR_CODES.MODELS_FETCH_FAILED, message, details);
}

/** `now()` when it returns a finite number, else the wall clock. */
function resolvedNow(now) {
  try {
    const value = typeof now === 'function' ? now() : undefined;
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  } catch {
    // Fall through to the wall clock.
  }
  return Date.now();
}

/**
 * Refresh the Claude model catalog for the signed-in account.
 *
 * @param {object} [options]
 * @param {string} [options.accessToken] OAuth access token (never logged)
 * @param {typeof fetch} [options.fetchImpl] injected fetch for tests
 * @param {() => number} [options.now] clock for `fetchedAt`
 * @param {number} [options.timeoutMs] request timeout
 * @param {AbortSignal} [options.signal] optional caller cancellation
 * @returns {Promise<{models: Array<object>, fetchedAt: number}>}
 * @throws {PluginError} code MODELS_FETCH_FAILED for every request failure
 */
export async function refreshCatalog(options = {}) {
  const {
    accessToken,
    fetchImpl = fetch,
    now = Date.now,
    timeoutMs = MODELS_REQUEST_TIMEOUT_MS,
    signal,
  } = options ?? {};

  const init = {
    method: 'GET',
    headers: authHeaders(accessToken),
    signal: requestSignal(timeoutMs, MODELS_REQUEST_TIMEOUT_MS, signal),
  };

  let response;
  try {
    response = await resolveFetch(fetchImpl)(MODELS_LIST_URL, init);
  } catch {
    // Deliberately body-free and cause-free: a fetch implementation could
    // attach anything (including request material) to its error.
    throw modelsFetchError(
      'Failed to refresh the Claude model catalog: the request could not be completed.',
    );
  }

  if (!isSuccessResponse(response)) {
    const status = httpStatusOf(response);
    throw modelsFetchError(
      status === undefined
        ? 'Failed to refresh the Claude model catalog: the service returned no response.'
        : `Failed to refresh the Claude model catalog (HTTP ${status}).`,
      status === undefined ? {} : { status },
    );
  }

  let payload;
  try {
    payload = await readJsonBody(response);
  } catch {
    throw modelsFetchError(
      'Failed to refresh the Claude model catalog: the response was not valid JSON.',
    );
  }

  if (!hasCatalogShape(payload)) {
    throw modelsFetchError(
      'Failed to refresh the Claude model catalog: the response did not contain a model list.',
    );
  }

  return { models: normalizeCatalogEntries(payload), fetchedAt: resolvedNow(now) };
}

/** Walk a dotted path of plain objects and clean the value found there. */
function pickProfileString(payload, paths) {
  for (const path of paths) {
    let current = payload;
    for (const segment of path) {
      if (!isRecord(current)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    const cleaned = cleanProfileString(current);
    if (cleaned !== undefined) return cleaned;
  }
  return undefined;
}

/** Trim, reject blanks/non-strings, and cap at PROFILE_VALUE_MAX_LENGTH. */
function cleanProfileString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  return trimmed.length > PROFILE_VALUE_MAX_LENGTH ? trimmed.slice(0, PROFILE_VALUE_MAX_LENGTH) : trimmed;
}

/**
 * Fetch the signed-in account's profile. Best effort by design: every failure
 * (network, timeout, non-2xx, malformed body, unexpected shape) yields
 * `undefined` instead of throwing.
 *
 * @param {object} [options]
 * @param {string} [options.accessToken] OAuth access token (never logged)
 * @param {typeof fetch} [options.fetchImpl] injected fetch for tests
 * @param {number} [options.timeoutMs] request timeout
 * @param {AbortSignal} [options.signal] optional caller cancellation
 * @returns {Promise<{email?: string, plan?: string} | undefined>}
 */
export async function fetchAccountProfile(options = {}) {
  const { accessToken, fetchImpl = fetch, timeoutMs = PROFILE_REQUEST_TIMEOUT_MS, signal } =
    options ?? {};

  try {
    const response = await resolveFetch(fetchImpl)(PROFILE_URL, {
      method: 'GET',
      headers: authHeaders(accessToken),
      signal: requestSignal(timeoutMs, PROFILE_REQUEST_TIMEOUT_MS, signal),
    });
    if (!isSuccessResponse(response)) return undefined;

    const payload = await readJsonBody(response);
    if (!isRecord(payload)) return undefined;

    const email = pickProfileString(payload, PROFILE_EMAIL_PATHS);
    const plan = pickProfileString(payload, PROFILE_PLAN_PATHS);
    if (email === undefined && plan === undefined) return undefined;

    const profile = {};
    if (email !== undefined) profile.email = email;
    if (plan !== undefined) profile.plan = plan;
    return profile;
  } catch {
    return undefined;
  }
}

/** `$DSH_HOME/claude-oauth/models.json`. */
function catalogFilePath() {
  return join(pluginDataDir(), MODELS_FILE_NAME);
}

/** `$DSH_HOME/claude-oauth/account.json`. */
function accountFilePath() {
  return join(pluginDataDir(), ACCOUNT_FILE_NAME);
}

/** Validate one cached model row; `undefined` means "drop this row". */
function sanitizeCachedModel(value) {
  if (!isRecord(value)) return undefined;
  const id = trimmedString(value.id);
  if (id === undefined || !CLAUDE_MODEL_ID.test(id)) return undefined;
  const contextWindow = positiveNumber(value.contextWindow);
  const maxTokens = positiveNumber(value.maxTokens);
  if (contextWindow === undefined || maxTokens === undefined) return undefined;

  const input = Array.isArray(value.input)
    ? value.input.map(trimmedString).filter((entry) => entry !== undefined)
    : [];
  const model = {
    id,
    name: trimmedString(value.name) ?? id,
    contextWindow,
    maxTokens,
    input: input.length > 0 ? input : [...FALLBACK_INPUT],
  };

  // The adapter contract expects plain string effort ids.
  const reasoning = sanitizeCachedReasoning(value.reasoning);
  if (reasoning !== undefined) model.reasoning = reasoning;
  return model;
}

/** Validate cached reasoning metadata without inventing anything. */
function sanitizeCachedReasoning(value) {
  if (!isRecord(value)) return undefined;
  const efforts = Array.isArray(value.efforts)
    ? value.efforts.map(trimmedString).filter((entry) => entry !== undefined)
    : [];
  if (efforts.length === 0) return undefined;
  return { efforts, defaultEffort: trimmedString(value.defaultEffort) ?? DEFAULT_EFFORT };
}

/** Keep only the two account fields the plugin understands. */
function sanitizeAccount(value) {
  const account = {};
  if (!isRecord(value)) return account;
  const email = cleanProfileString(value.email);
  const plan = cleanProfileString(value.plan);
  if (email !== undefined) account.email = email;
  if (plan !== undefined) account.plan = plan;
  return account;
}

/**
 * Persist the refreshed catalog as `{version, fetchedAt, models}` with mode
 * 0600 under the private plugin data directory.
 *
 * @param {{models?: Array<object>, fetchedAt?: number}} [catalog]
 * @returns {Promise<{version: number, fetchedAt: number, models: Array<object>}>}
 */
export async function saveCatalog(catalog = {}) {
  const { models, fetchedAt } = catalog ?? {};
  const record = {
    version: CATALOG_CACHE_VERSION,
    fetchedAt:
      typeof fetchedAt === 'number' && Number.isFinite(fetchedAt) ? fetchedAt : Date.now(),
    models: Array.isArray(models)
      ? models.map(sanitizeCachedModel).filter((model) => model !== undefined)
      : [],
  };
  await writeJsonFile(catalogFilePath(), record);
  return record;
}

/**
 * Read the cached catalog. Missing, corrupt, or version-mismatched files are
 * "no cache"; individually invalid model rows are dropped.
 *
 * @returns {Promise<{models: Array<object>, fetchedAt: number} | undefined>}
 */
export async function loadCachedCatalog() {
  try {
    const record = await readJsonFile(catalogFilePath());
    if (!isRecord(record) || record.version !== CATALOG_CACHE_VERSION) return undefined;
    if (!Array.isArray(record.models)) return undefined;
    if (typeof record.fetchedAt !== 'number' || !Number.isFinite(record.fetchedAt)) {
      return undefined;
    }
    const models = record.models.map(sanitizeCachedModel).filter((model) => model !== undefined);
    return { models, fetchedAt: record.fetchedAt };
  } catch {
    return undefined;
  }
}

/** Delete the cached catalog; a missing file is not an error. */
export async function clearCatalog() {
  await removeFile(catalogFilePath());
}

/**
 * Persist the account profile as `{version, email?, plan?}` with mode 0600.
 * The e-mail address is PII and is never logged.
 *
 * @param {{email?: string, plan?: string}} [account]
 * @returns {Promise<{version: number, email?: string, plan?: string}>}
 */
export async function saveAccount(account = {}) {
  const record = { version: ACCOUNT_CACHE_VERSION, ...sanitizeAccount(account) };
  await writeJsonFile(accountFilePath(), record);
  return record;
}

/**
 * Read the cached account profile. Missing, corrupt, mismatched, or empty
 * caches yield `undefined`; this never throws.
 *
 * @returns {Promise<{email?: string, plan?: string} | undefined>}
 */
export async function loadCachedAccount() {
  try {
    const record = await readJsonFile(accountFilePath());
    if (!isRecord(record) || record.version !== ACCOUNT_CACHE_VERSION) return undefined;
    const account = sanitizeAccount(record);
    if (account.email === undefined && account.plan === undefined) return undefined;
    return account;
  } catch {
    return undefined;
  }
}

/** Delete the cached account profile; a missing file is not an error. */
export async function clearAccount() {
  await removeFile(accountFilePath());
}
