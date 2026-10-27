/**
 * Offline suite for `lib/catalog.js`.
 *
 * Everything here runs with a mocked `fetchImpl` (no network) and, for the
 * persistence tests, a throwaway `DSH_HOME` under the OS temp directory. The
 * real environment variable is saved and restored around every test.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  capabilityFor,
  clearAccount,
  clearCatalog,
  fetchAccountProfile,
  loadCachedAccount,
  loadCachedCatalog,
  normalizeCatalogEntries,
  refreshCatalog,
  saveAccount,
  saveCatalog,
} from '../lib/catalog.js';
import {
  ADAPTIVE_EFFORTS,
  ANTHROPIC_VERSION,
  CC_USER_AGENT,
  DEFAULT_EFFORT,
  ERROR_CODES,
  INFERENCE_BETAS,
  MODELS_LIST_URL,
  PROFILE_URL,
} from '../lib/constants.js';
import { isPluginError, PluginError } from '../lib/errors.js';

/** A token-shaped sentinel used to prove it never leaks into errors/logs. */
const TOKEN = 'test-access-token-never-leaks';

const ORIGINAL_DSH_HOME = process.env.DSH_HOME;
let home;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-claude-oauth-catalog-'));
  process.env.DSH_HOME = home;
});

afterEach(async () => {
  if (ORIGINAL_DSH_HOME === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = ORIGINAL_DSH_HOME;
  await rm(home, { recursive: true, force: true });
});

/** A fetch-like response with a JSON body. */
function responseOf(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return payload;
    },
    async text() {
      return JSON.stringify(payload);
    },
  };
}

/** A non-2xx fetch-like response whose body must never be surfaced. */
function failureResponse(status, body) {
  return {
    ok: false,
    status,
    async json() {
      return { error: body };
    },
    async text() {
      return body;
    },
  };
}

/** A recording fetch stub; `handler` may be a response or a function. */
function mockFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return typeof handler === 'function' ? handler(url, init) : handler;
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** A fetch stub that never resolves until its abort signal fires. */
function abortAwareFetch() {
  return async (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    });
}

function assertAuthHeaders(headers, token = TOKEN) {
  assert.equal(headers.authorization, `Bearer ${token}`);
  assert.equal(headers['anthropic-version'], ANTHROPIC_VERSION);
  assert.equal(headers['anthropic-beta'], INFERENCE_BETAS);
  assert.equal(headers['user-agent'], CC_USER_AGENT);
  assert.equal(headers['x-app'], 'cli');
  assert.equal(headers.accept, 'application/json');
}

function dataDir() {
  return join(home, 'claude-oauth');
}

function modelsPath() {
  return join(dataDir(), 'models.json');
}

function accountPath() {
  return join(dataDir(), 'account.json');
}

