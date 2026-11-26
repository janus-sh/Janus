/**
 * The ranked list of free models: the copy in the package, the copy cached
 * in the agent folder, and the download that refreshes the cache.
 *
 * Start-up never waits for the download: the cached or bundled list is used
 * at once, the download runs in the background (up to LIST_TIMEOUT_MS, long
 * enough for a slow connection) and the fresh list applies to the next
 * request once it arrives.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { saveText } from './store.mjs';

export const LIST_MAX_AGE_MS = 12 * 3_600_000;
// Measured 2026-11-26: the list took 3.7-3.9 s on a slow connection, so the
// old 3 s cut it off and the client stayed on the bundled list.
export const LIST_TIMEOUT_MS = 10_000;

export function parseList(text) {
  try {
    const list = JSON.parse(text);
    return Array.isArray(list?.models) && list.models.every((m) => m?.provider && m?.id) ? list : null;
  } catch {
    return null;
  }
}

export function readList(path) {
  try {
    return parseList(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * True when `fresh` should replace `current`: only a strictly newer date.
 * On the same day the list shipped with the package wins, because the
 * download can carry today's date over picks that are not updated yet.
 */
export const isNewer = (fresh, current) => !current || String(fresh?.updated ?? '') > String(current.updated ?? '');

/** The bundled list or the cached one, whichever is newer, and which it was. */
export function loadList({ bundledPath, cachePath }) {
  const bundled = readList(bundledPath);
  const cached = readList(cachePath);
  if (cached && isNewer(cached, bundled)) return { list: cached, source: 'cached' };
  return { list: bundled, source: bundled ? 'bundled' : 'none' };
}

/**
 * Download the list into the cache unless the cache is fresh. Resolves to
 * { list, source: 'downloaded' }, or null when there is nothing new (fresh
 * cache, slow beyond the timeout, offline, a broken answer, or `signal`
 * aborted because the session ended).
 */
export async function downloadList({ url, cachePath, maxAgeMs = LIST_MAX_AGE_MS, timeoutMs = LIST_TIMEOUT_MS, fetchFn = fetch, signal }) {
  try {
    if (existsSync(cachePath) && Date.now() - statSync(cachePath).mtimeMs < maxAgeMs) return null;
    const timeout = AbortSignal.timeout(timeoutMs);
    const res = await fetchFn(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) return null;
    const text = await res.text();
    const list = parseList(text);
    if (!list) return null; // checked before it touches the disk
    try {
      saveText(cachePath, text); // no free-models.json.tmp left behind, even when the write fails
    } catch {} // a folder closed for writing: use the list without a cache
    return { list, source: 'downloaded' };
  } catch {
    return null;
  }
}
