/**
 * Offline tests for the Claude OAuth browser sign-in flow: PKCE, authorize
 * URL, the loopback callback guard rails, the code exchange, cancel, timeout.
 *
 * Every flow binds loopback ports only (preferred port 0 unless a test says
 * otherwise) and exchanges against a local `node:http` token endpoint, so no
 * test touches the real network, the real `~/.dsh`, or a fixed public port.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer, request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AUTHORIZE_URL,
  CALLBACK_PATH,
  CC_USER_AGENT,
  CLIENT_ID,
  DEFAULT_REFRESH_TOKEN_LIFETIME_MS,
  ERROR_CODES,
  LOGIN_SCOPES,
  OAUTH_BETA,
} from '../lib/constants.js';
import { isPluginError } from '../lib/errors.js';
import {
  buildAuthorizeUrl,
  createLoginFlow,
  createPkceChallenge,
  generatePkce,
  parseTokenResponse,
  startCallbackServer,
} from '../lib/oauth.js';

/** Redirect `$DSH_HOME` into a per-test temp directory. */
async function makeHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-oauth-flow-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'dsh');
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, tokenFile: join(root, 'dsh', 'claude-oauth', 'token.json') };
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

/** One HTTP request against the loopback callback listener. */
function request({ port, method = 'GET', path = '/', headers = {}, host = '127.0.0.1', timeoutMs = 5000 }) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host, port, method, path, headers, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`callback request timed out after ${timeoutMs}ms`)));
    req.end();
  });
}

/** Poll until the closed listener refuses connections. */
async function waitForConnectionRefused(port, timeoutMs = 1500) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await request({ port, path: '/favicon.ico', timeoutMs: 250 });
    } catch (error) {
      if (typeof error.code === 'string' && error.code.startsWith('ECONN')) return;
      if (error.code === 'EPIPE' || error.code === 'ETIMEDOUT') return;
      throw error;
    }
    if (Date.now() > deadline) throw new Error('callback listener is still accepting connections');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Loopback mock token endpoint; records every request. */
