/**
 * Offline tests for the Claude token store and access-token lifecycle.
 *
 * Every test runs against a private `$DSH_HOME` in a temp directory and a
 * loopback `node:http` token endpoint bound to port 0, so no test reads the
 * real `~/.dsh`, binds a fixed port, or touches the network.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  CC_USER_AGENT,
  CLIENT_ID,
  DEFAULT_REFRESH_TOKEN_LIFETIME_MS,
  ERROR_CODES,
  OAUTH_BETA,
  REFRESH_BEFORE_EXPIRY_SECONDS,
  REFRESH_SCOPES,
} from '../lib/constants.js';
import { isPluginError } from '../lib/errors.js';
import {
  clearTokens,
  ensureAccessToken,
  forceRefreshAccessToken,
  isAccessTokenFresh,
  readTokens,
  tokenFilePath,
  tokenLockPath,
  writeTokens,
} from '../lib/tokens.js';

const NOW = 1_750_000_000_000;
const SECOND = 1000;

/** A valid stored token record, expired only when a test says so. */
function tokenRecord(overrides = {}) {
  return {
    version: 1,
    accessToken: 'sk-ant-oat01-stored-access',
    refreshToken: 'stored-refresh-token',
    expiresAt: NOW + 3600 * SECOND,
    refreshTokenExpiresAt: NOW + DEFAULT_REFRESH_TOKEN_LIFETIME_MS,
    scopes: 'user:inference user:profile',
    obtainedAt: NOW - 60 * SECOND,
    ...overrides,
  };
}

/** Redirect the plugin's data directory into a per-test temp home. */
async function makeHome(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-claude-oauth-tokens-'));
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = join(root, 'dsh');
  t.after(async () => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  return { root, dataDir: join(root, 'dsh', 'claude-oauth') };
}

function sendJson(response, status, value) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

/**
 * Start a loopback token endpoint.
 * `responder(call, response, oneBasedIndex)` decides each reply.
 */
async function startTokenServer(responder) {
  const calls = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => {
      const call = { method: request.method, url: request.url, headers: request.headers, body };
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

/** A successful refresh payload with rotating values. */
function refreshPayload(overrides = {}) {
  return {
    access_token: 'sk-ant-oat01-refreshed-access',
    refresh_token: 'rotated-refresh-token',
    expires_in: 3600,
    refresh_token_expires_in: 30 * 24 * 3600,
    scope: 'user:inference',
    ...overrides,
  };
}

function assertTokenRequestHeaders(call) {
  assert.equal(call.method, 'POST');
  assert.match(String(call.headers['content-type']), /^application\/json/);
  assert.match(String(call.headers.accept), /^application\/json/);
  assert.equal(call.headers['anthropic-beta'], OAUTH_BETA);
  assert.equal(call.headers['user-agent'], CC_USER_AGENT);
}

function assertNoTokenValues(value, secrets) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) {
    assert.ok(!text.includes(secret), `leaked token value ${secret}`);
  }
}

test('writeTokens round-trips the canonical record with private file modes', async (t) => {
  const { dataDir } = await makeHome(t);
  const stored = await writeTokens(tokenRecord({ extraField: 'dropped' }));

  assert.equal(stored, undefined);
  assert.deepEqual(await readTokens(), tokenRecord());
  assert.equal((await stat(tokenFilePath())).mode & 0o777, 0o600);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dataDir), ['token.json']);

  const parsed = JSON.parse(await readFile(tokenFilePath(), 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), [
    'accessToken',
    'expiresAt',
    'obtainedAt',
    'refreshToken',
    'refreshTokenExpiresAt',
    'scopes',
    'version',
  ]);
  assert.equal(parsed.extraField, undefined);

  // A second write replaces the file atomically and keeps it private.
  await writeTokens(tokenRecord({ accessToken: 'sk-ant-oat01-second-access' }));
  assert.equal((await readTokens()).accessToken, 'sk-ant-oat01-second-access');
  assert.equal((await stat(tokenFilePath())).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dataDir), ['token.json']);
});

test('readTokens returns null when absent and clearTokens removes the record', async (t) => {
  await makeHome(t);
  assert.equal(await readTokens(), null);
  await clearTokens();
  assert.equal(await readTokens(), null);

  await writeTokens(tokenRecord());
  await clearTokens();
  assert.equal(await readTokens(), null);
  await clearTokens();
});

