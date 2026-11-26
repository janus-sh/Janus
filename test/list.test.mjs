import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadList, LIST_TIMEOUT_MS, LIST_URL, listUrl, loadList } from '../lib/list.mjs';

const LIST = (updated) => JSON.stringify({ updated, models: [{ provider: 'openrouter', id: 'a:free' }] });
const folder = () => {
  const dir = mkdtempSync(join(tmpdir(), 'janus-list-'));
  const paths = { bundledPath: join(dir, 'bundled.json'), cachePath: join(dir, 'cache.json') };
  writeFileSync(paths.bundledPath, LIST('2026-11-26'));
  return paths;
};
// a fetch that answers after `ms`, and gives up when its signal fires, like the real one
const slowFetch = (ms, body = LIST('2026-11-27')) => (_url, { signal }) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => resolve({ ok: true, text: async () => body }), ms);
    signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(signal.reason);
    });
  });

test('the download gets enough time for a slow connection (measured 3.7-3.9 s)', () => {
  assert.ok(LIST_TIMEOUT_MS >= 10_000);
});

test('a slow download still lands and is cached', async () => {
  const p = folder();
  const got = await downloadList({ url: 'x', cachePath: p.cachePath, timeoutMs: 1000, fetchFn: slowFetch(150) });
  assert.equal(got.source, 'downloaded');
  assert.equal(got.list.updated, '2026-11-27');
  assert.equal(JSON.parse(readFileSync(p.cachePath, 'utf8')).updated, '2026-11-27');
  assert.deepEqual(loadList(p), { list: got.list, source: 'cached' });
});

test('a failed, broken or too slow download keeps the current list', async () => {
  const p = folder();
  const fails = [
    async () => {
      throw new Error('offline');
    },
    async () => ({ ok: false }),
    async () => ({ ok: true, text: async () => '<html>' }),
  ];
  for (const fetchFn of fails) assert.equal(await downloadList({ url: 'x', cachePath: p.cachePath, fetchFn }), null);
  assert.equal(await downloadList({ url: 'x', cachePath: p.cachePath, timeoutMs: 50, fetchFn: slowFetch(1000) }), null);
  assert.ok(!existsSync(p.cachePath));
  assert.deepEqual(loadList(p).source, 'bundled');
});

test('start-up does not wait: the list is there before the download answers', async () => {
  const p = folder();
  const ending = new AbortController();
  const pending = downloadList({ url: 'x', cachePath: p.cachePath, signal: ending.signal, fetchFn: slowFetch(60_000) });
  const started = Date.now();
  const now = loadList(p); // what the first request uses
  assert.equal(now.list.updated, '2026-11-26');
  assert.ok(Date.now() - started < 100);
  ending.abort(); // the session ends: the download is dropped, nothing hangs
  assert.equal(await pending, null);
});

test('a fresh cache is not downloaded again', async () => {
  const p = folder();
  writeFileSync(p.cachePath, LIST('2026-11-27'));
  let calls = 0;
  const got = await downloadList({ url: 'x', cachePath: p.cachePath, fetchFn: async () => (calls++, { ok: true, text: async () => LIST('x') }) });
  assert.equal(got, null);
  assert.equal(calls, 0);
});

test('same date: the list shipped with the package wins over a download', () => {
  const p = folder(); // bundled 2026-11-26
  writeFileSync(p.cachePath, LIST('2026-11-26'));
  assert.equal(loadList(p).source, 'bundled');
  writeFileSync(p.cachePath, LIST('2026-11-27'));
  assert.equal(loadList(p).source, 'cached');
});

test('the list comes from the repository unless a variable points elsewhere', () => {
  assert.equal(listUrl({}), LIST_URL);
  assert.match(LIST_URL, /^https:\/\/raw\.githubusercontent\.com\/janus-sh\/janus\/main\/lib\/free-models\.json$/);
  assert.equal(listUrl({ JANUS_MODELS_URL: 'https://example.test/list.json' }), 'https://example.test/list.json');
});
