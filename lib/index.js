/**
 * Host half of the Claude OAuth bundle.
 *
 * Responsibilities, in order of exposure:
 *  1. own the Claude OAuth token lifecycle (login flow, on-demand refresh,
 *     logout) with the token file as the only credential store;
 *  2. register the `claude-oauth` LLM route and its model catalog;
 *  3. serve one authenticated browser route, `/api/claude-oauth`, for the
 *     settings page's status/login/logout/refresh actions;
 *  4. report the outbound proxy route DSH's own fetch dispatcher will use.
 *
 * There is no background traffic: a model request may refresh the access
 * token, the login flow makes exactly one code exchange, and `/v1/models` is
 * fetched only after a successful login or when the user presses Refresh.
 */
import { spawn } from 'node:child_process';
import {
  ADAPTIVE_EFFORTS,
  API_BASE_URL,
  API_MAX_BODY_BYTES,
  API_ROUTE_PATH,
  AUTHORIZE_URL,
  DEFAULT_CATALOG_IDS,
  DEFAULT_EFFORT,
  ERROR_CODES,
  MODEL_CAPABILITIES,
  PROVIDER_ID,
  PROVIDER_NAME,
  TOKEN_URL,
} from './constants.js';
import { PluginError, redactUrl } from './errors.js';
import { ensurePrivateDir } from './files.js';
import {
  clearAccount,
  clearCatalog,
  fetchAccountProfile,
  loadCachedAccount,
  loadCachedCatalog,
  refreshCatalog,
  saveAccount,
  saveCatalog,
} from './catalog.js';
import { createLoginFlow } from './oauth.js';
import { clearTokens, ensureAccessToken, forceRefreshAccessToken, readTokens, writeTokens } from './tokens.js';
import { createClaudeAdapter } from './adapter.js';

/** The Host services this plugin cannot work without. */
export const inject = ['llm'];

/** Server-side endpoints whose proxy route the settings page reports. */
const PROXY_TARGETS = Object.freeze([
  ['api.anthropic.com', API_BASE_URL],
  ['platform.claude.com', TOKEN_URL],
]);

/** Titles shown when the settings page cannot reach host state. */
const DEFAULT_ACCOUNT = undefined;

/** A capability-described model from the versioned table. */
function modelFromCapability(id) {
  const capability = MODEL_CAPABILITIES[id];
  if (capability === undefined) return undefined;
  return {
    id,
    name: capability.name,
    contextWindow: capability.contextWindow,
    maxTokens: capability.maxTokens,
    input: [...capability.input],
    ...(capability.adaptive
      ? { reasoning: { efforts: [...ADAPTIVE_EFFORTS], defaultEffort: DEFAULT_EFFORT } }
      : {}),
  };
}

/** The static Claude catalog used before `/v1/models` answers. */
function defaultCatalog() {
  return DEFAULT_CATALOG_IDS.map(modelFromCapability).filter((model) => model !== undefined);
}

/** A plain JSON object (not an array or null). */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** One JSON response for the settings route. */
function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

/** Human-readable, secret-free text; the stable code travels separately. */
function safeMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** A failure response carrying a stable code and safe text. */
function failureResponse(error, status = 500) {
  const code = error instanceof PluginError ? error.code : 'INTERNAL_ERROR';
  return jsonResponse({ ok: false, error: { code, message: safeMessage(error) } }, status);
}