test('readTokens maps corrupt or schema-invalid records to TOKEN_EXPIRED', async (t) => {
  await makeHome(t);
  await writeTokens(tokenRecord());

  await writeFile(tokenFilePath(), '{"accessToken":"sk-ant-oat01-CORRUPT-SECRET",');
  await assert.rejects(
    readTokens(),
    (error) =>
      isPluginError(error, ERROR_CODES.TOKEN_EXPIRED) &&
      error.details.reason === 'unreadable' &&
      !error.message.includes('CORRUPT-SECRET'),
  );

  const invalid = tokenRecord({ accessToken: 'not-a-claude-token' });
  await writeFile(tokenFilePath(), JSON.stringify(invalid));
  await assert.rejects(
    readTokens(),
    (error) => isPluginError(error, ERROR_CODES.TOKEN_EXPIRED) && error.details.reason === 'invalid',
  );

  await writeFile(tokenFilePath(), JSON.stringify(tokenRecord({ version: 2 })));
  await assert.rejects(readTokens(), (error) => isPluginError(error, ERROR_CODES.TOKEN_EXPIRED));

  await writeFile(tokenFilePath(), JSON.stringify(tokenRecord({ refreshToken: '' })));
  await assert.rejects(readTokens(), (error) => isPluginError(error, ERROR_CODES.TOKEN_EXPIRED));
});

test('readTokens maps an unreadable token file to TOKEN_EXPIRED', async (t) => {
  await makeHome(t);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    t.skip('file permission checks are meaningless as root');
    return;
  }
  await writeTokens(tokenRecord());
  await chmod(tokenFilePath(), 0o000);
  try {
    await assert.rejects(
      readTokens(),
      (error) =>
        isPluginError(error, ERROR_CODES.TOKEN_EXPIRED) && error.details.reason === 'unreadable',
    );
  } finally {
    await chmod(tokenFilePath(), 0o600);
  }
});

test('writeTokens refuses malformed records and never creates the file', async (t) => {
  await makeHome(t);
  for (const invalid of [
    undefined,
    null,
    'token',
    tokenRecord({ accessToken: 'plain' }),
    tokenRecord({ expiresAt: Number.NaN }),
    tokenRecord({ scopes: 7 }),
  ]) {
    await assert.rejects(
      writeTokens(invalid),
      (error) => isPluginError(error, ERROR_CODES.INVALID_REQUEST),
    );
  }
  assert.equal(await readTokens(), null);
});

test('isAccessTokenFresh refreshes inside the six-minute window', () => {
  assert.equal(
    isAccessTokenFresh(tokenRecord({ expiresAt: NOW + REFRESH_BEFORE_EXPIRY_SECONDS * SECOND }), { now: NOW }),
    true,
  );
  assert.equal(
    isAccessTokenFresh(tokenRecord({ expiresAt: NOW + REFRESH_BEFORE_EXPIRY_SECONDS * SECOND - 1 }), { now: NOW }),
    false,
  );
  assert.equal(
    isAccessTokenFresh(tokenRecord({ expiresAt: NOW + 30 * SECOND }), {
      now: NOW,
      refreshBeforeExpirySeconds: 10,
    }),
    true,
  );
  assert.equal(isAccessTokenFresh(tokenRecord({ expiresAt: NOW - 1 }), { now: NOW }), false);
});

test('ensureAccessToken honors a custom pre-expiry window', async (t) => {
  await makeHome(t);
  await writeTokens(tokenRecord({ expiresAt: NOW + 100 * SECOND }));
  let refreshes = 0;
  const fetchImpl = () => {
    refreshes += 1;
    throw new Error('unexpected refresh');
  };

  // 100s of life left is inside the default six-minute window but outside a
  // 50-second custom window, so no request is made.
  assert.equal(
    await ensureAccessToken({ now: NOW, fetchImpl, refreshBeforeExpirySeconds: 50 }),
    'sk-ant-oat01-stored-access',
  );
  assert.equal(refreshes, 0);

  // A 200-second window forces the refresh, which then fails (offline) as a
  // typed PluginError rather than the injected plain Error.
  await assert.rejects(
    ensureAccessToken({ now: NOW, fetchImpl, refreshBeforeExpirySeconds: 200, timeoutMs: 50 }),
    (error) => isPluginError(error, ERROR_CODES.REFRESH_FAILED),
  );
  assert.equal(refreshes, 1);
});

