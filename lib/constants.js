/**
 * Every fixed fact the plugin needs: Claude's first-party OAuth client
 * identity, the token/models/profile endpoints, the Claude Code fingerprint
 * constants this plugin reproduces, the private data-file names, and the
 * versioned model-capability table used to describe `/v1/models` entries.
 *
 * No value here is a secret. The OAuth client id is Claude Code's public
 * client id, exactly as the lisp extension and pi-ai use it.
 */

/** Bundle/plugin display identity. */
export const PACKAGE_NAME = 'dsh-claude-oauth';
export const PROVIDER_ID = 'claude-oauth';
export const PROVIDER_NAME = 'Claude';
export const SETTINGS_SECTION_ID = 'claude-oauth';
export const SETTINGS_SECTION_ORDER = 12;

/** The authenticated browser-only Host route the settings UI calls. */
export const API_ROUTE_PATH = '/api/claude-oauth';
export const API_MAX_BODY_BYTES = 8192;

/** Claude Code's public first-party OAuth client id. */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** OAuth endpoints (the pair current Claude Code releases use). */
export const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
export const API_BASE_URL = 'https://api.anthropic.com';
export const MESSAGES_PATH = '/v1/messages';
export const MODELS_LIST_URL = 'https://api.anthropic.com/v1/models?limit=1000';
export const PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

/** Login asks for the console scope; refresh re-asks the inference set only. */
export const LOGIN_SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';
export const REFRESH_SCOPES =
  'user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload';

/** Callback server: any loopback port is accepted; 53692 is Claude Code's. */
export const CALLBACK_PATH = '/callback';
export const CALLBACK_HOST = '127.0.0.1';
export const CALLBACK_HOST_V6 = '::1';
export const CALLBACK_REDIRECT_HOST = 'localhost';
export const CALLBACK_PREFERRED_PORT = 53692;
export const LOGIN_TIMEOUT_MS = 120_000;
export const TOKEN_REQUEST_TIMEOUT_MS = 30_000;
export const MODELS_REQUEST_TIMEOUT_MS = 20_000;
export const PROFILE_REQUEST_TIMEOUT_MS = 10_000;

/** Refresh when fewer than six minutes remain, like the lisp extension. */
export const REFRESH_BEFORE_EXPIRY_SECONDS = 360;
/** Default refresh-token lifetime when the endpoint omits the field: 30 days. */
export const DEFAULT_REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Claude Code fingerprint this plugin reproduces. */
export const CC_VERSION = '2.1.284';
export const CC_ENTRYPOINT = 'sdk-cli';
export const CC_BILLING_SALT = '59cf53e54c78';
export const CC_BILLING_POSITIONS = Object.freeze([4, 7, 20]);
export const ANTHROPIC_VERSION = '2023-06-01';
export const OAUTH_BETA = 'oauth-2025-04-20';
export const CLAUDE_CODE_BETA = 'claude-code-20250219';
export const INFERENCE_BETAS = `${OAUTH_BETA},${CLAUDE_CODE_BETA}`;
/** `claude-cli/<version> (external, sdk-cli)`, as the lisp extension sends. */
export const CC_USER_AGENT = `claude-cli/${CC_VERSION} (external, ${CC_ENTRYPOINT})`;

/** Private storage under `$DSH_HOME/claude-oauth`. */
export const TOKEN_FILE_NAME = 'token.json';
export const TOKEN_LOCK_NAME = 'token.lock';
export const ACCOUNT_FILE_NAME = 'account.json';
export const MODELS_FILE_NAME = 'models.json';

/** Streaming limits. */
export const MAX_OUTPUT_TOKENS = 128_000;
export const DEFAULT_OUTPUT_TOKENS = 32_000;
export const REQUEST_IMAGE_MAX_PIXELS = 4_194_304;
export const REQUEST_IMAGE_MAX_BYTES = 4_718_592;

/**
 * Reasoning effort ladder advertised for adaptive-thinking Claude models.
 * Claude Code's `max` level is available on every adaptive-thinking model;
 * the native `xhigh` level is model-specific, so it is not advertised.
 */