async function fileMode(path) {
  return (await stat(path)).mode & 0o777;
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe('capabilityFor', () => {
  it('returns the versioned capability entry for a known id', () => {
    const capability = capabilityFor('claude-sonnet-5');
    assert.ok(capability);
    assert.equal(capability.name, 'Claude Sonnet 5');
    assert.equal(capability.adaptive, true);
  });

  it('returns undefined for unknown and non-string ids', () => {
    assert.equal(capabilityFor('claude-mystery-9'), undefined);
    assert.equal(capabilityFor(''), undefined);
    assert.equal(capabilityFor(undefined), undefined);
    assert.equal(capabilityFor(42), undefined);
    assert.equal(capabilityFor('toString'), undefined);
  });
});

describe('normalizeCatalogEntries', () => {
  it('maps a full listing and lets listing metadata override capabilities', () => {
    const models = normalizeCatalogEntries({
      data: [
        {
          type: 'model',
          id: 'claude-sonnet-5',
          display_name: 'Claude Sonnet 5 (listing)',
          max_input_tokens: 500_000,
          max_tokens: 100_000,
          created_at: '2026-01-01T00:00:00Z',
        },
        { type: 'model', id: 'claude-opus-4-6' },
        { type: 'model', id: 'claude-haiku-4-5', display_name: '  Claude Haiku 4.5 Renamed  ' },
      ],
    });

    assert.equal(models.length, 3);

    assert.deepEqual(models[0], {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5 (listing)',
      contextWindow: 500_000,
      maxTokens: 100_000,
      input: ['text', 'image'],
      reasoning: { efforts: [...ADAPTIVE_EFFORTS], defaultEffort: DEFAULT_EFFORT },
    });
    // The adapter maps these ids to display objects itself, so they are strings.
    assert.deepEqual(models[0].reasoning.efforts, ['low', 'medium', 'high', 'max']);
    assert.ok(models[0].reasoning.efforts.every((effort) => typeof effort === 'string'));

    // Known adaptive model with no listing overrides: capability values win.
    assert.deepEqual(models[1], {
      id: 'claude-opus-4-6',
      name: 'Claude Opus 4.6',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: { efforts: [...ADAPTIVE_EFFORTS], defaultEffort: DEFAULT_EFFORT },
    });

    // Known non-adaptive model: display name override, no reasoning surface.
    assert.deepEqual(models[2], {
      id: 'claude-haiku-4-5',
      name: 'Claude Haiku 4.5 Renamed',
      contextWindow: 200_000,
      maxTokens: 64_000,
      input: ['text', 'image'],
    });
    assert.equal('reasoning' in models[2], false);
  });

  it('registers an unknown model from listing metadata with no reasoning', () => {
    const [model] = normalizeCatalogEntries({
      data: [
        {
          type: 'model',
          id: 'claude-mystery-7',
          display_name: 'Mystery 7',
          max_input_tokens: 300_000,
          max_tokens: 48_000,
        },
      ],
    });

    assert.deepEqual(model, {
      id: 'claude-mystery-7',
      name: 'Mystery 7',
      contextWindow: 300_000,
      maxTokens: 48_000,
      input: ['text', 'image'],
    });
    assert.equal('reasoning' in model, false);
  });

  it('falls back to conservative metadata for a bare unknown model', () => {
    const [model] = normalizeCatalogEntries([{ id: 'claude-mystery-8' }]);

    assert.deepEqual(model, {
      id: 'claude-mystery-8',
      name: 'claude-mystery-8',
      contextWindow: 200_000,
      maxTokens: 32_000,
      input: ['text', 'image'],
    });
  });

  it('ignores non-positive and non-numeric listing metadata', () => {
    const [known] = normalizeCatalogEntries([
      { type: 'model', id: 'claude-sonnet-5', max_input_tokens: 0, max_tokens: -1 },
    ]);
    assert.equal(known.contextWindow, 1_000_000);
    assert.equal(known.maxTokens, 128_000);

    const [unknown] = normalizeCatalogEntries([
      { type: 'model', id: 'claude-mystery-9', max_input_tokens: '999999', max_tokens: '777' },
    ]);
    assert.equal(unknown.contextWindow, 200_000);
    assert.equal(unknown.maxTokens, 32_000);
  });

  it('accepts the enriched models map payload', () => {
    const models = normalizeCatalogEntries({
      models: {
        'claude-sonnet-5': { display_name: 'Sonnet Map', max_input_tokens: 777_000 },
        'gpt-5': { display_name: 'Not Claude' },
        'claude-opus-5': { max_tokens: 96_000 },
      },
    });

    assert.deepEqual(
      models.map((model) => model.id),
      ['claude-sonnet-5', 'claude-opus-5'],
    );
    assert.equal(models[0].name, 'Sonnet Map');
    assert.equal(models[0].contextWindow, 777_000);
    assert.equal(models[1].name, 'Claude Opus 5');
    assert.equal(models[1].maxTokens, 96_000);
  });

  it('keeps only claude models, dedupes by id, and preserves response order', () => {
    const models = normalizeCatalogEntries({
      data: [
        { type: 'model', id: 'claude-opus-5', display_name: 'First Opus' },
        { type: 'embedding', id: 'claude-embed-1' },
        { type: 'model', id: 'gpt-5' },
        { type: 'model', id: 'claude-opus-5', display_name: 'Second Opus' },
        { type: 'model' },
        null,
        { type: 'model', id: '  claude-sonnet-5  ' },
      ],
    });

    assert.deepEqual(
      models.map((model) => model.id),
      ['claude-opus-5', 'claude-sonnet-5'],
    );
    assert.equal(models[0].name, 'First Opus');
  });

  it('returns an empty list for garbage payloads', () => {
    for (const payload of [undefined, null, {}, 'nope', 42, { data: 'nope' }, { models: 7 }]) {
      assert.deepEqual(normalizeCatalogEntries(payload), []);
    }
  });
});

describe('refreshCatalog', () => {
  it('requests /v1/models with Claude Code OAuth headers and maps the payload', async () => {
    const fetchImpl = mockFetch(
      responseOf({
        data: [
          {
            type: 'model',
            id: 'claude-sonnet-5',
            display_name: 'Sonnet',
            max_input_tokens: 444_000,
            max_tokens: 55_000,
          },
        ],
      }),
    );

    const result = await refreshCatalog({
      accessToken: TOKEN,
      fetchImpl,
      now: () => 1_700_000_000_000,
    });

    assert.equal(fetchImpl.calls.length, 1);
    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url, MODELS_LIST_URL);
    assert.equal(init.method, 'GET');
    assertAuthHeaders(init.headers);
    assert.ok(init.signal instanceof AbortSignal);

    assert.deepEqual(result, {
      fetchedAt: 1_700_000_000_000,
      models: [
        {
          id: 'claude-sonnet-5',
          name: 'Sonnet',
          contextWindow: 444_000,
          maxTokens: 55_000,
          input: ['text', 'image'],
          reasoning: { efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' },
        },
      ],
    });
  });

  it('accepts the enriched models map through the request path', async () => {
    const fetchImpl = mockFetch(
      responseOf({ models: { 'claude-opus-5': { display_name: 'Opus Map' } } }),
    );
    const result = await refreshCatalog({ accessToken: TOKEN, fetchImpl });

    assert.equal(result.models.length, 1);
    assert.equal(result.models[0].id, 'claude-opus-5');
    assert.equal(result.models[0].name, 'Opus Map');
    assert.equal(typeof result.fetchedAt, 'number');
  });

  it('parses a response that only exposes text()', async () => {
    const fetchImpl = mockFetch({
      ok: true,
      status: 200,
      async text() {
        return JSON.stringify({ data: [{ type: 'model', id: 'claude-opus-5' }] });
      },
    });
    const result = await refreshCatalog({ accessToken: TOKEN, fetchImpl });
    assert.equal(result.models[0].id, 'claude-opus-5');
  });

  it('accepts a well-formed empty model list', async () => {
    const fetchImpl = mockFetch(responseOf({ data: [] }));
    const result = await refreshCatalog({ accessToken: TOKEN, fetchImpl });
    assert.deepEqual(result.models, []);
    assert.ok(Number.isFinite(result.fetchedAt));
  });

  it('falls back to the wall clock when now() is unusable', async () => {
    const fetchImpl = mockFetch(responseOf({ data: [] }));
    const result = await refreshCatalog({
      accessToken: TOKEN,
      fetchImpl,
      now: () => Number.NaN,
    });
    assert.ok(Number.isFinite(result.fetchedAt));
  });

  it('maps HTTP failures to MODELS_FETCH_FAILED without leaking the body', async () => {
    for (const status of [400, 401, 403, 429, 500, 503]) {
      const body = `token=${TOKEN} upstream-detail-must-not-leak`;
      const fetchImpl = mockFetch(failureResponse(status, body));

      await assert.rejects(refreshCatalog({ accessToken: TOKEN, fetchImpl }), (error) => {
        assert.ok(error instanceof PluginError);
        assert.equal(error.code, ERROR_CODES.MODELS_FETCH_FAILED);
        assert.match(error.message, new RegExp(`HTTP ${status}`));
        assert.ok(!error.message.includes(TOKEN));
        assert.ok(!error.message.includes('upstream-detail-must-not-leak'));
        assert.deepEqual(error.details, { status });
        return true;
      });
    }
  });

  it('maps network failures to MODELS_FETCH_FAILED without leaking the cause', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error(`socket hang up token=${TOKEN}`);
    });

    await assert.rejects(refreshCatalog({ accessToken: TOKEN, fetchImpl }), (error) => {
      assert.ok(isPluginError(error, ERROR_CODES.MODELS_FETCH_FAILED));
      assert.ok(!error.message.includes(TOKEN));
      assert.ok(!error.message.includes('socket hang up'));
      return true;
    });
  });

  it('maps invalid JSON to MODELS_FETCH_FAILED', async () => {
    const fetchImpl = mockFetch({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError(`Unexpected token < in JSON near token=${TOKEN}`);
      },
      async text() {
        return `<html>token=${TOKEN}</html>`;
      },
    });

    await assert.rejects(refreshCatalog({ accessToken: TOKEN, fetchImpl }), (error) => {
      assert.ok(isPluginError(error, ERROR_CODES.MODELS_FETCH_FAILED));
      assert.match(error.message, /not valid JSON/i);
      assert.ok(!error.message.includes(TOKEN));
      return true;
    });
  });

  it('maps a malformed payload to MODELS_FETCH_FAILED', async () => {
    for (const payload of [null, 'nope', 42, {}, { data: 'nope' }, { models: 'nope' }]) {
      const fetchImpl = mockFetch(responseOf(payload));
      await assert.rejects(
        refreshCatalog({ accessToken: TOKEN, fetchImpl }),
        (error) => isPluginError(error, ERROR_CODES.MODELS_FETCH_FAILED),
      );
    }
  });

  it('aborts the request when timeoutMs elapses', async () => {
    await assert.rejects(
      refreshCatalog({ accessToken: TOKEN, fetchImpl: abortAwareFetch(), timeoutMs: 25 }),
      (error) => {
        assert.ok(isPluginError(error, ERROR_CODES.MODELS_FETCH_FAILED));
        assert.ok(!error.message.includes(TOKEN));
        return true;
      },
    );
  });
});