test('ensureAccessToken returns a fresh stored token without any request', async (t) => {
  await makeHome(t);
  await writeTokens(tokenRecord());
  let fetches = 0;
  const accessToken = await ensureAccessToken({
    now: NOW,
    fetchImpl: () => {
      fetches += 1;
      throw new Error('unexpected refresh');
    },
  });
  assert.equal(accessToken, 'sk-ant-oat01-stored-access');
  assert.equal(fetches, 0);
});

test('ensureAccessToken reports NOT_LOGGED_IN without a stored record', async (t) => {
  await makeHome(t);
  await assert.rejects(
    ensureAccessToken({ now: NOW, fetchImpl: () => assert.fail('unexpected refresh') }),
    (error) => isPluginError(error, ERROR_CODES.NOT_LOGGED_IN),
  );
});

test('ensureAccessToken refreshes proactively and persists the rotated record', async (t) => {
  const { dataDir } = await makeHome(t);
  const server = await startTokenServer((call, response) => sendJson(response, 200, refreshPayload()));
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  const accessToken = await ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url });
  assert.equal(accessToken, 'sk-ant-oat01-refreshed-access');
  assert.equal(server.calls.length, 1);
  assert.equal(server.calls[0].url, '/v1/oauth/token');
  assertTokenRequestHeaders(server.calls[0]);
  assert.deepEqual(JSON.parse(server.calls[0].body), {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: 'stored-refresh-token',
    scope: REFRESH_SCOPES,
  });

  const stored = await readTokens();
  assert.equal(stored.accessToken, 'sk-ant-oat01-refreshed-access');
  assert.equal(stored.refreshToken, 'rotated-refresh-token');
  assert.equal(stored.expiresAt, NOW + 3600 * SECOND);
  assert.equal(stored.refreshTokenExpiresAt, NOW + 30 * 24 * 3600 * SECOND);
  assert.equal(stored.scopes, 'user:inference');
  assert.equal(stored.obtainedAt, NOW);
  assert.equal((await stat(tokenFilePath())).mode & 0o777, 0o600);
  assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(dataDir), ['token.json']);
});

test('refresh keeps the previous refresh token and defaults its lifetime', async (t) => {
  await makeHome(t);
  const server = await startTokenServer((call, response) =>
    sendJson(response, 200, {
      access_token: 'sk-ant-oat01-rotated-access',
      expires_in: 1800,
    }),
  );
  t.after(() => server.close());
  const before = tokenRecord({
    expiresAt: NOW - SECOND,
    refreshToken: 'kept-refresh-token',
    scopes: 'user:inference user:profile',
  });
  await writeTokens(before);

  const accessToken = await ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url });
  assert.equal(accessToken, 'sk-ant-oat01-rotated-access');
  const stored = await readTokens();
  assert.equal(stored.refreshToken, 'kept-refresh-token');
  assert.equal(stored.expiresAt, NOW + 1800 * SECOND);
  assert.equal(stored.refreshTokenExpiresAt, NOW + DEFAULT_REFRESH_TOKEN_LIFETIME_MS);
  assert.equal(stored.scopes, 'user:inference user:profile');
});

test('refresh retries once without scope on OAuth invalid_scope', async (t) => {
  await makeHome(t);
  const server = await startTokenServer((call, response, index) => {
    if (index === 1) sendJson(response, 400, { error: 'invalid_scope', error_description: 'scope no longer granted' });
    else sendJson(response, 200, refreshPayload());
  });
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  const accessToken = await ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url });
  assert.equal(accessToken, 'sk-ant-oat01-refreshed-access');
  assert.equal(server.calls.length, 2);
  const first = JSON.parse(server.calls[0].body);
  const retry = JSON.parse(server.calls[1].body);
  assert.equal(first.scope, REFRESH_SCOPES);
  assert.equal(Object.hasOwn(retry, 'scope'), false);
  assert.deepEqual(retry, {
    grant_type: 'refresh_token',
    client_id: CLIENT_ID,
    refresh_token: 'stored-refresh-token',
  });
  assertTokenRequestHeaders(server.calls[1]);
});