export const ADAPTIVE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'max']);
export const DEFAULT_EFFORT = 'high';

/**
 * Versioned capability table for Claude chat models. Values come from the
 * Anthropic model catalog shipped with this Harness release; a model missing
 * from this table is still registrable after `/v1/models`, but gets only the
 * metadata the listing reports (and no reasoning metadata).
 *
 * `adaptive: true` means the model uses `thinking: { type: 'adaptive' }` with
 * an `output_config.effort`; `adaptive: false` means the model has no
 * reasoning surface in this plugin (a budget-thinking model is deliberately
 * left without a reasoning menu rather than mis-encoded).
 */
export const MODEL_CAPABILITIES = Object.freeze({
  'claude-fable-5': { name: 'Claude Fable 5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-fable-5-1': { name: 'Claude Fable 5.1', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-haiku-4-5': { name: 'Claude Haiku 4.5 (latest)', contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'], adaptive: false },
  'claude-haiku-4-5-20251001': { name: 'Claude Haiku 4.5', contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'], adaptive: false },
  'claude-haiku-5-5': { name: 'Claude Haiku 5.5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-opus-4-5': { name: 'Claude Opus 4.5 (latest)', contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'], adaptive: false },
  'claude-opus-4-5-20251101': { name: 'Claude Opus 4.5', contextWindow: 200_000, maxTokens: 64_000, input: ['text', 'image'], adaptive: false },
  'claude-opus-4-6': { name: 'Claude Opus 4.6', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-opus-4-7': { name: 'Claude Opus 4.7', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-opus-4-8': { name: 'Claude Opus 4.8', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-opus-5': { name: 'Claude Opus 5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-opus-5-5': { name: 'Claude Opus 5.5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-sonnet-4-5': { name: 'Claude Sonnet 4.5 (latest)', contextWindow: 1_000_000, maxTokens: 64_000, input: ['text', 'image'], adaptive: false },
  'claude-sonnet-4-5-20250929': { name: 'Claude Sonnet 4.5', contextWindow: 1_000_000, maxTokens: 64_000, input: ['text', 'image'], adaptive: false },
  'claude-sonnet-4-6': { name: 'Claude Sonnet 4.6', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-sonnet-5': { name: 'Claude Sonnet 5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
  'claude-sonnet-5-5': { name: 'Claude Sonnet 5.5', contextWindow: 1_000_000, maxTokens: 128_000, input: ['text', 'image'], adaptive: true },
});

/**
 * Catalog used before the first successful `/v1/models` refresh: the models
 * the lisp extension registered statically (1M context, 128K output,
 * adaptive thinking, vision).
 */
export const DEFAULT_CATALOG_IDS = Object.freeze([
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-opus-5',
  'claude-fable-5',
  'claude-fable-5-1',
  'claude-opus-5-5',
]);

/** First system block every Claude Code OAuth request carries. */
export const CLAUDE_CODE_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

/** Failure codes the settings UI and the adapter agree on. */
export const ERROR_CODES = Object.freeze({
  NOT_LOGGED_IN: 'NOT_LOGGED_IN',
  TOKEN_EXPIRED: 'TOKEN_EXPIRED',
  REFRESH_TOKEN_EXPIRED: 'REFRESH_TOKEN_EXPIRED',
  REFRESH_FAILED: 'REFRESH_FAILED',
  LOGIN_IN_PROGRESS: 'LOGIN_IN_PROGRESS',
  LOGIN_CANCELLED: 'LOGIN_CANCELLED',
  LOGIN_TIMEOUT: 'LOGIN_TIMEOUT',
  LOGIN_FAILED: 'LOGIN_FAILED',
  MODELS_FETCH_FAILED: 'MODELS_FETCH_FAILED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNSUPPORTED_ACTION: 'UNSUPPORTED_ACTION',
  BODY_TOO_LARGE: 'BODY_TOO_LARGE',
});