async function startTokenServer(responder) {
  const calls = [];
  const server = createHttpServer((httpReq, response) => {
    let body = '';
    httpReq.setEncoding('utf8');
    httpReq.on('data', (chunk) => {
      body += chunk;
    });
    httpReq.on('end', () => {
      const call = { method: httpReq.method, url: httpReq.url, headers: httpReq.headers, body };
      calls.push(call);
      void Promise.resolve()
        .then(() => responder(call, response, calls.length))
        .catch(() => {
          try {
            sendJson(response, 500, { error: 'mock_failure' });
          } catch {
            // The test already closed the socket.
          }
        });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}/v1/oauth/token`,
    calls,
    async close() {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function tokenPayload(overrides = {}) {
  return {
    access_token: 'sk-ant-oat01-login-access',
    refresh_token: 'login-refresh-token',
    expires_in: 3600,
    refresh_token_expires_in: 30 * 24 * 3600,
    ...overrides,
  };
}

async function makeFlow(t, tokenServer, overrides = {}) {
  const flow = await createLoginFlow({
    fetchImpl: fetch,
    tokenUrl: tokenServer === null || tokenServer === undefined ? 'http://127.0.0.1:1/unused' : tokenServer.url,
    preferredPort: 0,
    timeoutMs: 5000,
    ...overrides,
  });
  t.after(async () => {
    await flow.dispose();
  });
  return flow;
}

/** Parse the pieces of an auth URL a browser callback would use. */
function flowParts(flow) {
  const authorize = new URL(flow.authUrl);
  const redirectUri = authorize.searchParams.get('redirect_uri');
  const redirect = new URL(redirectUri);
  return {
    authorize,
    params: authorize.searchParams,
    redirectUri,
    redirect,
    port: Number(redirect.port),
    state: authorize.searchParams.get('state'),
    challenge: authorize.searchParams.get('code_challenge'),
    path: redirect.pathname,
  };
}

function callbackPath(parts, query = {}) {
  const encoded = new URLSearchParams(query).toString();
  return encoded === '' ? parts.path : `${parts.path}?${encoded}`;
}

function assertNoTokenValues(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `leaked value ${secret}`);
  }
}

test('PKCE S256 matches the RFC 7636 appendix B vector', () => {
  assert.equal(
    createPkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  );
  const first = generatePkce();
  const second = generatePkce();
  assert.match(first.verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.challenge, createPkceChallenge(first.verifier));
  assert.match(first.challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.notEqual(first.verifier, second.verifier);
  assert.notEqual(first.challenge, second.challenge);
  assert.throws(
    () => createPkceChallenge(''),
    (error) => isPluginError(error, ERROR_CODES.INVALID_REQUEST),
  );
});

test('buildAuthorizeUrl carries every Claude authorize parameter', () => {
  const url = new URL(
    buildAuthorizeUrl({
      redirectUri: 'http://localhost:53692/callback',
      state: 'state-value',
      codeChallenge: 'challenge-value',
    }),
  );
  assert.equal(`${url.origin}${url.pathname}`, AUTHORIZE_URL);
  const params = url.searchParams;
  assert.equal(params.get('code'), 'true');
  assert.equal(params.get('client_id'), CLIENT_ID);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('redirect_uri'), 'http://localhost:53692/callback');
  assert.equal(params.get('scope'), LOGIN_SCOPES);
  assert.equal(params.get('state'), 'state-value');
  assert.equal(params.get('code_challenge'), 'challenge-value');
  assert.equal(params.get('code_challenge_method'), 'S256');
  assert.throws(
    () => buildAuthorizeUrl({}),
    (error) => isPluginError(error, ERROR_CODES.INVALID_REQUEST),
  );
});

test('parseTokenResponse builds the canonical record and applies defaults', () => {
  const now = 1_750_000_000_000;
  assert.deepEqual(
    parseTokenResponse(
      { access_token: 'sk-ant-oat01-a', refresh_token: 'refresh-a', expires_in: 60, scope: 'scope-a' },
      { now, scopes: LOGIN_SCOPES },
    ),
    {
      version: 1,
      accessToken: 'sk-ant-oat01-a',
      refreshToken: 'refresh-a',
      expiresAt: now + 60_000,
      refreshTokenExpiresAt: now + DEFAULT_REFRESH_TOKEN_LIFETIME_MS,
      scopes: 'scope-a',
      obtainedAt: now,
    },
  );
  const fallback = parseTokenResponse({ access_token: 'sk-ant-oat01-b', refresh_token: 'refresh-b' }, { now });
  assert.equal(fallback.scopes, LOGIN_SCOPES);
  assert.equal(fallback.expiresAt, now + 3600_000);
  assert.throws(
    () => parseTokenResponse({ access_token: 'not-a-claude-token', refresh_token: 'r' }, { now }),
    (error) => isPluginError(error, ERROR_CODES.LOGIN_FAILED),
  );
  assert.throws(
    () => parseTokenResponse({ access_token: 'sk-ant-oat01-a' }, { now }),
    (error) => isPluginError(error, ERROR_CODES.LOGIN_FAILED),
  );
});

test('createLoginFlow binds a loopback listener before resolving', async (t) => {
  const home = await makeHome(t);
  const flow = await makeFlow(t, null);
  const parts = flowParts(flow);

  assert.equal(parts.redirect.hostname, 'localhost');
  assert.equal(parts.redirect.protocol, 'http:');
  assert.equal(parts.path, CALLBACK_PATH);
  assert.ok(parts.port > 0);
  assert.equal(parts.params.get('code'), 'true');
  assert.equal(parts.params.get('response_type'), 'code');
  assert.equal(parts.params.get('client_id'), CLIENT_ID);
  assert.equal(parts.params.get('scope'), LOGIN_SCOPES);
  assert.equal(parts.params.get('code_challenge_method'), 'S256');
  assert.ok(parts.state.length >= 32);
  assert.ok(parts.challenge.length >= 32);
  assert.notEqual(parts.state, parts.challenge);

  // The listener exists as soon as createLoginFlow resolves.
  const probe = await request({ port: parts.port, path: '/favicon.ico' });
  assert.equal(probe.status, 404);

  // The flow only returns tokens to its caller; it never persists them.
  await assert.rejects(stat(home.tokenFile), (error) => error.code === 'ENOENT');
});

test('falls back to an ephemeral port when the preferred port is taken', async (t) => {
  await makeHome(t);
  const blocker = createNetServer();
  await new Promise((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const preferredPort = blocker.address().port;

  const flow = await makeFlow(t, null, { preferredPort });
  const parts = flowParts(flow);
  assert.notEqual(parts.port, preferredPort);
  assert.equal((await request({ port: parts.port, path: '/favicon.ico' })).status, 404);
});

test('a valid callback exchanges the code and resolves the token record', async (t) => {
  const home = await makeHome(t);
  const now = 1_750_000_000_000;
  const tokenServer = await startTokenServer((call, response) =>
    sendJson(response, 200, tokenPayload({ scope: 'user:inference user:profile' })),
  );
  t.after(() => tokenServer.close());
  const flow = await makeFlow(t, tokenServer, { now });
  const parts = flowParts(flow);

  const code = 'auth code/with+specials=1';
  const response = await request({ port: parts.port, path: callbackPath(parts, { code, state: parts.state }) });
  assert.equal(response.status, 200);
  assert.match(String(response.headers['content-type']), /^text\/html/);
  assert.match(String(response.headers['cache-control']), /no-store/);
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.equal(response.headers['referrer-policy'], 'no-referrer');
  assert.match(String(response.headers['content-security-policy']), /default-src 'none'/);
  assert.ok(!/<script/i.test(response.body), 'callback page must be static HTML');
  assert.ok(!response.body.includes(code), 'callback page must not echo the authorization code');

  const record = await flow.wait();
  assert.deepEqual(record, {
    version: 1,
    accessToken: 'sk-ant-oat01-login-access',
    refreshToken: 'login-refresh-token',
    expiresAt: now + 3600_000,
    refreshTokenExpiresAt: now + 30 * 24 * 3600_000,
    scopes: 'user:inference user:profile',
    obtainedAt: now,
  });
  // wait is idempotent, both as a call and as a promise-like.
  assert.deepEqual(await flow.wait(), record);
  assert.deepEqual(await flow.wait, record);

  assert.equal(tokenServer.calls.length, 1);
  const call = tokenServer.calls[0];
  assert.equal(call.method, 'POST');
  assert.equal(call.url, '/v1/oauth/token');
  assert.match(String(call.headers['content-type']), /^application\/json/);
  assert.match(String(call.headers.accept), /^application\/json/);
  assert.equal(call.headers['anthropic-beta'], OAUTH_BETA);
  assert.equal(call.headers['user-agent'], CC_USER_AGENT);
  const body = JSON.parse(call.body);
  assert.equal(body.grant_type, 'authorization_code');
  assert.equal(body.client_id, CLIENT_ID);
  assert.equal(body.code, code);
  assert.equal(body.state, parts.state);
  assert.equal(body.redirect_uri, parts.redirectUri);
  assert.equal(typeof body.code_verifier, 'string');
  assert.equal(createPkceChallenge(body.code_verifier), parts.challenge);

  await assert.rejects(stat(home.tokenFile), (error) => error.code === 'ENOENT');
});

test('a second callback after success answers 409 and is not exchanged again', async (t) => {
  await makeHome(t);
  const tokenServer = await startTokenServer((call, response) => sendJson(response, 200, tokenPayload()));
  t.after(() => tokenServer.close());
  const flow = await makeFlow(t, tokenServer);
  const parts = flowParts(flow);
  const path = callbackPath(parts, { code: 'auth-code', state: parts.state });

  assert.equal((await request({ port: parts.port, path })).status, 200);
  const duplicate = await request({ port: parts.port, path });
  assert.equal(duplicate.status, 409);
  assert.equal(tokenServer.calls.length, 1);
  assert.ok((await flow.wait()).accessToken.startsWith('sk-ant-oat'));
});

test('wrong state or missing code is rejected without settling the flow', async (t) => {
  await makeHome(t);
  const tokenServer = await startTokenServer((call, response) => sendJson(response, 200, tokenPayload()));
  t.after(() => tokenServer.close());
  const flow = await makeFlow(t, tokenServer);
  const parts = flowParts(flow);

  const wrongState = await request({
    port: parts.port,
    path: callbackPath(parts, { code: 'auth-code', state: 'not-the-issued-state' }),
  });
  assert.equal(wrongState.status, 400);
  assert.equal(tokenServer.calls.length, 0);

  const missingCode = await request({ port: parts.port, path: callbackPath(parts, { state: parts.state }) });
  assert.equal(missingCode.status, 400);
  assert.equal(tokenServer.calls.length, 0);

  // Still unclaimed: a valid callback now completes the login.
  const ok = await request({ port: parts.port, path: callbackPath(parts, { code: 'auth-code', state: parts.state }) });
  assert.equal(ok.status, 200);
  assert.equal((await flow.wait()).accessToken, 'sk-ant-oat01-login-access');
  assert.equal(tokenServer.calls.length, 1);
});

test('an error callback answers 400 and rejects wait with LOGIN_FAILED', async (t) => {
  const home = await makeHome(t);
  const tokenServer = await startTokenServer((call, response) => sendJson(response, 200, tokenPayload()));
  t.after(() => tokenServer.close());
  const flow = await makeFlow(t, tokenServer);
  const parts = flowParts(flow);

  const response = await request({
    port: parts.port,
    path: callbackPath(parts, {
      error: 'access_denied',
      error_description: '<b>User denied</b>',
      state: parts.state,
    }),
  });
  assert.equal(response.status, 400);
  assert.ok(response.body.includes('&lt;b&gt;User denied&lt;/b&gt;'), 'page must escape provider text');
  assert.ok(!response.body.includes('<b>User denied</b>'));

  const error = await flow.wait().then(
    () => null,
    (failure) => failure,
  );
  assert.ok(isPluginError(error, ERROR_CODES.LOGIN_FAILED));
  assert.equal(error.details.oauthError, 'access_denied');
  assert.ok(!/User denied/.test(error.message), 'provider description must not enter the error message');
  assert.equal(tokenServer.calls.length, 0);
  await assert.rejects(stat(home.tokenFile), (failure) => failure.code === 'ENOENT');
});

test('wrong paths 404 and non-GET requests 405 without closing the listener', async (t) => {
  await makeHome(t);
  const tokenServer = await startTokenServer((call, response) => sendJson(response, 200, tokenPayload()));
  t.after(() => tokenServer.close());
  const flow = await makeFlow(t, tokenServer);
  const parts = flowParts(flow);

  assert.equal((await request({ port: parts.port, path: '/' })).status, 404);
  assert.equal((await request({ port: parts.port, path: '/favicon.ico' })).status, 404);
  assert.equal((await request({ port: parts.port, path: '/callback/extra' })).status, 404);
  const post = await request({
    port: parts.port,
    method: 'POST',
    path: callbackPath(parts, { code: 'auth-code', state: parts.state }),
    headers: { 'content-length': 0 },
  });
  assert.equal(post.status, 405);
  assert.equal(tokenServer.calls.length, 0);

  // The listener kept running and the flow is still claimable.
  assert.equal(
    (await request({ port: parts.port, path: callbackPath(parts, { code: 'auth-code', state: parts.state }) }))
      .status,
    200,
  );
  assert.equal((await flow.wait()).accessToken, 'sk-ant-oat01-login-access');
});

test('rejects a foreign Host header but accepts every loopback spelling', async (t) => {
  await makeHome(t);
  const tokenServer = await startTokenServer((call, response) => sendJson(response, 200, tokenPayload()));
  t.after(() => tokenServer.close());

  // A DNS-rebinding style Host must not be able to drive the callback.
  const guarded = await makeFlow(t, tokenServer);
  const guardedParts = flowParts(guarded);
  const validPath = callbackPath(guardedParts, { code: 'auth-code', state: guardedParts.state });
  for (const host of ['evil.example', 'evil.example:443', '127.0.0.1:1', `localhost:1`]) {
    const rejected = await request({ port: guardedParts.port, path: validPath, headers: { host } });
    assert.equal(rejected.status, 400, `Host ${host} must be rejected`);
  }
  assert.equal((await request({ port: guardedParts.port, path: validPath })).status, 200);
  assert.equal(tokenServer.calls.length, 1);

  // Each allowed spelling (localhost, 127.0.0.1, [::1]) is accepted on its own flow.
  for (const hostname of ['localhost', '127.0.0.1', '[::1]']) {
    const flow = await makeFlow(t, tokenServer);
    const parts = flowParts(flow);
    const response = await request({
      port: parts.port,
      path: callbackPath(parts, { code: 'auth-code', state: parts.state }),
      headers: { host: `${hostname}:${parts.port}` },
    });
    assert.equal(response.status, 200, `Host ${hostname} must be accepted`);
    assert.equal((await flow.wait()).accessToken, 'sk-ant-oat01-login-access');
  }
  assert.equal(tokenServer.calls.length, 4);
});

test('cancel rejects with LOGIN_CANCELLED, closes listeners, and is idempotent', async (t) => {
  await makeHome(t);
  const tokenServer = await startTokenServer((call, response) => sendJson(response, 200, tokenPayload()));
  t.after(() => tokenServer.close());
  const flow = await makeFlow(t, tokenServer);
  const parts = flowParts(flow);

  await flow.cancel();
  await assert.rejects(flow.wait(), (error) => isPluginError(error, ERROR_CODES.LOGIN_CANCELLED));
  await flow.cancel();
  await flow.dispose();
  await flow.dispose();
  await waitForConnectionRefused(parts.port);
  assert.equal(tokenServer.calls.length, 0);
});

test('dispose before a callback rejects wait and closes the listener', async (t) => {
  await makeHome(t);
  const flow = await makeFlow(t, null);
  const parts = flowParts(flow);
  await flow.dispose();
  await assert.rejects(flow.wait(), (error) => isPluginError(error, ERROR_CODES.LOGIN_CANCELLED));
  await waitForConnectionRefused(parts.port);
});

test('an unanswered flow times out with LOGIN_TIMEOUT and closes', async (t) => {
  await makeHome(t);
  const flow = await makeFlow(t, null, { timeoutMs: 80 });
  const parts = flowParts(flow);
  const error = await flow.wait().then(
    () => null,
    (failure) => failure,
  );
  assert.ok(isPluginError(error, ERROR_CODES.LOGIN_TIMEOUT));
  await waitForConnectionRefused(parts.port);
  await flow.dispose();
});

test('a failed code exchange rejects wait with LOGIN_FAILED and leaks nothing', async (t) => {
  await makeHome(t);
  const secretAccess = 'sk-ant-oat01-EXCHANGE-LEAK';
  const secretRefresh = 'EXCHANGE-LEAK-REFRESH';
  const tokenServer = await startTokenServer((call, response) =>
    sendJson(response, 400, {
      error: 'invalid_grant',
      error_description: 'authorization code expired',
      access_token: secretAccess,
      refresh_token: secretRefresh,
    }),
  );
  t.after(() => tokenServer.close());
  const flow = await makeFlow(t, tokenServer);
  const parts = flowParts(flow);

  const response = await request({
    port: parts.port,
    path: callbackPath(parts, { code: 'auth-code', state: parts.state }),
  });
  assert.equal(response.status, 502);
  const error = await flow.wait().then(
    () => null,
    (failure) => failure,
  );
  assert.ok(isPluginError(error, ERROR_CODES.LOGIN_FAILED));
  assert.equal(error.details.status, 400);
  assert.equal(error.details.oauthError, 'invalid_grant');
  assert.match(error.message, /HTTP 400, invalid_grant/);
  assertNoTokenValues(error.message, [secretAccess, secretRefresh]);
  assertNoTokenValues(error.details, [secretAccess, secretRefresh]);
  assertNoTokenValues(response.body, [secretAccess, secretRefresh, 'auth-code']);
  assert.equal(tokenServer.calls.length, 1);
});

test('invalid token endpoint payloads map to LOGIN_FAILED', async (t) => {
  await makeHome(t);
  let mode = 'not-json';
  const tokenServer = await startTokenServer((call, response) => {
    if (mode === 'not-json') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('not json at all');
    } else {
      sendJson(response, 200, { access_token: 'not-a-claude-access-token', refresh_token: 'refresh' });
    }
  });
  t.after(() => tokenServer.close());

  for (const expected of [/invalid response/, /invalid access token/]) {
    const flow = await makeFlow(t, tokenServer);
    const parts = flowParts(flow);
    const response = await request({
      port: parts.port,
      path: callbackPath(parts, { code: 'auth-code', state: parts.state }),
    });
    assert.equal(response.status, 502);
    const error = await flow.wait().then(
      () => null,
      (failure) => failure,
    );
    assert.ok(isPluginError(error, ERROR_CODES.LOGIN_FAILED));
    assert.match(error.message, expected);
    mode = 'bad-token';
  }
});

test('a custom callback path is honored end to end', async (t) => {
  await makeHome(t);
  const tokenServer = await startTokenServer((call, response) => sendJson(response, 200, tokenPayload()));
  t.after(() => tokenServer.close());
  const flow = await makeFlow(t, tokenServer, { callbackPath: '/oauth/callback' });
  const parts = flowParts(flow);
  assert.equal(parts.path, '/oauth/callback');
  assert.equal(parts.redirectUri, `http://localhost:${parts.port}/oauth/callback`);

  assert.equal(
    (await request({ port: parts.port, path: callbackPath(parts, { code: 'auth-code', state: parts.state }) })).status,
    200,
  );
  assert.equal((await flow.wait()).accessToken, 'sk-ant-oat01-login-access');
});

test('startCallbackServer binds the IPv6 loopback on the same port when available', async (t) => {
  const server = await startCallbackServer({
    state: 'test-state-value',
    port: 0,
    timeoutMs: 2000,
    complete: async (code) => ({ code }),
  });
  t.after(() => server.dispose());
  assert.equal(server.path, CALLBACK_PATH);
  assert.equal((await request({ port: server.port, path: '/favicon.ico' })).status, 404);
  if (server.ipv6Bound) {
    const viaIpv6 = await request({
      host: '::1',
      port: server.port,
      path: '/favicon.ico',
      headers: { host: `[::1]:${server.port}` },
    });
    assert.equal(viaIpv6.status, 404);
  }
});
