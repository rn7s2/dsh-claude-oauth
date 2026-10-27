/**
 * Offline tests for the dsh-claude-oauth Client half.
 *
 * The bundle is a plain browser module, so the tests load it with node:vm and
 * a fake `window.__ModuleLoader__`, then drive it with a fake `react` runtime,
 * fake locale/slots services and fixtures shaped like the Host status route.
 * No network, no timers, no DOM.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8');

/** Load the bundle once in its own VM realm; reuse the module definition. */
function loadBundle() {
  let definition = null;
  const window = {
    __ModuleLoader__: {
      load(candidate) {
        definition = candidate;
      },
    },
  };
  const sandbox = {
    window,
    console,
    fetch() {
      throw new Error('unexpected fetch() during this test');
    },
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox, { filename: 'lib/client.js' });
  assert.ok(definition, 'window.__ModuleLoader__.load() must be called');
  return { definition, sandbox, window };
}

const bundle = loadBundle();

/** Replace `{name}` placeholders the same way the real locale runtime does. */
function formatTemplate(template, params) {
  if (typeof template !== 'string') return '';
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/** Minimal `react` runtime: hook state comes from a fixed queue. */
function makeReact(queue) {
  let index = 0;
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      const value = index < queue.length ? queue[index] : typeof initial === 'function' ? initial() : initial;
      index += 1;
      return [value, () => {}];
    },
    useEffect() {},
  };
}

/** Fake `ctx.locale`: records dictionaries and resolves via the active locale. */
function makeLocale() {
  const dictionaries = new Map();
  const locales = [];
  const locale = {
    active: 'en',
    dictionaries,
    locales,
    register(ns, localeOrDicts, dict) {
      const pairs = typeof localeOrDicts === 'string' ? [[localeOrDicts, dict]] : Object.entries(localeOrDicts || {});
      let store = dictionaries.get(ns);
      if (!store) {
        store = new Map();
        dictionaries.set(ns, store);
      }
      for (const [id, entries] of pairs) {
        if (!store.has(id)) locales.push(id);
        store.set(id, entries);
      }
      return () => {
        for (const [id, entries] of pairs) if (store.get(id) === entries) store.delete(id);
      };
    },
    bind(ns) {
      return (key, params) => {
        const store = dictionaries.get(ns);
        if (!store) return key;
        for (const id of [locale.active, 'en', 'zh']) {
          const entries = store.get(id);
          if (entries && Object.prototype.hasOwnProperty.call(entries, key)) {
            return formatTemplate(entries[key], params);
          }
        }
        return key;
      };
    },
  };
  return locale;
}

/** Fake `ctx.slots`: records injections and registrations. */
function makeSlots() {
  const injected = [];
  const registrations = [];
  return {
    injected,
    registrations,
    inject(name, factory) {
      injected.push(name);
      return factory();
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  };
}

/** Fake client cordis context holding locale + slots + effect recording. */
function makeContext() {
  const locale = makeLocale();
  const slots = makeSlots();
  const effects = [];
  const effectLabels = [];
  const ctx = {
    locale,
    slots,
    effect(factory, label) {
      effects.push(factory());
      effectLabels.push(label);
    },
  };
  return { ctx, locale, slots, effects, effectLabels };
}

/** Apply the module to a fresh fake context; return the section registration. */
function applyBundle(react, context = makeContext()) {
  const module = bundle.definition.factory((id) => {
    assert.equal(id, 'react', 'the bundle may require only react');
    return react;
  });
  module.apply(context.ctx);
  const section = context.slots.registrations.find((entry) => entry.options.name === 'settings.section');
  assert.ok(section, 'a settings.section registration must exist');
  return { module, section, ...context };
}

/** Render one fixture through the registered component (hooks read a queue). */
function renderFixture(status, state) {
  const overrides = state || {};
  const react = makeReact([
    status,
    overrides.loading !== undefined ? overrides.loading : false,
    overrides.error !== undefined ? overrides.error : null,
    overrides.busy !== undefined ? overrides.busy : null,
  ]);
  const { section } = applyBundle(react);
  return section.component({ close() {} });
}

/** Flatten React elements to their visible text (style content excluded). */
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  if (typeof node === 'object') {
    if (node.type === 'style') return '';
    const children = Array.isArray(node.children) ? node.children : [];
    return children.map(textOf).join(' ');
  }
  return '';
}

/** Normalized visible text of a rendered tree. */
function visibleText(tree) {
  return textOf(tree).replace(/\s+/g, ' ').trim();
}

/** Every element in the tree matching a predicate. */
function findAll(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out);
    return out;
  }
  if (predicate(node)) out.push(node);
  const children = Array.isArray(node.children) ? node.children : [];
  for (const child of children) findAll(child, predicate, out);
  return out;
}

/** First button whose visible label contains the given text. */
function findButton(tree, label) {
  return findAll(tree, (node) => node.type === 'button' && visibleText(node).includes(label))[0];
}

