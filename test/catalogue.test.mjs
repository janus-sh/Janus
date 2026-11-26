import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { catalogueModel, freeModels, getCatalogue, healList } from '../lib/catalogue.mjs';

const free = { prompt: '0', completion: '0' };
const paid = { prompt: '0.0000003', completion: '0.0000012' };
const tools = ['max_tokens', 'tools', 'tool_choice'];
const m = (id, extra = {}) => ({ id, pricing: free, supported_parameters: tools, context_length: 262144, created: 100, ...extra });

const BODY = {
  data: [
    m('a/kept:free'),
    m('b/newer:free', { created: 300, architecture: { input_modalities: ['text', 'image'] } }),
    m('c/older:free', { created: 200, supported_parameters: [...tools, 'reasoning'] }),
    m('d/no-tools:free', { created: 400, supported_parameters: ['max_tokens'] }),
    m('e/small:free', { created: 500, context_length: 8192 }),
    m('openrouter/free', { created: 600 }),
    m('f/paid', { pricing: paid, created: 700 }),
  ],
};
const PICKS = [
  { provider: 'google', id: 'gemini-flash-latest' },
  { provider: 'openrouter', id: 'gone/model:free', iq: 25, ping: 'ok' },
  { provider: 'openrouter', id: 'a/kept:free', iq: 20, ping: 'ok' },
  { provider: 'groq', id: 'x/y' },
];

test('drop: an OpenRouter pick that is not free any more leaves; other providers stay', () => {
  const h = healList(PICKS, BODY);
  assert.deepEqual(h.dropped, ['gone/model:free']);
  assert.deepEqual(h.models.slice(0, 3).map((e) => `${e.provider}/${e.id}`), ['google/gemini-flash-latest', 'openrouter/a/kept:free', 'groq/x/y']);
  assert.equal(h.models[1].iq, 20); // the pick keeps its rank data
  assert.equal(h.models[0].catalogue, undefined);
});

test('append: new free models with tools after the picks, newest first, marked new', () => {
  const h = healList(PICKS, BODY);
  assert.deepEqual(h.added, ['b/newer:free', 'c/older:free']);
  assert.deepEqual(h.models.slice(3).map((e) => e.id), ['b/newer:free', 'c/older:free']);
  assert.ok(h.models.slice(3).every((e) => e.new === true && e.provider === 'openrouter'));
});

test('no tools, under 32K, the meta-router and paid models never join', () => {
  const ids = healList(PICKS, BODY).models.map((e) => e.id);
  for (const id of ['d/no-tools:free', 'e/small:free', 'openrouter/free', 'f/paid']) assert.ok(!ids.includes(id), id);
});

test('no usable catalogue: the list is unchanged', () => {
  for (const body of [null, {}, { data: [] }, { data: [m('p', { pricing: paid })] }]) {
    const h = healList(PICKS, body);
    assert.equal(h.models, PICKS);
    assert.deepEqual([h.dropped, h.added], [[], []]);
  }
});

test('an engine model for a model the engine does not know yet', () => {
  const c = healList(PICKS, BODY).models[4];
  const template = { api: 'openai-completions', baseUrl: 'https://openrouter.ai/api/v1', provider: 'openrouter', thinkingLevelMap: { low: 'x' }, compat: { k: 1 } };
  const model = catalogueModel(c, template);
  assert.equal(model.id, 'c/older:free');
  assert.equal(model.api, 'openai-completions');
  assert.equal(model.reasoning, true);
  assert.equal(model.contextWindow, 262144);
  assert.deepEqual(model.cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(model.thinkingLevelMap, undefined);
  assert.deepEqual(catalogueModel(healList(PICKS, BODY).models[3], null).input, ['text', 'image']);
  assert.equal(catalogueModel({ provider: 'groq', id: 'x' }, template), null);
});

const okFetch = (calls) => async (url) => {
  calls.push(url);
  return { ok: true, json: async () => BODY };
};
const deadFetch = (calls) => async (url) => {
  calls.push(url);
  throw new Error('offline');
};

test('no OpenRouter key: nothing is fetched', async () => {
  const calls = [];
  const dir = mkdtempSync(join(tmpdir(), 'janus-cat-'));
  const got = await getCatalogue({ hasKey: false, cachePath: join(dir, 'c.json'), maxAgeMs: 1000, fetchFn: okFetch(calls) });
  assert.deepEqual(calls, []);
  assert.equal(got.body, null);
  assert.ok(!existsSync(join(dir, 'c.json')));
});

test('download keeps only the free models in the cache, and a fresh cache is not fetched again', async () => {
  const calls = [];
  const path = join(mkdtempSync(join(tmpdir(), 'janus-cat-')), 'c.json');
  const first = await getCatalogue({ hasKey: true, cachePath: path, maxAgeMs: 3_600_000, fetchFn: okFetch(calls) });
  assert.equal(first.source, 'download');
  assert.ok(!JSON.parse(readFileSync(path, 'utf8')).data.some((x) => x.id === 'f/paid'));
  const second = await getCatalogue({ hasKey: true, cachePath: path, maxAgeMs: 3_600_000, fetchFn: okFetch(calls) });
  assert.equal(second.source, 'cache');
  assert.equal(calls.length, 1);
  assert.equal(freeModels(second.body).size, 6);
});

test('offline: an old cache is used; no cache means today\'s behaviour', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'janus-cat-')), 'c.json');
  writeFileSync(path, JSON.stringify(BODY));
  utimesSync(path, new Date(0), new Date(0)); // older than any freshness rule
  const calls = [];
  const old = await getCatalogue({ hasKey: true, cachePath: path, maxAgeMs: 1000, fetchFn: deadFetch(calls) });
  assert.equal(calls.length, 1);
  assert.equal(old.source, 'old cache');
  assert.deepEqual(healList(PICKS, old.body).dropped, ['gone/model:free']);
  const none = await getCatalogue({ hasKey: true, cachePath: path + '.missing', maxAgeMs: 1000, fetchFn: deadFetch([]) });
  assert.equal(none.body, null);
  assert.equal(healList(PICKS, none.body).models, PICKS);
});

test('guard: a catalogue that would drop more than three quarters of the picks at once is ignored', () => {
  const picks = ['a/kept:free', 'w:free', 'x:free', 'y:free', 'z:free'].map((id) => ({ provider: 'openrouter', id }));
  const h = healList(picks, BODY); // w, x, y, z are not in BODY: 4 of 5
  assert.equal(h.models, picks);
  assert.deepEqual([h.dropped, h.added], [[], []]);
  assert.deepEqual(h.ignored, { wouldDrop: 4, of: 5 });
  // exactly three quarters is still trusted: an old list loses most of its models honestly
  const three = healList(picks.slice(0, 4), BODY);
  assert.deepEqual(three.dropped, ['w:free', 'x:free', 'y:free']);
  assert.equal(three.ignored, undefined);
});