describe('catalog persistence', () => {
  it('round-trips the catalog with a versioned envelope and 0600 mode', async () => {
    const models = normalizeCatalogEntries({
      data: [
        { type: 'model', id: 'claude-sonnet-5', display_name: 'Sonnet' },
        { type: 'model', id: 'claude-mystery-7', max_input_tokens: 300_000, max_tokens: 48_000 },
      ],
    });
    const fetchedAt = 1_700_000_000_000;

    await saveCatalog({ models, fetchedAt });

    const raw = JSON.parse(await readFile(modelsPath(), 'utf8'));
    assert.equal(raw.version, 1);
    assert.equal(raw.fetchedAt, fetchedAt);
    assert.deepEqual(raw.models, models);
    assert.equal(await fileMode(modelsPath()), 0o600);

    assert.deepEqual(await loadCachedCatalog(), { models, fetchedAt });
  });

  it('returns undefined for a missing catalog cache', async () => {
    assert.equal(await loadCachedCatalog(), undefined);
  });

  it('ignores corrupt, mismatched, and structurally invalid catalog caches', async () => {
    await mkdir(dataDir(), { recursive: true });

    await writeFile(modelsPath(), '{not json');
    assert.equal(await loadCachedCatalog(), undefined);

    await writeFile(modelsPath(), JSON.stringify({ version: 2, fetchedAt: 1, models: [] }));
    assert.equal(await loadCachedCatalog(), undefined);

    await writeFile(modelsPath(), JSON.stringify({ version: 1, fetchedAt: 1, models: 'nope' }));
    assert.equal(await loadCachedCatalog(), undefined);

    await writeFile(modelsPath(), JSON.stringify({ version: 1, fetchedAt: 'yesterday', models: [] }));
    assert.equal(await loadCachedCatalog(), undefined);

    await writeFile(modelsPath(), JSON.stringify([1, 2, 3]));
    assert.equal(await loadCachedCatalog(), undefined);
  });

  it('drops invalid cached model rows and keeps the valid ones', async () => {
    const good = {
      id: 'claude-sonnet-5',
      name: 'Claude Sonnet 5',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
      reasoning: { efforts: ['low', 'medium', 'high', 'max'], defaultEffort: 'high' },
    };
    await mkdir(dataDir(), { recursive: true });
    await writeFile(
      modelsPath(),
      JSON.stringify({
        version: 1,
        fetchedAt: 1234,
        models: [
          good,
          null,
          'claude-opus-5',
          { id: 42, name: 'Bad id', contextWindow: 1, maxTokens: 1 },
          { id: 'gpt-5', name: 'Not Claude', contextWindow: 1, maxTokens: 1 },
          { id: 'claude-opus-5', name: 'No sizes' },
          { id: 'claude-opus-4-6', contextWindow: 1_000_000, maxTokens: 128_000 },
          {
            id: 'claude-opus-5',
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            input: 'text',
            reasoning: 'adaptive',
          },
        ],
      }),
    );

    const loaded = await loadCachedCatalog();
    assert.equal(loaded.fetchedAt, 1234);
    assert.deepEqual(
      loaded.models.map((model) => model.id),
      ['claude-sonnet-5', 'claude-opus-4-6', 'claude-opus-5'],
    );
    assert.deepEqual(loaded.models[0], good);
    // Missing name/input/reasoning fields fall back to safe values, nothing is invented.
    assert.deepEqual(loaded.models[1], {
      id: 'claude-opus-4-6',
      name: 'claude-opus-4-6',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
    });
    assert.deepEqual(loaded.models[2], {
      id: 'claude-opus-5',
      name: 'claude-opus-5',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
    });
    assert.equal('reasoning' in loaded.models[2], false);
  });

  it('clears the catalog cache and tolerates a missing file', async () => {
    await clearCatalog();
    assert.equal(await fileExists(modelsPath()), false);

    await saveCatalog({ models: [], fetchedAt: 1 });
    assert.equal(await fileExists(modelsPath()), true);

    await clearCatalog();
    assert.equal(await fileExists(modelsPath()), false);
    await clearCatalog();
    assert.equal(await fileExists(modelsPath()), false);
  });

  it('round-trips the account profile with 0600 mode', async () => {
    const account = { email: 'person@example.com', plan: 'max' };
    await saveAccount(account);

    const raw = JSON.parse(await readFile(accountPath(), 'utf8'));
    assert.deepEqual(raw, { version: 1, email: 'person@example.com', plan: 'max' });
    assert.equal(await fileMode(accountPath()), 0o600);

    assert.deepEqual(await loadCachedAccount(), account);
  });

  it('trims and caps account fields and ignores non-strings', async () => {
    const longEmail = `${'a'.repeat(250)}@example.com`;
    await saveAccount({ email: `  ${longEmail}  `, plan: 42 });

    const raw = JSON.parse(await readFile(accountPath(), 'utf8'));
    assert.equal(raw.email.length, 200);
    assert.equal(raw.plan, undefined);
    assert.deepEqual(await loadCachedAccount(), { email: longEmail.slice(0, 200) });

    await saveAccount({ email: null, plan: '   ' });
    assert.equal(await loadCachedAccount(), undefined);
  });

  it('ignores corrupt, mismatched, and empty account caches', async () => {
    await mkdir(dataDir(), { recursive: true });

    await writeFile(accountPath(), '{broken');
    assert.equal(await loadCachedAccount(), undefined);

    await writeFile(accountPath(), JSON.stringify({ version: 9, email: 'x@example.com' }));
    assert.equal(await loadCachedAccount(), undefined);

    await writeFile(accountPath(), JSON.stringify({ version: 1 }));
    assert.equal(await loadCachedAccount(), undefined);

    await writeFile(accountPath(), JSON.stringify({ version: 1, email: 12, plan: false }));
    assert.equal(await loadCachedAccount(), undefined);

    await writeFile(
      accountPath(),
      JSON.stringify({ version: 1, email: 'kept@example.com', plan: 'pro' }),
    );
    assert.deepEqual(await loadCachedAccount(), { email: 'kept@example.com', plan: 'pro' });
  });

  it('clears the account cache and tolerates a missing file', async () => {
    await clearAccount();
    await saveAccount({ plan: 'pro' });
    assert.equal(await fileExists(accountPath()), true);
    await clearAccount();
    assert.equal(await fileExists(accountPath()), false);
    await clearAccount();
    assert.equal(await fileExists(accountPath()), false);
  });

  it('never logs the account e-mail address', async () => {
    const methods = ['log', 'info', 'warn', 'error', 'debug'];
    const original = methods.map((name) => [name, console[name]]);
    const captured = [];
    for (const name of methods) {
      console[name] = (...args) => captured.push(args.map(String).join(' '));
    }
    try {
      const fetchImpl = mockFetch(
        responseOf({ account: { email: 'pii@example.com', subscription_type: 'pro' } }),
      );
      const profile = await fetchAccountProfile({ accessToken: TOKEN, fetchImpl });
      await saveAccount(profile);
      assert.deepEqual(await loadCachedAccount(), profile);
    } finally {
      for (const [name, method] of original) console[name] = method;
    }
    assert.deepEqual(captured, []);
  });
});

