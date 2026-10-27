/**
 * Client (browser) half of the dsh-claude-oauth bundle.
 *
 * This file is a plain browser module: no build step, no imports, and only
 * `react` is required. It contributes one `settings.section` page to the
 * DeepSeek Harness Web GUI that signs a Claude account in/out and refreshes
 * the Claude model catalog through the Host's authenticated route.
 *
 * The page never receives token material: the Host route exposes only
 * `loggedIn`/`account`/`models`/`proxy` metadata, and the UI renders that
 * metadata as React text (never as HTML).
 */
window.__ModuleLoader__.load({
  id: 'dsh-claude-oauth',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    /** Locale namespace and slot ids owned by this plugin. */
    const NS = 'claude-oauth';
    const SECTION_ID = 'claude-oauth';
    const SECTION_ORDER = 12;

    /** The Host's authenticated browser route and its polling cadence. */
    const API_PATH = '/api/claude-oauth';
    const POLL_INTERVAL_MS = 1500;
    const ERROR_TEXT_MAX = 400;
    const PROXY_TEXT_MAX = 300;

    // ------------------------------------------------------------------
    // Dictionaries. `t` is derived from ctx.locale.bind(NS); when the real
    // translator returns the key (or bind is unavailable) these dictionaries
    // are the fallback, so the label thunk always resolves a title.
    // ------------------------------------------------------------------

    const EN = Object.freeze({
      title: 'Claude',
      description: 'Sign in with a Claude account and register Claude models in DeepSeek Harness.',
      loading: 'Loading Claude settings...',
      loadFailed: 'Could not load Claude settings from the Host.',
      webGuiHint: 'This settings page works in the DeepSeek Harness Web GUI.',
      retry: 'Retry',
      networkRoute: 'Network route',
      proxyLabel: 'Proxy',
      targetLabel: 'Target hosts',
      directConnection: 'Direct connection - no proxy configured',
      directHint: 'Claude requests leave this machine without a proxy.',
      account: 'Account',
      notSignedIn: 'Not signed in',
      signedIn: 'Signed in',
      planValue: 'Plan: {plan}',
      signIn: 'Sign in',
      signingIn: 'Signing in...',
      signOut: 'Sign out',
      signingOut: 'Signing out...',
      waitingForBrowser: 'Waiting for browser...',
      loginHint: 'Finish signing in to Claude in the browser window that just opened. This page updates automatically.',
      openSignInPage: 'Open the sign-in page',
      cancel: 'Cancel',
      cancelling: 'Cancelling...',
      models: 'Models',
      modelCount: '{count} models',
      modelCountOne: '1 model',
      noModels: 'No models loaded',
      lastRefreshed: 'Last refreshed {time}',
      neverRefreshed: 'never refreshed',
      source: 'Source: {source}',
      sourceLogin: 'sign-in',
      sourceManual: 'manual refresh',
      sourceCache: 'cached list',
      sourceDefault: 'built-in list',
      modelsError: 'Model list error: {message}',
      refreshModels: 'Refresh models',
      refreshing: 'Refreshing...',
      lastErrorTitle: 'Last error',
      requestFailed: 'Request failed',
      connectFailed: 'Could not reach the Claude OAuth service in this browser.',
      badResponse: 'The Claude OAuth service returned an unexpected response.',
      justNow: 'just now',
      minutesAgo: '{count} min ago',
      hoursAgo: '{count} h ago',
      daysAgo: '{count} d ago',
    });

    const ZH = Object.freeze({
      title: 'Claude',
      description: '使用 Claude 账号登录，并在 DeepSeek Harness 中注册 Claude 模型。',
      loading: '正在加载 Claude 设置...',
      loadFailed: '无法从 Host 加载 Claude 设置。',
      webGuiHint: '此设置页面仅适用于 DeepSeek Harness Web GUI。',
      retry: '重试',
      networkRoute: '网络路由',
      proxyLabel: '代理',
      targetLabel: '目标主机',
      directConnection: '直连 - 未配置代理',
      directHint: 'Claude 请求将不使用代理直接发出。',
      account: '账号',
      notSignedIn: '未登录',
      signedIn: '已登录',
      planValue: '套餐：{plan}',
      signIn: '登录',
      signingIn: '正在登录...',
      signOut: '退出登录',
      signingOut: '正在退出...',
      waitingForBrowser: '等待浏览器完成登录...',
      loginHint: '请在弹出的浏览器窗口中完成 Claude 登录，此页面会自动更新。',
      openSignInPage: '打开登录页面',
      cancel: '取消',
      cancelling: '正在取消...',
      models: '模型',
      modelCount: '{count} 个模型',
      modelCountOne: '1 个模型',
      noModels: '暂无已加载模型',
      lastRefreshed: '上次刷新：{time}',
      neverRefreshed: '从未刷新',
      source: '来源：{source}',
      sourceLogin: '登录后自动获取',
      sourceManual: '手动刷新',
      sourceCache: '缓存列表',
      sourceDefault: '内置列表',
      modelsError: '模型列表错误：{message}',
      refreshModels: '刷新模型',
      refreshing: '正在刷新...',
      lastErrorTitle: '上次错误',
      requestFailed: '请求失败',
      connectFailed: '当前浏览器无法访问 Claude OAuth 服务。',
      badResponse: 'Claude OAuth 服务返回了意外响应。',
      justNow: '刚刚',
      minutesAgo: '{count} 分钟前',
      hoursAgo: '{count} 小时前',
      daysAgo: '{count} 天前',
    });

    // ------------------------------------------------------------------
    // Small helpers. Everything renders through React text nodes, so no
    // host-provided string can become markup.
    // ------------------------------------------------------------------

    /** The browser locale used only by the local fallback translator. */
    function detectLocale() {
      try {
        const language = typeof navigator !== 'undefined' && navigator && typeof navigator.language === 'string' ? navigator.language : '';
        return language.toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
      } catch {
        return 'en';
      }
    }

    /** Replace `{name}` placeholders with params; unknown placeholders stay. */
    function formatMessage(template, params) {
      if (typeof template !== 'string') return '';
      if (!params) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
      );
    }

    /** The dictionary the fallback translator reads before any bind exists. */
    function localDictionary() {
      return detectLocale() === 'zh' ? ZH : EN;
    }

    /** Local dictionary lookup with an English backstop. */
    function fallbackTranslate(key, params) {
      const dict = localDictionary();
      const template = Object.prototype.hasOwnProperty.call(dict, key)
        ? dict[key]
        : Object.prototype.hasOwnProperty.call(EN, key)
          ? EN[key]
          : key;
      return formatMessage(template, params);
    }

    /**
     * Derive the section translator from the locale service. `bind` can throw
     * when the service refuses a namespace; in that case fall back to the
     * bundled dictionaries instead of failing the whole plugin.
     */
    function createTranslator(locale) {
      let bound = null;
      if (locale && typeof locale.bind === 'function') {
        try {
          const candidate = locale.bind(NS);
          if (typeof candidate === 'function') bound = candidate;
        } catch {
          bound = null;
        }
      }
      return function t(key, params) {
        if (bound !== null) {
          try {
            const value = bound(key, params);
            if (typeof value === 'string' && value !== key) return value;
          } catch {
            // A translator failure must not break rendering; use the dictionary.
          }
        }
        return fallbackTranslate(key, params);
      };
    }

    /** Strip control characters and cap length before rendering host text. */
    function sanitizeText(value, maxLength) {
      if (typeof value !== 'string') return '';
      const limit = Number.isFinite(maxLength) && maxLength > 0 ? maxLength : ERROR_TEXT_MAX;
      let text = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length > limit) text = `${text.slice(0, limit - 1)}…`;
      return text;
    }

    /** Hide credentials that a proxy URL may carry before showing it. */
    function redactProxyUrl(value) {
      const text = sanitizeText(value, PROXY_TEXT_MAX);
      if (text === '') return '';
      return text.replace(/\/\/[^/@\s]+@/g, '//***@');
    }

    /** True only for plain JSON objects (never arrays or null). */
    function isObject(value) {
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    }

    /** Human relative time for `models.lastRefreshedAt`. */
    function formatRelativeTime(timestamp, t) {
      if (!Number.isFinite(timestamp)) return t('neverRefreshed');
      const diff = Date.now() - timestamp;
      if (diff < 60_000) return t('justNow');
      const minutes = Math.floor(diff / 60_000);
      if (minutes < 60) return t('minutesAgo', { count: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('hoursAgo', { count: hours });
      return t('daysAgo', { count: Math.floor(hours / 24) });
    }

    /** Localized label for the Host-reported catalog source. */
    function sourceLabel(source, t) {
      if (source === 'login') return t('sourceLogin');
      if (source === 'manual') return t('sourceManual');
      if (source === 'cache') return t('sourceCache');
      if (source === 'default') return t('sourceDefault');
      return '';
    }

    /** Only http(s) authorization URLs become anchors. */
    function isSafeAuthUrl(value) {
      return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
    }

    // ------------------------------------------------------------------
    // Presentation. The settings shell already owns the dialog chrome; this
    // section renders its own heading, rows, and states inside the content
    // column, with host design tokens and literal fallbacks.
    // ------------------------------------------------------------------

    const CSS = `
.dshc-oauth-section {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: var(--dsw-alias-label-primary, #e6e7ec);
}

.dshc-oauth-heading {
  margin: 0 0 4px;
  font-size: 18px;
  line-height: 26px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary, #e6e7ec);
}

.dshc-oauth-description {
  margin: 0 0 20px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #a8abb5);
}

.dshc-oauth-rows {
  display: flex;
  flex-direction: column;
  border-top: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
}

.dshc-oauth-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.12));
}

.dshc-oauth-row-main {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.dshc-oauth-row-title {
  font-size: 14px;
  line-height: 20px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary, #e6e7ec);
}

.dshc-oauth-row-value {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #a8abb5);
  overflow-wrap: anywhere;
}

.dshc-oauth-row-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
}

.dshc-oauth-button {
  appearance: none;
  box-sizing: border-box;
  min-height: 30px;
  padding: 5px 12px;
  border: 1px solid var(--dsw-alias-border-l2, rgba(255, 255, 255, 0.14));
  border-radius: 8px;
  background: var(--dsw-alias-interactive-bg, rgba(255, 255, 255, 0.04));
  color: var(--dsw-alias-label-primary, #e6e7ec);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  cursor: pointer;
  white-space: nowrap;
  transition: background 0.15s ease, border-color 0.15s ease;
}

.dshc-oauth-button:hover:not(:disabled) {
  background: var(--dsw-alias-interactive-bg-hover, rgba(255, 255, 255, 0.08));
  border-color: var(--dsw-alias-border-l1, rgba(255, 255, 255, 0.22));
}

.dshc-oauth-button:focus-visible {
  outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-brand-primary, #4d6bfe));
  outline-offset: 2px;
}

.dshc-oauth-button:disabled {
  opacity: 0.5;
  cursor: default;
}

.dshc-oauth-button-primary {
  border-color: transparent;
  background: var(--dsw-alias-button-primary-fill, #4d6bfe);
  color: var(--dsw-alias-label-primary-foreground, #ffffff);
}

.dshc-oauth-button-primary:hover:not(:disabled) {
  background: var(--dsw-alias-button-primary-hover, #5f7bff);
  border-color: transparent;
}

.dshc-oauth-button-inline {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}

.dshc-oauth-warning {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 8px;
  border: 1px solid var(--dsw-alias-state-warn-primary, #f59e0b);
  border-radius: 6px;
  background: rgba(245, 158, 11, 0.1);
  color: var(--dsw-alias-state-warn-label, #f5c451);
  font-size: 13px;
  line-height: 18px;
}

.dshc-oauth-warning-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--dsw-alias-state-warn-primary, #f59e0b);
}

.dshc-oauth-mono {
  font-family: var(--dsw-font-markdown-code-font-family, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace);
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-primary, #e6e7ec);
  overflow-wrap: anywhere;
}

.dshc-oauth-sub {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-tertiary, #7c7f8a);
}

.dshc-oauth-error {
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-error, #ff7b7b);
  overflow-wrap: anywhere;
}

.dshc-oauth-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-state-warn-primary, rgba(245, 158, 11, 0.6));
  border-radius: 10px;
  background: rgba(245, 158, 11, 0.08);
}

.dshc-oauth-panel-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  line-height: 20px;
  font-weight: 600;
  color: var(--dsw-alias-state-warn-label, #f5c451);
}

.dshc-oauth-error-box {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 16px;
  padding: 12px 14px;
  border: 1px solid var(--dsw-alias-state-error-primary, rgba(244, 63, 94, 0.55));
  border-radius: 10px;
  background: rgba(244, 63, 94, 0.08);
}

.dshc-oauth-anchor {
  color: var(--dsw-alias-link, #6ea8fe);
  font-size: 13px;
  line-height: 20px;
  text-decoration: underline;
  text-underline-offset: 2px;
  overflow-wrap: anywhere;
}

.dshc-oauth-loading {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 28px 0;
  font-size: 13px;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary, #a8abb5);
}

.dshc-oauth-spinner {
  flex: none;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.18);
  border-top-color: var(--dsw-alias-brand-primary, #4d6bfe);
  border-radius: 50%;
  animation: dshc-oauth-spin 0.8s linear infinite;
}

@keyframes dshc-oauth-spin {
  to { transform: rotate(360deg); }
}
`;

    /** One labeled settings row with an optional action cluster. */
    function renderRow(key, title, valueNodes, actionNodes) {
      return h(
        'div',
        { key, className: 'dshc-oauth-row' },
        h(
          'div',
          { className: 'dshc-oauth-row-main' },
          h('div', { className: 'dshc-oauth-row-title' }, title),
          h('div', { className: 'dshc-oauth-row-value' }, valueNodes),
        ),
        actionNodes ? h('div', { className: 'dshc-oauth-row-actions' }, actionNodes) : null,
      );
    }

    /** A button that reports its own in-flight/busy copy. */
    function renderButton(key, label, onClick, options) {
      const settings = options || {};
      return h(
        'button',
        {
          key,
          type: 'button',
          className: `dshc-oauth-button${settings.primary ? ' dshc-oauth-button-primary' : ''}${settings.busy ? ' dshc-oauth-button-inline' : ''}`,
          disabled: settings.disabled === true,
          onClick,
        },
        settings.busy ? h('span', { key: 'spinner', className: 'dshc-oauth-spinner' }) : null,
        h('span', { key: 'label' }, label),
      );
    }

    /**
     * Build the settings section component for one translator.
     * @param t localized translator.
     * @returns React component receiving `{ close }` from the settings shell.
     */
    function makeClaudeSettings(t) {
      return function ClaudeSettings() {
        const [status, setStatus] = React.useState(null);
        const [loading, setLoading] = React.useState(true);
        const [error, setError] = React.useState(null);
        const [busy, setBusy] = React.useState(null);

        const pending = Boolean(status && isObject(status.login) && status.login.state === 'pending');
        const inFlight = typeof busy === 'string' && busy !== '';
        const signedIn = Boolean(status && status.loggedIn === true);
        const models = status && isObject(status.models) ? status.models : {};
        const proxy = status && isObject(status.proxy) ? status.proxy : null;
        const refreshing = models.refreshing === true || busy === 'refresh-models';

        /** POST one action to the Host route and decode its JSON body. */
        async function post(action) {
          const response = await fetch(API_PATH, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ action }),
          });
          let payload = null;
          try {
            payload = await response.json();
          } catch {
            payload = null;
          }
          if (!isObject(payload)) {
            return { ok: false, error: { message: t('badResponse') } };
          }
          return payload;
        }

        /** Safe inline text for a failed `{ ok:false, error }` response. */
        function payloadErrorText(payload) {
          if (isObject(payload) && isObject(payload.error) && typeof payload.error.message === 'string') {
            const text = sanitizeText(payload.error.message);
            if (text !== '') return text;
          }
          if (isObject(payload) && typeof payload.message === 'string') {
            const text = sanitizeText(payload.message);
            if (text !== '') return text;
          }
          return t('badResponse');
        }

        /** Adopt a status payload, falling back to an inline error. */
        function adopt(payload) {
          if (isObject(payload) && payload.ok === true && isObject(payload.status)) {
            setStatus(payload.status);
            setError(null);
            return;
          }
          setError(payloadErrorText(payload));
        }

        /** Re-read status; used by the first load, retry and the 1500ms poll. */
        async function refreshStatus() {
          try {
            adopt(await post('status'));
          } catch {
            setError(t('connectFailed'));
          }
        }

        /** Run one user action, disabling its button while it is in flight. */
        async function runAction(action) {
          if (inFlight) return;
          setBusy(action);
          setError(null);
          try {
            adopt(await post(action));
          } catch {
            setError(t('connectFailed'));
          } finally {
            setBusy(null);
          }
        }

        // First load: exactly one status read when the page first mounts.
        React.useEffect(() => {
          let alive = true;
          (async () => {
            try {
              const payload = await post('status');
              if (!alive) return;
              adopt(payload);
            } catch {
              if (alive) setError(t('connectFailed'));
            } finally {
              if (alive) setLoading(false);
            }
          })();
          return () => {
            alive = false;
          };
          // The component mounts once; later reads go through the poll/actions.
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, []);

        // Poll while a browser login is pending; cleanup covers unmount and
        // the pending -> idle transition.
        React.useEffect(() => {
          if (!pending) return undefined;
          const interval = setInterval(() => {
            void refreshStatus();
          }, POLL_INTERVAL_MS);
          return () => clearInterval(interval);
          // eslint-disable-next-line react-hooks/exhaustive-deps
        }, [pending]);

        // ---- Render helpers (plain closures; hook order above is fixed) ----

        function networkRow() {
          if (proxy === null) {
            return renderRow('network', t('networkRoute'), h('div', { key: 'unknown' }, t('loadFailed')), null);
          }
          if (proxy.direct === true) {
            return renderRow(
              'network',
              t('networkRoute'),
              [
                h(
                  'span',
                  { key: 'direct', className: 'dshc-oauth-warning' },
                  h('span', { key: 'dot', className: 'dshc-oauth-warning-dot' }),
                  h('span', { key: 'text' }, t('directConnection')),
                ),
                h('div', { key: 'hint', className: 'dshc-oauth-sub' }, t('directHint')),
              ],
              null,
            );
          }
          const valueNodes = [];
          const proxyText = redactProxyUrl(proxy.proxy);
          if (proxyText !== '') {
            valueNodes.push(
              h(
                'div',
                { key: 'proxy' },
                h('span', { className: 'dshc-oauth-sub' }, `${t('proxyLabel')}: `),
                h('span', { className: 'dshc-oauth-mono' }, proxyText),
              ),
            );
          }
          const targetText = sanitizeText(proxy.target);
          if (targetText !== '') {
            valueNodes.push(
              h(
                'div',
                { key: 'target' },
                h('span', { className: 'dshc-oauth-sub' }, `${t('targetLabel')}: `),
                h('span', { className: 'dshc-oauth-mono' }, targetText),
              ),
            );
          }
          if (valueNodes.length === 0) valueNodes.push(h('div', { key: 'none' }, t('directHint')));
          return renderRow('network', t('networkRoute'), valueNodes, null);
        }

        function accountRow() {
          const account = isObject(status.account) ? status.account : null;
          const email = sanitizeText(account && account.email, 200);
          const plan = sanitizeText(account && account.plan, 80);
          const valueNodes = [];
          if (signedIn) {
            if (email !== '') valueNodes.push(h('div', { key: 'email' }, email));
            if (plan !== '') {
              valueNodes.push(h('div', { key: 'plan', className: 'dshc-oauth-sub' }, t('planValue', { plan })));
            }
            if (valueNodes.length === 0) valueNodes.push(h('div', { key: 'signedin' }, t('signedIn')));
          } else {
            valueNodes.push(h('div', { key: 'signedout' }, t('notSignedIn')));
          }

          const actions = [];
          if (signedIn) {
            actions.push(
              renderButton('signout', busy === 'logout' ? t('signingOut') : t('signOut'), () => runAction('logout'), {
                disabled: inFlight,
              }),
            );
          } else {
            actions.push(
              renderButton(
                'signin',
                busy === 'login' ? t('signingIn') : t('signIn'),
                () => runAction('login'),
                { disabled: inFlight || pending, primary: true, busy: busy === 'login' },
              ),
            );
          }
          return renderRow('account', t('account'), valueNodes, actions);
        }

        function pendingPanel() {
          const authUrl = isObject(status.login) && typeof status.login.authUrl === 'string' ? status.login.authUrl.trim() : '';
          const children = [
            h(
              'div',
              { key: 'title', className: 'dshc-oauth-panel-title' },
              h('span', { key: 'label' }, t('waitingForBrowser')),
              h('span', { key: 'spinner', className: 'dshc-oauth-spinner' }),
            ),
            h('div', { key: 'hint', className: 'dshc-oauth-sub' }, t('loginHint')),
          ];
          if (isSafeAuthUrl(authUrl)) {
            children.push(
              h(
                'a',
                {
                  key: 'link',
                  className: 'dshc-oauth-anchor',
                  href: authUrl,
                  target: '_blank',
                  rel: 'noopener noreferrer',
                },
                t('openSignInPage'),
              ),
            );
          }
          children.push(
            h(
              'div',
              { key: 'actions', className: 'dshc-oauth-row-actions' },
              renderButton(
                'cancel',
                busy === 'cancel-login' ? t('cancelling') : t('cancel'),
                () => runAction('cancel-login'),
                { disabled: busy === 'cancel-login' },
              ),
            ),
          );
          return h('div', { key: 'pending', className: 'dshc-oauth-panel' }, children);
        }

        function modelsRow() {
          const count = Number.isFinite(models.count) && models.count > 0 ? Math.floor(models.count) : 0;
          const valueNodes = [];
          if (count > 0) {
            valueNodes.push(
              h('div', { key: 'count' }, count === 1 ? t('modelCountOne') : t('modelCount', { count })),
            );
            valueNodes.push(
              h(
                'div',
                { key: 'refreshed', className: 'dshc-oauth-sub' },
                t('lastRefreshed', { time: formatRelativeTime(models.lastRefreshedAt, t) }),
              ),
            );
            const source = sourceLabel(models.lastSource, t);
            if (source !== '') {
              valueNodes.push(
                h('div', { key: 'source', className: 'dshc-oauth-sub' }, t('source', { source })),
              );
            }
          } else {
            valueNodes.push(h('div', { key: 'empty' }, t('noModels')));
          }
          const modelError = sanitizeText(models.error);
          if (modelError !== '') {
            valueNodes.push(
              h('div', { key: 'error', className: 'dshc-oauth-error' }, t('modelsError', { message: modelError })),
            );
          }
          return renderRow(
            'models',
            t('models'),
            valueNodes,
            renderButton(
              'refresh',
              refreshing ? t('refreshing') : t('refreshModels'),
              () => runAction('refresh-models'),
              {
                disabled: !signedIn || refreshing || pending || inFlight,
                busy: refreshing,
              },
            ),
          );
        }

        function errorBoxes() {
          const boxes = [];
          if (error !== null) {
            boxes.push(
              h(
                'div',
                { key: 'request-error', className: 'dshc-oauth-error-box' },
                h('div', { key: 'title', className: 'dshc-oauth-row-title' }, t('requestFailed')),
                h('div', { key: 'message', className: 'dshc-oauth-error' }, error),
              ),
            );
          }
          const lastError = sanitizeText(status.lastError);
          if (lastError !== '') {
            boxes.push(
              h(
                'div',
                { key: 'host-error', className: 'dshc-oauth-error-box' },
                h('div', { key: 'title', className: 'dshc-oauth-row-title' }, t('lastErrorTitle')),
                h('div', { key: 'message', className: 'dshc-oauth-error' }, lastError),
              ),
            );
          }
          return boxes;
        }

        const body = [];
        if (loading === true && status === null) {
          body.push(
            h(
              'div',
              { key: 'loading', className: 'dshc-oauth-loading' },
              h('span', { key: 'spinner', className: 'dshc-oauth-spinner' }),
              h('span', { key: 'label' }, t('loading')),
            ),
          );
        } else if (status === null) {
          const children = [
            h('div', { key: 'title', className: 'dshc-oauth-row-title' }, t('loadFailed')),
            h('div', { key: 'message', className: 'dshc-oauth-error' }, error !== null ? error : t('badResponse')),
            h('div', { key: 'hint', className: 'dshc-oauth-sub' }, t('webGuiHint')),
            h(
              'div',
              { key: 'actions', className: 'dshc-oauth-row-actions' },
              renderButton('retry', t('retry'), () => runAction('status'), { disabled: inFlight }),
            ),
          ];
          body.push(h('div', { key: 'load-error', className: 'dshc-oauth-error-box' }, children));
        } else {
          body.push(h('div', { key: 'rows', className: 'dshc-oauth-rows' }, networkRow(), accountRow(), modelsRow()));
          if (pending) body.push(pendingPanel());
          for (const box of errorBoxes()) body.push(box);
        }

        return h(
          'section',
          { className: 'dshc-oauth-section', 'aria-busy': loading === true && status === null ? 'true' : undefined },
          h('style', { key: 'styles' }, CSS),
          h('h3', { key: 'heading', className: 'dshc-oauth-heading' }, t('title')),
          h('p', { key: 'description', className: 'dshc-oauth-description' }, t('description')),
          body,
        );
      };
    }

    // ------------------------------------------------------------------
    // Plugin registration.
    // ------------------------------------------------------------------

    /**
     * Register the settings page and its dictionaries.
     * @param ctx client cordis context with the `locale` and `slots` services.
     */
    function apply(ctx) {
      if (!ctx) return;
      const locale = ctx.locale;
      const slots = ctx.slots;

      /** Run a registration through ctx.effect when available. */
      function track(factory, label) {
        if (typeof ctx.effect === 'function') {
          try {
            ctx.effect(factory, label);
            return;
          } catch {
            // Fall through to an unmanaged registration.
          }
        }
        try {
          factory();
        } catch {
          // A missing locale service must not abort the settings registration.
        }
      }

      if (locale && typeof locale.register === 'function') {
        track(() => locale.register(NS, 'en', EN), 'claude-oauth: en dictionary');
        track(() => locale.register(NS, 'zh', ZH), 'claude-oauth: zh dictionary');
      }

      const t = createTranslator(locale);
      const ClaudeSettings = makeClaudeSettings(t);

      if (slots && typeof slots.inject === 'function' && typeof slots.register === 'function') {
        slots.inject('settings.section', () =>
          slots.register(
            {
              name: 'settings.section',
              id: SECTION_ID,
              order: SECTION_ORDER,
              // The real slot runtime re-renders locale-bound entries; the
              // label thunk stays correct either way because it closes over t.
              locale: NS,
              label: () => t('title'),
            },
            ClaudeSettings,
          ),
        );
      }
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