test('invalid_scope is retried at most once and surfaces REFRESH_FAILED', async (t) => {
  await makeHome(t);
  const server = await startTokenServer((call, response) =>
    sendJson(response, 400, { error: 'invalid_scope' }),
  );
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  await assert.rejects(
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    (error) =>
      isPluginError(error, ERROR_CODES.REFRESH_FAILED) &&
      error.message.includes('HTTP 400') &&
      error.details.oauthError === 'invalid_scope',
  );
  assert.equal(server.calls.length, 2);
});

test('concurrent ensureAccessToken calls share a single refresh request', async (t) => {
  await makeHome(t);
  const server = await startTokenServer((call, response) => {
    setTimeout(() => {
      try {
        sendJson(response, 200, refreshPayload());
      } catch {
        // The test may have torn the socket down.
      }
    }, 60);
  });
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  const results = await Promise.all([
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
  ]);
  assert.deepEqual(results, [
    'sk-ant-oat01-refreshed-access',
    'sk-ant-oat01-refreshed-access',
    'sk-ant-oat01-refreshed-access',
  ]);
  assert.equal(server.calls.length, 1);
  assert.equal((await readTokens()).accessToken, 'sk-ant-oat01-refreshed-access');
});

test('forceRefreshAccessToken rotates a fresh token and is single-flight', async (t) => {
  await makeHome(t);
  const server = await startTokenServer((call, response) => {
    setTimeout(() => {
      try {
        sendJson(response, 200, refreshPayload());
      } catch {
        // The test may have torn the socket down.
      }
    }, 60);
  });
  t.after(() => server.close());
  await writeTokens(tokenRecord());

  const results = await Promise.all([
    forceRefreshAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    forceRefreshAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
  ]);
  assert.deepEqual(results, ['sk-ant-oat01-refreshed-access', 'sk-ant-oat01-refreshed-access']);
  assert.equal(server.calls.length, 1);
  assert.equal((await readTokens()).accessToken, 'sk-ant-oat01-refreshed-access');
});

test('the lock holder re-reads and reuses a token refreshed by another writer', async (t) => {
  const { dataDir } = await makeHome(t);
  const server = await startTokenServer((call, response) => sendJson(response, 200, refreshPayload()));
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  // Simulate another process already refreshing: hold the lock, then publish
  // a fresh token and release. The waiter must reuse it, not spend the
  // single-use refresh token a second time.
  await writeFile(tokenLockPath(), `${process.pid} ${Date.now()}\n`);
  let fetches = 0;
  const pending = ensureAccessToken({
    now: NOW,
    fetchImpl: (...args) => {
      fetches += 1;
      return fetch(...args);
    },
    tokenUrl: server.url,
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  await writeTokens(
    tokenRecord({
      accessToken: 'sk-ant-oat01-fresh-from-other-writer',
      expiresAt: NOW + 3600 * SECOND,
      obtainedAt: NOW,
    }),
  );
  await rm(tokenLockPath(), { force: true });

  assert.equal(await pending, 'sk-ant-oat01-fresh-from-other-writer');
  assert.equal(fetches, 0);
  assert.equal(server.calls.length, 0);
  assert.deepEqual(await readdir(dataDir), ['token.json']);
});

test('a refresh token past its own lifetime fails without spending a request', async (t) => {
  await makeHome(t);
  const server = await startTokenServer((call, response) => sendJson(response, 200, refreshPayload()));
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND, refreshTokenExpiresAt: NOW - SECOND }));

  await assert.rejects(
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    (error) => isPluginError(error, ERROR_CODES.REFRESH_TOKEN_EXPIRED),
  );
  await assert.rejects(
    forceRefreshAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    (error) => isPluginError(error, ERROR_CODES.REFRESH_TOKEN_EXPIRED),
  );
  assert.equal(server.calls.length, 0);

  // A still-valid access token remains usable even if the refresh grant is old.
  await writeTokens(
    tokenRecord({ expiresAt: NOW + 3600 * SECOND, refreshTokenExpiresAt: NOW - SECOND }),
  );
  assert.equal(
    await ensureAccessToken({ now: NOW, fetchImpl: () => assert.fail('unexpected refresh') }),
    'sk-ant-oat01-stored-access',
  );
});