/** A Host status body for a signed-out browser with a direct connection. */
function signedOutStatus() {
  return {
    loggedIn: false,
    account: null,
    expiresAt: null,
    refreshExpiresAt: null,
    login: { state: 'idle' },
    models: { count: 0, lastRefreshedAt: null, lastSource: null, error: null, refreshing: false },
    proxy: { direct: true, proxy: null, target: 'api.anthropic.com, platform.claude.com' },
    lastError: null,
  };
}

/** A Host status body for a signed-in browser behind a proxied route. */
function signedInStatus() {
  return {
    loggedIn: true,
    account: { email: 'claude@example.com', plan: 'max' },
    expiresAt: Date.now() + 3_600_000,
    refreshExpiresAt: Date.now() + 86_400_000,
    login: { state: 'idle' },
    models: {
      count: 6,
      lastRefreshedAt: Date.now() - 5 * 60_000,
      lastSource: 'login',
      error: null,
      refreshing: false,
    },
    proxy: { direct: false, proxy: 'http://user:pass@127.0.0.1:7890', target: 'api.anthropic.com, platform.claude.com' },
    lastError: null,
  };
}

/** A Host status body while the browser authorization is pending. */
function pendingStatus() {
  const status = signedOutStatus();
  status.login = { state: 'pending', authUrl: 'https://claude.ai/oauth/authorize?code=abc&state=def' };
  return status;
}

test('client bundle exposes the expected module contract', () => {
  const { definition } = bundle;
  assert.equal(definition.id, 'dsh-claude-oauth');
  assert.equal(typeof definition.factory, 'function');

  const module = definition.factory(() => makeReact([]));
  assert.deepEqual(Array.from(module.inject), ['slots', 'locale']);
  assert.equal(typeof module.apply, 'function');
});

test('apply registers en+zh dictionaries and exactly one settings.section', () => {
  const react = makeReact([]);
  const { locale, slots, effects, effectLabels, module } = applyBundle(react);

  // Locale dictionaries: two ctx.effect-managed registrations, en then zh.
  assert.equal(effects.length, 2);
  assert.ok(effects.every((disposer) => typeof disposer === 'function'));
  assert.deepEqual(locale.locales, ['en', 'zh']);
  const dictionaries = locale.dictionaries.get('claude-oauth');
  assert.ok(dictionaries, 'dictionaries must register under the claude-oauth namespace');
  assert.equal(dictionaries.get('en').title, 'Claude');
  assert.equal(dictionaries.get('zh').title, 'Claude');
  assert.match(dictionaries.get('en').description, /DeepSeek Harness/);
  assert.ok(dictionaries.get('zh').description.length > 0);
  assert.ok(effectLabels.every((label) => typeof label === 'string' && label.includes('dictionary')));

  // Slot wiring: one settings.section, injected through the declaration.
  assert.deepEqual(slots.injected, ['settings.section']);
  const sections = slots.registrations.filter((entry) => entry.options.name === 'settings.section');
  assert.equal(sections.length, 1);
  assert.equal(sections[0].options.id, 'claude-oauth');
  assert.equal(sections[0].options.order, 12);
  assert.equal(typeof sections[0].options.label, 'function');
  assert.equal(typeof sections[0].component, 'function');

  // The label thunk follows the active locale and always resolves a title.
  assert.equal(sections[0].options.label(), 'Claude');
  locale.active = 'zh';
  assert.equal(sections[0].options.label(), 'Claude');
  assert.equal(typeof module.apply, 'function');
});

test('apply falls back to bundled dictionaries when locale.bind throws', () => {
  const react = makeReact([signedOutStatus(), false, null, null]);
  const context = makeContext();
  context.locale.bind = () => {
    throw new Error('locale service unavailable');
  };
  const { section } = applyBundle(react, context);
  assert.equal(typeof section.options.label, 'function');
  assert.equal(section.options.label(), 'Claude');
  assert.equal(visibleText(section.component({ close() {} })).includes('Not signed in'), true);
});

test('signed-out fixture renders the proxy warning, account and model states', () => {
  const tree = renderFixture(signedOutStatus());
  const text = visibleText(tree);

  assert.ok(text.includes('Claude'));
  assert.ok(text.includes('Sign in with a Claude account'));
  assert.ok(text.includes('Network route'));
  assert.ok(text.includes('Direct connection - no proxy configured'));
  assert.ok(text.includes('Not signed in'));
  assert.ok(text.includes('Sign in'));
  assert.ok(text.includes('Models'));
  assert.ok(text.includes('No models loaded'));

  const refresh = findButton(tree, 'Refresh models');
  assert.ok(refresh, 'Refresh models button must render');
  assert.equal(refresh.props.disabled, true, 'Refresh models is disabled while signed out');

  const signIn = findButton(tree, 'Sign in');
  assert.ok(signIn, 'Sign in button must render while signed out');
  assert.equal(signIn.props.disabled, false);

  // No token-shaped host field is ever read or rendered.
  assert.ok(!/sk-ant-|accessToken|refreshToken/i.test(text));
});