/** Open an authorization URL in the platform browser without a shell. */
function openBrowser(url) {
  /** @type {[string, string[]]} */
  let command;
  if (process.platform === 'darwin') command = ['open', [url]];
  else if (process.platform === 'win32') command = ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  else command = ['xdg-open', [url]];
  try {
    const child = spawn(command[0], command[1], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** Build the plugin's mutable state; one instance lives in the plugin fiber. */
function createPluginState(ctx) {
  return {
    ctx,
    /** @type {Promise<void> | undefined} */
    initPromise: undefined,
    /** @type {{ version: 1, accessToken: string, refreshToken: string, expiresAt: number | null, refreshTokenExpiresAt: number | null, scopes?: string, obtainedAt?: number } | null} */
    auth: null,
    /** @type {{ email?: string, plan?: string } | undefined} */
    account: DEFAULT_ACCOUNT,
    /** @type {Array<Record<string, unknown>>} */
    models: [],
    /** @type {'cache' | 'default' | 'login' | 'manual' | null} */
    catalogSource: null,
    /** @type {number | null} */
    lastModelsAt: null,
    /** @type {string | null} */
    lastModelsError: null,
    /** @type {string | null} */
    lastLoginError: null,
    /** @type {{ authUrl: string, wait: Promise<unknown>, cancel: () => void, dispose: () => Promise<void> | void } | null} */
    loginFlow: null,
    /** @type {Promise<unknown> | null} */
    refreshPromise: null,
    /** Bumped whenever the signed-in identity changes; stale refreshes never adopt. */
    generation: 0,
    /** @type {{ replace: (providers: string[]) => void } | null} */
    adapterHandle: null,
  };
}

/** Idempotent startup: read the private files once. */
function ensureInitialized(state) {
  state.initPromise ??= (async () => {
    await ensurePrivateDir();
    try {
      state.auth = await readTokens();
    } catch (error) {
      state.auth = null;
      state.lastLoginError = safeMessage(error);
    }
    if (state.auth === null) return;
    try {
      state.account = await loadCachedAccount();
    } catch {
      state.account = DEFAULT_ACCOUNT;
    }
    const cached = await loadCachedCatalog();
    if (cached !== undefined && cached.models.length > 0) {
      state.models = cached.models;
      state.catalogSource = 'cache';
      state.lastModelsAt = cached.fetchedAt;
    } else {
      state.models = defaultCatalog();
      state.catalogSource = 'default';
    }
  })();
  return state.initPromise;
}

/** Tell DSH's model directory that this route's catalog changed. */
function publishCatalogChange(state) {
  if (state.adapterHandle === null) return;
  try {
    state.adapterHandle.replace([PROVIDER_ID]);
  } catch {
    // A disposed registration only happens during unload; nothing to refresh.
  }
}

/** Replace the in-memory catalog and persist it; the caller owns error text. */
async function adoptCatalog(state, models, fetchedAt, source) {
  state.models = models;
  state.lastModelsAt = fetchedAt;
  state.catalogSource = source;
  state.lastModelsError = null;
  try {
    await saveCatalog({ models, fetchedAt });
  } catch {
    // Persistence is a convenience; the live catalog is already registered.
  }
  publishCatalogChange(state);
}

/** One single-flight catalog refresh, with every failure kept for the UI. */
async function refreshModels(state, source) {
  if (state.refreshPromise !== null) return state.refreshPromise;
  const generation = state.generation;
  const pending = (async () => {
    const accessToken = await ensureAccessToken();
    const result = await refreshCatalog({ accessToken });
    if (state.generation !== generation) {
      throw new PluginError(ERROR_CODES.NOT_LOGGED_IN, 'The Claude session changed while models were refreshing.');
    }
    await adoptCatalog(state, result.models, result.fetchedAt, source);
    return result;
  })()
    .catch((error) => {
      state.lastModelsError = safeMessage(error);
      throw error;
    })
    .finally(() => {
      if (state.refreshPromise === pending) state.refreshPromise = null;
    });
  state.refreshPromise = pending;
  return pending;
}

/** Best-effort identity lookup after login; the account row is optional. */
async function adoptProfile(state, accessToken, generation) {
  const account = await fetchAccountProfile({ accessToken }).catch(() => undefined);
  if (state.generation !== generation) return;
  if (account === undefined) return;
  if (account.email === undefined && account.plan === undefined) return;
  state.account = account;
  try {
    await saveAccount(account);
  } catch {
    // Caching the display identity is optional.
  }
}

/** What happens once the browser flow produced tokens. */
async function afterLogin(state, tokens, generation) {
  state.models = defaultCatalog();
  state.catalogSource = 'default';
  state.lastModelsAt = null;
  state.lastModelsError = null;
  publishCatalogChange(state);
  await adoptProfile(state, tokens.accessToken, generation);
  try {
    await refreshModels(state, 'login');
  } catch {
    // The initial refresh failing is a UI error state, not a login failure.
  }
}

/** Start one interactive login; idempotent while a flow is in flight. */
async function startLogin(state) {
  if (state.loginFlow !== null) return;
  state.lastLoginError = null;
  const flow = await createLoginFlow({});
  state.loginFlow = flow;
  openBrowser(flow.authUrl);
  const waiting = typeof flow.wait === 'function' ? flow.wait() : Promise.resolve(flow.wait);
  waiting
    .then(async (tokens) => {
      if (state.loginFlow !== flow) return;
      await writeTokens(tokens);
      state.auth = tokens;
      state.generation += 1;
      await afterLogin(state, tokens, state.generation);
      if (state.loginFlow === flow) state.loginFlow = null;
      publishCatalogChange(state);
    })
    .catch((error) => {
      if (state.loginFlow === flow) state.loginFlow = null;
      if (!(error instanceof PluginError) || error.code !== ERROR_CODES.LOGIN_CANCELLED) {
        state.lastLoginError = safeMessage(error);
      }
      publishCatalogChange(state);
    })
    .finally(() => {
      // The callback listener intentionally keeps serving after a successful
      // claim; release it as soon as the flow has settled one way or another.
      void Promise.resolve(flow.dispose?.()).catch(() => {});
    });
}

/** Cancel a pending browser flow, if any. */
async function cancelLogin(state) {
  const flow = state.loginFlow;
  state.loginFlow = null;
  if (flow === null) return;
  flow.cancel();
  await flow.dispose?.();
}

/** Remove the account completely; registered models disappear with it. */
async function logout(state) {
  await cancelLogin(state);
  state.generation += 1;
  await clearTokens().catch(() => {});
  await clearCatalog().catch(() => {});
  await clearAccount().catch(() => {});
  state.auth = null;
  state.account = DEFAULT_ACCOUNT;
  state.models = [];
  state.catalogSource = null;
  state.lastModelsAt = null;
  state.lastModelsError = null;
  state.lastLoginError = null;
  publishCatalogChange(state);
}

/** Load the module lazily so a profile without it still reports something. */
let proxyModulePromise;
function loadProxyModule() {
  proxyModulePromise ??= import('@deepseek-ai/dsh-http-proxy').catch(() => undefined);
  return proxyModulePromise;
}

/** Describe the route DSH's own fetch dispatcher will take for one URL. */
async function describeRoute(url) {
  const module = await loadProxyModule();
  if (module !== undefined && typeof module.proxyRouteFor === 'function') {
    try {
      const route = module.proxyRouteFor(new URL(url));
      if (route !== undefined && isPlainObject(route)) {
        if (route.proxied === true) {
          return { direct: false, proxy: redactUrl(String(route.proxy)) };
        }
        if (route.proxied === false) return { direct: true, proxy: null };
      }
    } catch {
      // Fall through to the environment-derived report below.
    }
  }
  const fromEnvironment =
    process.env.https_proxy ??
    process.env.HTTPS_PROXY ??
    process.env.all_proxy ??
    process.env.ALL_PROXY ??
    process.env.http_proxy ??
    process.env.HTTP_PROXY;
  const trimmed = typeof fromEnvironment === 'string' ? fromEnvironment.trim() : '';
  if (trimmed === '') return { direct: true, proxy: null };
  return { direct: false, proxy: redactUrl(trimmed) };
}

/**
 * Report the proxy policy for the endpoints this plugin calls server-side.
 * When the routes disagree, both are shown rather than hiding one.
 */
async function proxyStatus() {
  const routes = await Promise.all(PROXY_TARGETS.map(async ([label, url]) => ({ label, ...(await describeRoute(url)) })));
  const proxied = routes.filter((route) => route.direct === false);
  const direct = routes.filter((route) => route.direct !== false);
  const target = routes.map((route) => route.label).join(', ');
  if (proxied.length === 0) {
    return { direct: true, proxy: null, target, detectedBy: 'dsh-http-proxy' };
  }
  const proxies = [...new Set(proxied.map((route) => route.proxy))];
  if (direct.length === 0 && proxies.length === 1) {
    return { direct: false, proxy: proxies[0], target, detectedBy: 'dsh-http-proxy' };
  }
  return {
    direct: false,
    proxy: proxies.join(' ; '),
    target,
    detectedBy: 'dsh-http-proxy',
    mixed: true,
  };
}

/**
 * Display-only projection of one registered model for the settings list:
 * identity plus the capabilities the UI shows. No credentials or route data.
 */
function modelDisplay(model) {
  const reasoning = model !== null && typeof model === 'object' ? model.reasoning : undefined;
  return {
    id: typeof model?.id === 'string' ? model.id : '',
    name: typeof model?.name === 'string' ? model.name : '',
    contextWindow: Number.isFinite(model?.contextWindow) ? model.contextWindow : 0,
    maxTokens: Number.isFinite(model?.maxTokens) ? model.maxTokens : 0,
    input: Array.isArray(model?.input) ? [...model.input] : [],
    efforts:
      reasoning !== null && typeof reasoning === 'object' && Array.isArray(reasoning.efforts)
        ? [...reasoning.efforts]
        : [],
  };
}

/**
 * The settings page's whole state: no secret material, and the model list is a
 * display-only projection of the registered catalog.
 */
async function buildStatus(state) {
  await ensureInitialized(state);
  const loggedIn = state.auth !== null;
  const login =
    state.loginFlow === null
      ? { state: 'idle' }
      : { state: 'pending', authUrl: state.loginFlow.authUrl };
  return {
    ok: true,
    status: {
      loggedIn,
      account: state.account === undefined ? null : { email: state.account.email, plan: state.account.plan },
      expiresAt: state.auth?.expiresAt ?? null,
      refreshExpiresAt: state.auth?.refreshTokenExpiresAt ?? null,
      login,
      models: {
        count: state.models.length,
        items: state.models.map(modelDisplay),
        lastRefreshedAt: state.lastModelsAt,
        lastSource: state.catalogSource,
        error: state.lastModelsError,
        refreshing: state.refreshPromise !== null,
      },
      proxy: await proxyStatus(),
      lastError: state.lastLoginError,
    },
  };
}

/** Run one settings action. */
async function runAction(state, action) {
  switch (action) {
    case 'status':
      return buildStatus(state);
    case 'login':
      await startLogin(state);
      return buildStatus(state);
    case 'cancel-login':
      await cancelLogin(state);
      return buildStatus(state);
    case 'logout':
      await logout(state);
      return buildStatus(state);
    case 'refresh-models': {
      if (state.auth === null) {
        return {
          ok: false,
          error: {
            code: ERROR_CODES.NOT_LOGGED_IN,
            message: 'Sign in to a Claude account before refreshing models.',
          },
        };
      }
      try {
        await refreshModels(state, 'manual');
      } catch (error) {
        return {
          ok: false,
          error: {
            code: error instanceof PluginError ? error.code : ERROR_CODES.MODELS_FETCH_FAILED,
            message: safeMessage(error),
          },
        };
      }
      return buildStatus(state);
    }
    default:
      throw new PluginError(ERROR_CODES.UNSUPPORTED_ACTION, `Unsupported action "${action}".`);
  }
}

/**
 * The authenticated settings route. The `/api` bridge has already applied
 * DSH's Host/Origin trust fence and owner-browser authentication before this
 * handler runs; the handler adds method, content-type, and size checks.
 */
function createApiHandler(state) {
  return async function handleSettingsRequest(request) {
    if (request.method !== 'POST') {
      return failureResponse(new PluginError(ERROR_CODES.INVALID_REQUEST, 'POST is required.'), 405);
    }
    const contentType = (request.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
    if (contentType !== 'application/json') {
      return failureResponse(new PluginError(ERROR_CODES.INVALID_REQUEST, 'Content-Type must be application/json.'), 415);
    }
    const declaredLength = request.headers.get('content-length');
    if (declaredLength !== null && Number(declaredLength) > API_MAX_BODY_BYTES) {
      return failureResponse(new PluginError(ERROR_CODES.BODY_TOO_LARGE, 'Request body is too large.'), 413);
    }
    let text;
    try {
      text = await request.text();
    } catch {
      return failureResponse(new PluginError(ERROR_CODES.INVALID_REQUEST, 'Request body could not be read.'), 400);
    }
    if (Buffer.byteLength(text) > API_MAX_BODY_BYTES) {
      return failureResponse(new PluginError(ERROR_CODES.BODY_TOO_LARGE, 'Request body is too large.'), 413);
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      return failureResponse(new PluginError(ERROR_CODES.INVALID_REQUEST, 'Request body is not JSON.'), 400);
    }
    if (!isPlainObject(body) || typeof body.action !== 'string') {
      return failureResponse(new PluginError(ERROR_CODES.INVALID_REQUEST, 'A string action is required.'), 400);
    }
    try {
      await ensureInitialized(state);
      return jsonResponse(await runAction(state, body.action));
    } catch (error) {
      const status =
        error instanceof PluginError &&
        (error.code === ERROR_CODES.INVALID_REQUEST || error.code === ERROR_CODES.UNSUPPORTED_ACTION)
          ? 400
          : 500;
      return failureResponse(error, status);
    }
  };
}

/** Mount the plugin on one Host context. */
export function apply(ctx) {
  const state = createPluginState(ctx);
  const adapter = createClaudeAdapter({
    getModels: () => (state.auth === null ? [] : state.models),
    getAccessToken: () => ensureAccessToken(),
    forceRefreshAccessToken: () => forceRefreshAccessToken(),
    getAttachments: () => ctx.get('attachments'),
  });
  state.adapterHandle = ctx.llm.registerAdapter([PROVIDER_ID], adapter);
  void ensureInitialized(state)
    .then(() => {
      // The model directory may have read this route while the private files
      // were still loading; republish once the signed-in catalog is known.
      publishCatalogChange(state);
    })
    .catch(() => {});

  // Optional service: the settings route exists only in browser-facing
  // compositions. `ctx.inject` runs the callback now when the service is
  // already mounted and later when it appears, and never throws when a
  // headless composition has no connection at all.
  ctx.inject(['connection'], (connectionContext) => {
    connectionContext.effect(
      () =>
        connectionContext.connection.fetch.register({
          path: API_ROUTE_PATH,
          methods: ['POST'],
          requestBody: 'buffered',
          fetch: createApiHandler(state),
        }),
      'claude-oauth: settings route',
    );
  });

  ctx.effect(() => () => {
    state.loginFlow?.cancel();
    state.loginFlow = null;
    state.refreshPromise = null;
  }, 'claude-oauth: login disposal');
}

/** Internal seams used only by the offline test suite. */
export const __test = {
  createPluginState,
  createApiHandler,
  buildStatus,
  runAction,
  defaultCatalog,
  proxyStatus,
  modelFromCapability,
  PROVIDER_NAME,
};