describe('fetchAccountProfile', () => {
  it('requests the profile with the same auth headers and parses a nested account', async () => {
    const fetchImpl = mockFetch(
      responseOf({ account: { email: '  person@example.com  ', subscription_type: 'max' } }),
    );
    const profile = await fetchAccountProfile({ accessToken: TOKEN, fetchImpl });

    assert.deepEqual(profile, { email: 'person@example.com', plan: 'max' });
    assert.equal(fetchImpl.calls.length, 1);
    const [{ url, init }] = fetchImpl.calls;
    assert.equal(url, PROFILE_URL);
    assert.equal(init.method, 'GET');
    assertAuthHeaders(init.headers);
    assert.ok(init.signal instanceof AbortSignal);
  });

  it('parses the documented response shapes', async () => {
    const cases = [
      [
        { email: 'tops@example.com', subscriptionType: 'pro' },
        { email: 'tops@example.com', plan: 'pro' },
      ],
      [
        { account_email: 'snake@example.com', subscription_type: 'team' },
        { email: 'snake@example.com', plan: 'team' },
      ],
      [{ organization: { subscription_type: 'enterprise' } }, { plan: 'enterprise' }],
      [{ account: { email: 'nested@example.com' } }, { email: 'nested@example.com' }],
      [{ account: { subscription_type: 'max' } }, { plan: 'max' }],
    ];

    for (const [payload, expected] of cases) {
      const fetchImpl = mockFetch(responseOf(payload));
      assert.deepEqual(await fetchAccountProfile({ accessToken: TOKEN, fetchImpl }), expected);
    }
  });

  it('returns undefined on non-2xx responses', async () => {
    for (const status of [401, 403, 429, 500, 503]) {
      const fetchImpl = mockFetch(failureResponse(status, `token=${TOKEN}`));
      assert.equal(await fetchAccountProfile({ accessToken: TOKEN, fetchImpl }), undefined);
    }
  });

  it('returns undefined when fetch throws', async () => {
    const fetchImpl = mockFetch(() => {
      throw new Error(`network down token=${TOKEN}`);
    });
    assert.equal(await fetchAccountProfile({ accessToken: TOKEN, fetchImpl }), undefined);
  });

  it('returns undefined when the request times out', async () => {
    assert.equal(
      await fetchAccountProfile({
        accessToken: TOKEN,
        fetchImpl: abortAwareFetch(),
        timeoutMs: 25,
      }),
      undefined,
    );
  });

  it('returns undefined for malformed bodies and unusable field values', async () => {
    const invalidJson = mockFetch({
      ok: true,
      status: 200,
      async json() {
        throw new SyntaxError('Unexpected token <');
      },
      async text() {
        return '<html>';
      },
    });
    assert.equal(await fetchAccountProfile({ accessToken: TOKEN, fetchImpl: invalidJson }), undefined);

    for (const payload of [null, 'string', 42, [], { account: 'nope' }, { email: 42, plan: false }]) {
      const fetchImpl = mockFetch(responseOf(payload));
      assert.equal(await fetchAccountProfile({ accessToken: TOKEN, fetchImpl }), undefined);
    }
  });

  it('trims and caps profile values', async () => {
    const long = 'p'.repeat(500);
    const fetchImpl = mockFetch(
      responseOf({ email: `  ${long}  `, subscriptionType: `  ${long}  ` }),
    );
    const profile = await fetchAccountProfile({ accessToken: TOKEN, fetchImpl });

    assert.equal(profile.email.length, 200);
    assert.equal(profile.plan.length, 200);
  });
});
