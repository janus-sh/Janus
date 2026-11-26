/**
 * OpenRouter's own model catalogue (GET /api/v1/models, no key needed),
 * checked at start so the ranked list heals itself before it is rebuilt:
 * a picked OpenRouter model that is no longer free is dropped at once, and a
 * new free model that can call tools joins the end of the list the same day.
 *
 * healList and catalogueModel are pure; getCatalogue does the reading and
 * fetching, with the cache path and fetch passed in so tests can run offline.
 */
import { readFileSync, statSync } from 'node:fs';
import { saveText } from './store.mjs';

export const CATALOGUE_URL = 'https://openrouter.ai/api/v1/models';
export const CATALOGUE_TIMEOUT_MS = 4000;
// the catch-all router of OpenRouter: not a model of its own
const META = new Set(['openrouter/free']);
const MIN_CONTEXT = 32_000;

const isFree = (m) => m?.pricing && Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0;

/** The free models of a catalogue body, by id; null when the body is not a usable catalogue. */
export function freeModels(body) {
  if (!Array.isArray(body?.data)) return null;
  const free = new Map();
  for (const m of body.data) if (typeof m?.id === 'string' && isFree(m)) free.set(m.id, m);
  return free.size ? free : null; // an empty free set means the format changed, not that nothing is free
}

/** What the router needs to know about a model the engine has never heard of. */
const facts = (m) => ({
  name: m.name ?? m.id,
  ctx: m.context_length,
  input: m.architecture?.input_modalities?.includes('image') ? ['text', 'image'] : ['text'],
  maxOut: m.top_provider?.max_completion_tokens ?? undefined,
  reasoning: (m.supported_parameters ?? []).includes('reasoning'),
});

/**
 * The ranked list checked against the catalogue. OpenRouter picks that are not
 * free in the catalogue are dropped; free models that support tools, have at
 * least 32K of context and are not picked are added after the picks, newest
 * first, marked `new`. Other providers are left as they are. Without a usable
 * catalogue, or when it would drop more than three quarters of the OpenRouter picks at
 * once (`ignored`), the list comes back unchanged.
 */
export function healList(models, body) {
  const free = freeModels(body);
  if (!free) return { models, dropped: [], added: [] };
  const dropped = [];
  const kept = [];
  for (const entry of models) {
    if (entry.provider !== 'openrouter') kept.push(entry);
    else if (free.has(entry.id)) kept.push({ ...entry, catalogue: facts(free.get(entry.id)) });
    else dropped.push(entry.id);
  }
  const picked = new Set(models.filter((e) => e.provider === 'openrouter').map((e) => e.id));
  // More than three quarters of the picks gone at once looks like a change in
  // the catalogue's format, not in what is free (a list two months old lost
  // 8 of 13 honestly): keep the picks, add nothing.
  if (dropped.length * 4 > picked.size * 3) return { models, dropped: [], added: [], ignored: { wouldDrop: dropped.length, of: picked.size } };
  const fresh = [...free.values()]
    .filter(
      (m) =>
        !picked.has(m.id) &&
        !META.has(m.id) &&
        (m.supported_parameters ?? []).includes('tools') &&
        (m.context_length ?? 0) >= MIN_CONTEXT,
    )
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0));
  const added = fresh.map((m) => ({ provider: 'openrouter', id: m.id, new: true, catalogue: facts(m) }));
  return { models: [...kept, ...added], dropped, added: added.map((e) => e.id) };
}

// The shape the engine gives its free OpenRouter models (pi 1.6.1).
const OPENROUTER_BASE = {
  type: 'chat',
  api: 'openai-completions',
  baseUrl: 'https://openrouter.ai/api/v1',
  provider: 'openrouter',
  compat: { thinkingFormat: 'openrouter', supportsStrictMode: true, sendSessionAffinityHeaders: true },
};

/**
 * An engine model for an OpenRouter entry the engine's own catalogue does not
 * have yet, built from a known free OpenRouter model (`template`) when there
 * is one. Null when the entry has no catalogue facts.
 */
export function catalogueModel(entry, template) {
  const c = entry.catalogue;
  if (entry.provider !== 'openrouter' || !c) return null;
  const { thinkingLevelMap: _t, ...base } = template ?? OPENROUTER_BASE;
  return {
    ...base,
    id: entry.id,
    name: c.name,
    reasoning: c.reasoning,
    input: c.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: c.ctx,
    maxTokens: Math.min(c.maxOut ?? 32_768, 65_536),
  };
}

function readCache(path) {
  try {
    const body = JSON.parse(readFileSync(path, 'utf8'));
    return freeModels(body) ? { body, age: Date.now() - statSync(path).mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * The catalogue for this start: the cache while it is fresh, else a download
 * (at most `timeoutMs`), else the old cache, else null. Nothing is fetched
 * without an OpenRouter key. Only the free models are kept in the cache.
 */
export async function getCatalogue({ hasKey, cachePath, maxAgeMs, timeoutMs = CATALOGUE_TIMEOUT_MS, fetchFn = fetch }) {
  if (!hasKey) return { body: null, source: 'no OpenRouter key' };
  const cached = readCache(cachePath);
  if (cached && cached.age < maxAgeMs) return { body: cached.body, source: 'cache' };
  try {
    const res = await fetchFn(CATALOGUE_URL, { signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) {
      const free = freeModels(await res.json());
      if (free) {
        const body = { fetched: new Date().toISOString(), data: [...free.values()] };
        try {
          saveText(cachePath, JSON.stringify(body) + '\n');
        } catch {} // a folder closed for writing: use it without a cache
        return { body, source: 'download' };
      }
    }
  } catch {}
  return cached ? { body: cached.body, source: 'old cache' } : { body: null, source: 'offline' };
}
