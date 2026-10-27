/**
 * Typed host-plugin failures. Every consumer routes on `code`, never on the
 * message text; messages are user-visible and must never contain secrets.
 */
export class PluginError extends Error {
  /**
   * @param {string} code stable machine-readable code
   * @param {string} message safe, human-readable text
   * @param {Record<string, unknown>} [details] structured, non-secret detail
   * @param {{ cause?: unknown }} [options]
   */
  constructor(code, message, details = {}, options) {
    super(message, options);
    this.name = 'PluginError';
    this.code = code;
    this.details = details;
  }
}

/** Whether `error` is a PluginError, optionally of one exact code. */
export function isPluginError(error, code) {
  return error instanceof PluginError && (code === undefined || error.code === code);
}

/** A short, safe description for logs and JSON responses. */
export function messageOf(error) {
  if (error instanceof Error) {
    const code = typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined;
    return code === undefined ? error.message : `${error.message} (${code})`;
  }
  return String(error);
}

/** Remove `user:password@` from a URL string before it is displayed. */
export function redactUrl(value) {
  if (typeof value !== 'string') return value;
  try {
    const url = new URL(value);
    if (url.username === '' && url.password === '') return value;
    url.username = url.username === '' ? '' : '***';
    url.password = url.password === '' ? '' : '***';
    return url.toString();
  } catch {
    return value;
  }
}
