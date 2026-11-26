/**
 * `janus doctor`: what Janus would use right now, in plain text, to paste
 * into a bug report. No secrets: services are named, keys never shown, and
 * the checks are requests that cost nothing (no model is called).
 *
 * collectDoctor gathers the facts (network calls go through `fetchFn`, so
 * tests run offline); formatDoctor turns them into lines and an exit code.
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { dirname, join } from 'node:path';
import { CATALOGUE_URL, healList } from './catalogue.mjs';
import { downloadList, isNewer, loadList } from './list.mjs';
import { PROVIDERS } from './providers.mjs';
import { plan } from './route.mjs';

export const CHECK_TIMEOUT_MS = 4000;

const readJson = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
};

function writable(dir) {
  // the folder, or the nearest one above it that exists (it is made on first start)
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(d)) {
      try {
        accessSync(d, constants.W_OK);
        return d === dir ? 'writable' : 'not created yet, can be created';
      } catch {
        return d === dir ? 'NOT writable' : 'not created yet, and cannot be created';
      }
    }
    if (dirname(d) === d) return 'missing';
  }
}

/** One request with a short timeout: 'ok (0.4 s)', 'refused (401)', 'answered 500', 'timed out', 'unreachable'. */
export async function check(url, headers, { fetchFn = fetch, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const started = Date.now();
  try {
    const res = await fetchFn(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    const seconds = `${((Date.now() - started) / 1000).toFixed(1)} s`;
    if (res.ok) return { ok: true, text: `ok (${seconds})` };
    if (res.status === 401 || res.status === 403) return { ok: false, text: `refused (${res.status})` };
    return { ok: false, text: `answered ${res.status}` };
  } catch (err) {
    return { ok: false, text: err?.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000} s` : 'unreachable' };
  }
}

const headersFor = (auth, key) => (auth === 'bearer' ? { authorization: `Bearer ${key}` } : { [auth]: key });

/** Everything doctor reports. Reads the settings folder; calls the network only through fetchFn. */
export async function collectDoctor({ version, agentDir, root, env = process.env, fetchFn = fetch, now = Date.now(), listUrl }) {
  const auth = readJson(join(agentDir, 'auth.json')) ?? {};
  const services = await Promise.all(
    PROVIDERS.map(async (p) => {
      const saved = auth[p.id];
      const key = saved?.type === 'api_key' ? saved.key : env.JANUS_ENV_KEYS === '1' ? env[p.env] : undefined;
      const hasKey = !!(key || saved?.type === 'oauth');
      if (!hasKey) return { id: p.id, name: p.name, hasKey };
      const checks = [];
      if (p.id === 'openrouter') checks.push({ what: 'catalogue', ...(await check(CATALOGUE_URL, {}, { fetchFn })) });
      checks.push(key && p.check ? { what: 'key', ...(await check(p.check.url, headersFor(p.check.auth, key), { fetchFn })) } : { what: 'key', ok: null, text: 'not checked' });
      return { id: p.id, name: p.name, hasKey, checks };
    }),
  );

  const paths = { bundledPath: join(root, 'lib', 'free-models.json'), cachePath: join(agentDir, 'free-models.json') };
  let { list, source } = loadList(paths);
  if (listUrl) {
    const fresh = await downloadList({ url: listUrl, cachePath: paths.cachePath, fetchFn });
    if (fresh && isNewer(fresh.list, list)) ({ list, source } = fresh);
  }

  const cataloguePath = join(agentDir, 'openrouter-models.json');
  const catalogueBody = readJson(cataloguePath);
  const healed = catalogueBody ? healList(list?.models ?? [], catalogueBody) : null;
  const catalogue = catalogueBody
    ? { ageMs: now - statSync(cataloguePath).mtimeMs, dropped: healed.dropped, added: healed.added, ignored: healed.ignored ?? null }
    : null;

  const restFile = readJson(join(agentDir, 'janus-rest.json')) ?? {};
  const rest = new Map(Object.entries(restFile).map(([k, v]) => [k, typeof v === 'number' ? v : v?.until ?? 0]));
  // a service counts when it has a key that was not refused
  const usableServices = new Set(services.filter((s) => s.hasKey && !s.checks.some((c) => c.what === 'key' && c.ok === false)).map((s) => s.id));
  const next = plan({
    models: healed?.models ?? list?.models ?? [],
    usable: (e) => (usableServices.has(e.provider) ? { contextWindow: e.catalogue?.ctx } : null),
    rest,
    now,
  }).map(({ entry }) => entry);

  return {
    version,
    node: process.version,
    os: `${process.platform} ${process.arch} ${release()}`,
    agentDir,
    folder: writable(agentDir),
    services,
    list: list ? { updated: list.updated, source, count: list.models.length } : null,
    catalogue,
    next,
  };
}

const ago = (ms) => (ms < 3_600_000 ? `${Math.max(1, Math.round(ms / 60_000))} min ago` : `${Math.round(ms / 3_600_000)} h ago`);
const short = (e) => `${e.id.replace(/:free$/, '').split('/').pop()} · ${e.provider}`;
const tilde = (path, home) => (home && path.startsWith(home) ? `~${path.slice(home.length)}` : path);

/** The report as lines, and the exit code: 0 when at least one model can take a request. */
export function formatDoctor(f, home = homedir()) {
  const keyed = f.services.filter((s) => s.hasKey);
  const lines = [
    `Janus ${f.version}`,
    `Node ${f.node} · ${f.os}`,
    `Settings folder: ${tilde(f.agentDir, home)} (${f.folder})`,
    `Keys: ${keyed.length ? keyed.map((s) => s.name).join(', ') : 'none'}`,
    ...keyed.map((s) => `  ${s.name}: ${s.checks.map((c) => `${c.what}: ${c.text}`).join(' · ')}`),
    f.list ? `Model list: ${f.list.updated}, ${f.list.source} (${f.list.count} models)` : 'Model list: none found',
    !f.catalogue
      ? 'OpenRouter catalogue: not cached yet'
      : f.catalogue.ignored
        ? `OpenRouter catalogue: ${ago(f.catalogue.ageMs)}, ignored: it would drop ${f.catalogue.ignored.wouldDrop} of ${f.catalogue.ignored.of} picks`
        : `OpenRouter catalogue: ${ago(f.catalogue.ageMs)}, dropped ${f.catalogue.dropped.length}, added ${f.catalogue.added.length}` +
          (f.catalogue.dropped.length || f.catalogue.added.length
            ? ` (${[...f.catalogue.dropped.map((id) => `-${id}`), ...f.catalogue.added.map((id) => `+${id}`)].join(' ')})`
            : ''),
    f.next.length ? 'Next request goes to:' : 'Next request goes to: no model can take it',
    ...f.next.slice(0, 3).map((e, i) => `  ${i + 1}. ${short(e)}`),
  ];
  const ok = f.next.length > 0;
  lines.push(ok ? 'Ready.' : 'Not ready: add a free key with `janus setup`, or see the lines above.');
  return { lines, code: ok ? 0 : 1 };
}

