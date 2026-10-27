/**
 * Hand-rolled durable file helpers for the plugin's private data directory.
 *
 * The token file is a secret, so every write is a same-directory temp file
 * followed by an atomic rename, the file is created with mode 0600, and the
 * containing directory is 0700. A cross-process lock file protects the
 * single-use refresh token; the lock is a directory-free `O_EXCL` file with a
 * stale-holder takeover, which is enough for one desktop host plus an
 * occasional CLI process without a dependency.
 */
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** The Harness home this process was launched against, or `~/.dsh`. */
export function dshHome() {
  const configured = process.env.DSH_HOME?.trim();
  if (configured !== undefined && configured !== '') return configured;
  return join(homedir(), '.dsh');
}

/** Private data directory: `$DSH_HOME/claude-oauth`. */
export function pluginDataDir() {
  return join(dshHome(), 'claude-oauth');
}

/** Create (or tighten) a directory that holds secrets. */
export async function ensurePrivateDir(dir = pluginDataDir()) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await chmod(dir, 0o700);
  } catch {
    // A filesystem without POSIX modes is not an error here.
  }
}

/**
 * Read and parse one JSON file.
 * @returns the parsed value, or `undefined` when the file does not exist.
 * @throws {SyntaxError} when the file exists but is not valid JSON.
 */
export async function readJsonFile(path) {
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
  return JSON.parse(text);
}

/** Write one JSON file atomically with restrictive permissions. */
export async function writeJsonFile(path, value, { mode = 0o600 } = {}) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode, flag: 'w' });
    await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Remove a file if present. */
export async function removeFile(path) {
  await rm(path, { force: true });
}

/** Current mtime of a path in milliseconds, or `undefined` when absent. */
async function mtimeOf(path) {
  try {
    return (await stat(path)).mtimeMs;
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * Run `operation` while holding an exclusive cross-process lock file.
 * @template T
 * @param {string} lockPath
 * @param {() => Promise<T>} operation
 * @param {{ timeoutMs?: number, staleMs?: number, pollMs?: number }} [options]
 * @returns {Promise<T>}
 */
export async function withFileLock(lockPath, operation, options = {}) {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 30000;
  const pollMs = options.pollMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  let handle;
  for (;;) {
    try {
      handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(`${process.pid} ${Date.now()}\n`);
      break;
    } catch (error) {
      if (error === null || typeof error !== 'object' || error.code !== 'EEXIST') throw error;
      const mtime = await mtimeOf(lockPath);
      if (mtime !== undefined && Date.now() - mtime > staleMs) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for lock ${lockPath}`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try {
    return await operation();
  } finally {
    await handle.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
  }
}