test('a rejected refresh maps OAuth codes to PluginError without leaking values', async (t) => {
  await makeHome(t);
  const secretAccess = 'sk-ant-oat01-LEAKED-ACCESS';
  const server = await startTokenServer((call, response) =>
    sendJson(response, 400, {
      error: 'invalid_grant',
      error_description: 'refresh token expired',
      access_token: secretAccess,
      refresh_token: 'LEAKED-REFRESH',
    }),
  );
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  await assert.rejects(
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    (error) => {
      assert.ok(isPluginError(error, ERROR_CODES.REFRESH_TOKEN_EXPIRED));
      assert.equal(error.details.status, 400);
      assert.equal(error.details.oauthError, 'invalid_grant');
      assertNoTokenValues(error.message, [secretAccess, 'LEAKED-REFRESH', 'stored-refresh-token']);
      assertNoTokenValues(error.details, [secretAccess, 'LEAKED-REFRESH', 'stored-refresh-token']);
      return true;
    },
  );
});

test('server-side failures map to REFRESH_FAILED with status and OAuth code only', async (t) => {
  await makeHome(t);
  const server = await startTokenServer((call, response) =>
    sendJson(response, 500, {
      error: 'server_error',
      access_token: 'sk-ant-oat01-LEAKED-ACCESS',
      refresh_token: 'LEAKED-REFRESH',
    }),
  );
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  await assert.rejects(
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    (error) => {
      assert.ok(isPluginError(error, ERROR_CODES.REFRESH_FAILED));
      assert.match(error.message, /HTTP 500, server_error/);
      assert.deepEqual(error.details, { status: 500, oauthError: 'server_error' });
      assertNoTokenValues(error.message, ['sk-ant-oat01-LEAKED-ACCESS', 'LEAKED-REFRESH']);
      return true;
    },
  );
});

test('a token response with invalid JSON or a bad access token is REFRESH_FAILED', async (t) => {
  await makeHome(t);
  let malformed = true;
  const server = await startTokenServer((call, response) => {
    if (malformed) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('this is not json');
    } else {
      sendJson(response, 200, refreshPayload({ access_token: 'not-a-claude-access-token' }));
    }
  });
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  await assert.rejects(
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    (error) => isPluginError(error, ERROR_CODES.REFRESH_FAILED) && /invalid response/.test(error.message),
  );
  malformed = false;
  await assert.rejects(
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url }),
    (error) => isPluginError(error, ERROR_CODES.REFRESH_FAILED) && /invalid access token/.test(error.message),
  );
});

test('a hung token endpoint aborts at the bounded timeout', async (t) => {
  await makeHome(t);
  const server = await startTokenServer(() => {
    // Deliberately never answer.
  });
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  const startedAt = Date.now();
  await assert.rejects(
    ensureAccessToken({ now: NOW, fetchImpl: fetch, tokenUrl: server.url, timeoutMs: 50 }),
    (error) =>
      isPluginError(error, ERROR_CODES.REFRESH_FAILED) &&
      error.details.reason === 'timeout' &&
      /timed out/.test(error.message),
  );
  assert.ok(Date.now() - startedAt < 2000);
  assert.equal((await readTokens()).accessToken, 'sk-ant-oat01-stored-access');
});

test('an aborted caller signal cancels the refresh safely', async (t) => {
  await makeHome(t);
  const server = await startTokenServer((call, response) => sendJson(response, 200, refreshPayload()));
  t.after(() => server.close());
  await writeTokens(tokenRecord({ expiresAt: NOW - SECOND }));

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    ensureAccessToken({
      now: NOW,
      fetchImpl: fetch,
      tokenUrl: server.url,
      signal: controller.signal,
    }),
    (error) =>
      isPluginError(error, ERROR_CODES.REFRESH_FAILED) &&
      error.details.reason === 'aborted' &&
      /cancelled/.test(error.message),
  );
  assert.equal(server.calls.length, 0);
  assert.equal((await readTokens()).accessToken, 'sk-ant-oat01-stored-access');
});
