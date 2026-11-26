import assert from 'node:assert/strict';
import { test } from 'node:test';
import { backAt, freeLine, modelState } from '../lib/free.mjs';
import { restFor, untilUtcMidnight } from '../lib/route.mjs';

const NOW = Date.UTC(2026, 10, 26, 10, 0, 0);
const or = (id, extra = {}) => ({ provider: 'openrouter', id, ...extra });

test('rate limit: back in ~40 s', () => {
  const r = restFor('429 Too Many Requests', NOW);
  assert.equal(modelState({ hasKey: true, until: NOW + 40_000, why: r.why }, NOW), 'resting: rate limit, back in ~40 s');
});

test('daily cap: back at the local time the cap resets', () => {
  const r = restFor('Rate limit exceeded: free-models-per-day', NOW);
  const until = NOW + untilUtcMidnight(NOW);
  const d = new Date(until);
  const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  assert.equal(modelState({ hasKey: true, until, why: r.why }, NOW), `resting: daily cap, back at ${hhmm}`);
});

test('broke off, refused, key refused: minutes and hours', () => {
  assert.equal(modelState({ hasKey: true, until: NOW + 5 * 60_000, why: 'broke off mid-answer' }, NOW), 'resting: broke off mid-answer, back in 5 min');
  assert.equal(modelState({ hasKey: true, until: NOW + 4 * 60_000 }, NOW), 'resting: refused, back in 4 min');
  assert.equal(backAt(NOW + 6 * 3_600_000, NOW, 'key refused'), 'back in 6 h');
});

test('awake, missed ping, no key, not free any more', () => {
  assert.equal(modelState({ hasKey: true }, NOW), 'awake');
  assert.equal(modelState({ hasKey: true, until: NOW - 1 }, NOW), 'awake'); // a rest that is over
  assert.equal(modelState({ hasKey: true, ping: 'down' }, NOW), 'awake, missed the last ping');
  assert.equal(modelState({ hasKey: false, until: NOW + 60_000 }, NOW), 'no key');
  assert.equal(modelState({ gone: true }, NOW), 'not free any more');
});

test('one line per model, never wider than 80 columns, the state kept whole', () => {
  const long = or('nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', { iq: 20.4, new: true });
  const state = 'resting: broke off mid-answer, back in 5 min';
  const line = freeLine(long, state);
  assert.ok([...line].length <= 80, line);
  assert.ok(line.endsWith(` iq 20.4 new — ${state}`), line);
  assert.ok(!line.includes('\n'));
  assert.equal(freeLine(or('a/short:free', { iq: 16.3 }), 'awake'), 'short · openrouter iq 16.3 — awake');
  for (const w of [40, 60, 80]) assert.ok([...freeLine(long, state, w)].length <= w);
});