test('signed-in fixture renders the account, the redacted proxy and refresh control', () => {
  const tree = renderFixture(signedInStatus());
  const text = visibleText(tree);

  assert.ok(text.includes('claude@example.com'));
  assert.ok(text.includes('Plan: max'));
  assert.ok(!text.includes('Signed in'), 'signed-in rows show the identity instead of a bare label');
  assert.ok(text.includes('6 models'));
  assert.ok(text.includes('Last refreshed'));
  assert.ok(text.includes('Source: sign-in'));
  assert.ok(text.includes('Proxy: http://***@127.0.0.1:7890'));
  assert.ok(text.includes('Target hosts: api.anthropic.com, platform.claude.com'));
  assert.ok(!text.includes('user:pass'), 'proxy credentials must be redacted');

  const refresh = findButton(tree, 'Refresh models');
  assert.ok(refresh);
  assert.equal(refresh.props.disabled, false, 'Refresh models is enabled while signed in and idle');
  assert.ok(findButton(tree, 'Sign out'), 'Sign out button must render while signed in');
});

test('pending-login fixture renders the browser wait, fallback anchor and cancel action', () => {
  const tree = renderFixture(pendingStatus());
  const text = visibleText(tree);

  assert.ok(text.includes('Waiting for browser...'));
  assert.ok(text.includes('Sign in'), 'the account row keeps its sign-in action');

  const anchors = findAll(tree, (node) => node.type === 'a');
  assert.equal(anchors.length, 1);
  assert.equal(anchors[0].props.href, 'https://claude.ai/oauth/authorize?code=abc&state=def');
  assert.equal(anchors[0].props.target, '_blank');
  assert.match(anchors[0].props.rel, /noopener/);

  const cancel = findButton(tree, 'Cancel');
  assert.ok(cancel, 'Cancel button must render while pending');
  assert.equal(cancel.props.disabled, false);

  const refresh = findButton(tree, 'Refresh models');
  assert.equal(refresh.props.disabled, true, 'Refresh models is disabled while login is pending');

  const signIn = findButton(tree, 'Sign in');
  assert.equal(signIn.props.disabled, true, 'Sign in is disabled while a login is already pending');
});

test('first load renders a loading state', () => {
  const tree = renderFixture(null, { loading: true });
  const text = visibleText(tree);
  assert.ok(text.includes('Loading Claude settings...'));
  assert.ok(text.includes('Claude'));
});

test('a failed first load renders the Web-GUI error state with a retry action', () => {
  const tree = renderFixture(null, { error: 'Host rejected the request.' });
  const text = visibleText(tree);
  assert.ok(text.includes('Could not load Claude settings from the Host.'));
  assert.ok(text.includes('Host rejected the request.'));
  assert.ok(text.includes('DeepSeek Harness Web GUI'));
  assert.ok(findButton(tree, 'Retry'), 'Retry button must render in the error state');
});

test('a failed action shows an inline error next to the rows', () => {
  const tree = renderFixture(signedOutStatus(), { error: 'Refresh failed safely.' });
  const text = visibleText(tree);
  assert.ok(text.includes('Refresh failed safely.'));
  assert.ok(text.includes('Request failed'));
  assert.ok(text.includes('Not signed in'), 'rows stay rendered after an action error');
});

test('the component tolerates a minimal status body without throwing', () => {
  const tree = renderFixture({ loggedIn: false });
  const text = visibleText(tree);
  assert.ok(text.includes('Not signed in'));
  assert.ok(text.includes('Claude'));
});

test('sign-in click POSTs exactly the documented status action contract', async () => {
  const calls = [];
  bundle.sandbox.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, status: pendingStatus() }) };
  };
  try {
    const tree = renderFixture(signedOutStatus());
    const signIn = findButton(tree, 'Sign in');
    await signIn.props.onClick();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/claude-oauth');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.credentials, 'same-origin');
    assert.equal(calls[0].init.headers['content-type'], 'application/json');
    assert.equal(calls[0].init.body, JSON.stringify({ action: 'login' }));
  } finally {
    bundle.sandbox.fetch = () => {
      throw new Error('unexpected fetch() during this test');
    };
  }
});

test('refresh-models click POSTs the refresh-models action', async () => {
  const calls = [];
  bundle.sandbox.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ ok: true, status: signedInStatus() }) };
  };
  try {
    const tree = renderFixture(signedInStatus());
    const refresh = findButton(tree, 'Refresh models');
    await refresh.props.onClick();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, '/api/claude-oauth');
    assert.equal(JSON.parse(calls[0].init.body).action, 'refresh-models');
  } finally {
    bundle.sandbox.fetch = () => {
      throw new Error('unexpected fetch() during this test');
    };
  }
});
