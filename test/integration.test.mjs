/**
 * Offline integration tests for the Host half: settings-route protocol,
 * status shaping, the static fallback catalog, and adapter registration.
 * All private state is redirected to a temp DSH_HOME; nothing here talks to
 * the network or to the real ~/.dsh.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = await mkdtemp(join(tmpdir(), 'dsh-claude-oauth-host-'));
const previousHome = process.env.DSH_HOME;
process.env.DSH_HOME = home;

const { __test } = await import('../lib/index.js');
const { writeJsonFile } = await import('../lib/files.js');
const { DEFAULT_CATALOG_IDS, ERROR_CODES } = await import('../lib/constants.js');

const dataDir = join(home, 'claude-oauth');

/** One plugin context stand-in that records adapter registrations. */
function fakeContext() {
  const adapters = [];
  return {
    adapters,
    get: () => undefined,
    inject: () => {},
    effect: () => {},
    llm: {
      registerAdapter(providers, adapter) {
        adapters.push({ providers, adapter });
        return { replace() {} };
      },
    },
  };
}

/** One settings request against the handler. */
function request(body, { method = 'POST', contentType = 'application/json' } = {}) {
  return new Request('http://dsh.internal/api/claude-oauth', {
    method,
    headers: contentType === undefined ? {} : { 'content-type': contentType },
    ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}),
  });
}

test.after(async () => {
  if (previousHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previousHome;
  await rm(home, { recursive: true, force: true });
});

test('the fallback catalog is the lisp extension set with adaptive reasoning', () => {
  const models = __test.defaultCatalog();
  assert.deepEqual(
    models.map((model) => model.id),
    [...DEFAULT_CATALOG_IDS],
  );
  for (const model of models) {
    assert.equal(model.contextWindow, 1_000_000);
    assert.equal(model.maxTokens, 128_000);
    assert.deepEqual(model.input, ['text', 'image']);
    assert.deepEqual(model.reasoning.efforts, ['low', 'medium', 'high', 'max']);
    assert.equal(model.reasoning.defaultEffort, 'high');
  }
});

test('apply registers exactly one claude-oauth adapter and requests the connection service', async () => {
  const ctx = fakeContext();
  const requested = [];
  ctx.inject = (dependencies) => requested.push(dependencies);
  const { apply } = await import('../lib/index.js');
  apply(ctx);
  assert.equal(ctx.adapters.length, 1);
  assert.deepEqual(ctx.adapters[0].providers, ['claude-oauth']);
  assert.equal(ctx.adapters[0].adapter.providerInfo('claude-oauth').name, 'Claude');
  assert.deepEqual(await ctx.adapters[0].adapter.listModels('claude-oauth'), []);
  assert.deepEqual(requested, [['connection']]);
});

test('the settings route rejects wrong method, content type, oversize and malformed bodies', async () => {
  const state = __test.createPluginState(fakeContext());
  const handler = __test.createApiHandler(state);

  const get = await handler(request(undefined, { method: 'GET' }));
  assert.equal(get.status, 405);
  assert.equal((await get.json()).ok, false);

  const text = await handler(request('{}', { contentType: 'text/plain' }));
  assert.equal(text.status, 415);

  const malformed = await handler(request('{not json', {}));
  assert.equal(malformed.status, 400);

  const unknown = await handler(request({ action: 'drop-tables' }));
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, ERROR_CODES.UNSUPPORTED_ACTION);

  const noAction = await handler(request({}));
  assert.equal(noAction.status, 400);
  assert.equal((await noAction.json()).error.code, ERROR_CODES.INVALID_REQUEST);
});

test('status is signed out with an idle login and a proxy report before any token exists', async () => {
  const state = __test.createPluginState(fakeContext());
  const handler = __test.createApiHandler(state);
  const response = await handler(request({ action: 'status' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, true);
  assert.equal(body.status.loggedIn, false);
  assert.equal(body.status.account, null);
  assert.equal(body.status.login.state, 'idle');
  assert.equal(body.status.models.count, 0);
  assert.equal(body.status.models.refreshing, false);
  assert.equal(typeof body.status.proxy.direct, 'boolean');
  assert.ok(body.status.proxy.target.includes('api.anthropic.com'));
});

test('refresh-models refuses while signed out without touching the network', async () => {
  const state = __test.createPluginState(fakeContext());
  const handler = __test.createApiHandler(state);
  const response = await handler(request({ action: 'refresh-models' }));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.ok, false);
  assert.equal(body.error.code, ERROR_CODES.NOT_LOGGED_IN);
});

test('a stored token makes status signed in and registers the fallback catalog', async () => {
  const now = Date.now();
  await writeJsonFile(join(dataDir, 'token.json'), {
    version: 1,
    accessToken: `sk-ant-oat-${'a'.repeat(40)}`,
    refreshToken: `sk-ant-ort-${'b'.repeat(40)}`,
    expiresAt: now + 3_600_000,
    refreshTokenExpiresAt: now + 86_400_000,
    scopes: 'user:inference',
    obtainedAt: now,
  });
  const state = __test.createPluginState(fakeContext());
  const handler = __test.createApiHandler(state);
  const body = await (await handler(request({ action: 'status' }))).json();
  assert.equal(body.status.loggedIn, true);
  assert.equal(body.status.models.count, DEFAULT_CATALOG_IDS.length);
  assert.equal(body.status.models.lastSource, 'default');
  const items = body.status.models.items;
  assert.equal(items.length, DEFAULT_CATALOG_IDS.length);
  const sonnet = items.find((model) => model.id === 'claude-sonnet-5');
  assert.ok(sonnet, 'the fallback catalog must include claude-sonnet-5');
  assert.equal(sonnet.name, 'Claude Sonnet 5');
  assert.equal(sonnet.contextWindow, 1_000_000);
  assert.equal(sonnet.maxTokens, 128_000);
  assert.deepEqual(sonnet.input, ['text', 'image']);
  assert.deepEqual(sonnet.efforts, ['low', 'medium', 'high', 'max']);
  assert.ok(!('accessToken' in sonnet), 'model display rows must not expose secrets');
  const mode = (await stat(join(dataDir, 'token.json'))).mode & 0o777;
  assert.equal(mode, 0o600);
  const stored = JSON.parse(await readFile(join(dataDir, 'token.json'), 'utf8'));
  assert.equal(stored.version, 1);
  assert.equal(stored.accessToken, `sk-ant-oat-${'a'.repeat(40)}`);
});

test('logout removes the session and the fallback catalog', async () => {
  const state = __test.createPluginState(fakeContext());
  const handler = __test.createApiHandler(state);
  const body = await (await handler(request({ action: 'logout' }))).json();
  assert.equal(body.ok, true);
  assert.equal(body.status.loggedIn, false);
  assert.equal(body.status.models.count, 0);
  await assert.rejects(stat(join(dataDir, 'token.json')));
});
