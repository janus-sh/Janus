import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { isRetryableAssistantError } from '@earendil-works/pi-ai';
import { PROVIDER_IDS } from '../lib/providers.mjs';
import {
  estimateTokens,
  keyOf,
  midStreamError,
  orderModels,
  plan,
  restFor,
  untilUtcMidnight,
} from '../lib/route.mjs';

const NOW = Date.UTC(2026, 8, 29, 10, 0, 0);
const A = { provider: 'openrouter', id: 'a:free' };
const B = { provider: 'openrouter', id: 'b:free', ping: 'down' };
const C = { provider: 'groq', id: 'c' };
const D = { provider: 'openrouter', id: 'd:free', ping: 'flaky' };
const model = (contextWindow = 200_000) => ({ contextWindow });
const all = () => model();

test('order keeps the list, sinks flaky and down models', () => {
  assert.deepEqual(orderModels([B, A, D, C]).map(keyOf), [A, C, D, B].map(keyOf));
});

test('plan: awake models first, resting ones after, soonest to wake first', () => {
  const rest = new Map([
    [keyOf(A), NOW + 60_000],
    ['groq', NOW + 30_000],
  ]);
  const got = plan({ models: [A, B, C, D], usable: all, rest, now: NOW }).map((t) => keyOf(t.entry));
  assert.deepEqual(got, [keyOf(D), keyOf(B), keyOf(C), keyOf(A)]);
});

test('plan: a model without a key is never tried', () => {
  const usable = (e) => (e.provider === 'groq' ? null : model());
  const got = plan({ models: [A, C], usable, rest: new Map(), now: NOW }).map((t) => keyOf(t.entry));
  assert.deepEqual(got, [keyOf(A)]);
});

test('plan: a model too small for the conversation is skipped', () => {
  const usable = (e) => (e === A ? model(32_000) : model(262_000));
  const got = plan({ models: [A, C], usable, rest: new Map(), now: NOW, tokens: 50_000 });
  assert.deepEqual(got.map((t) => keyOf(t.entry)), [keyOf(C)]);
});

test('rest: rate limit is a minute, daily cap and gated model until 00:00 UTC', () => {
  assert.deepEqual(restFor('429: Provider returned error, rate-limited upstream', NOW), { ms: 60_000, scope: 'model', why: 'rate limit' });
  const midnight = untilUtcMidnight(NOW);
  assert.equal(midnight, 14 * 3_600_000);
  assert.equal(restFor('Rate limit exceeded: free-models-per-day', NOW).ms, midnight);
  assert.equal(restFor('You exceeded your current quota, please check your plan and billing details', NOW).ms, midnight);
  assert.equal(restFor('403: x is only available on agentic harnesses', NOW).ms, midnight);
});

test('rest: a bad key rests the whole provider', () => {
  assert.deepEqual(restFor('401: Invalid API key', NOW), { ms: 6 * 3_600_000, scope: 'provider', why: 'key refused' });
});

test('rest: context overflow does not rest the model, a hiccup rests it five minutes', () => {
  assert.equal(restFor('context_length_exceeded', NOW).ms, 0);
  assert.equal(restFor('Upstream error from Nvidia: Service temporarily overloaded', NOW).ms, 5 * 60_000);
});

test('tokens: four characters per token', () => {
  assert.equal(estimateTokens([{ content: 'x'.repeat(398) }]), 100);
});

test('bundled list: known providers only, no duplicates, no paid OpenRouter models', () => {
  const list = JSON.parse(readFileSync(new URL('../lib/free-models.json', import.meta.url), 'utf8'));
  assert.ok(list.models.length >= 10);
  const keys = list.models.map(keyOf);
  assert.equal(new Set(keys).size, keys.length);
  for (const m of list.models) {
    assert.ok(PROVIDER_IDS.includes(m.provider), m.provider);
    if (m.provider === 'openrouter') assert.match(m.id, /:free$/);
  }
});

// The engine's own rule, imported from the engine itself: when it changes
// in an upgrade, these tests show whether the retry still happens.
const engineRetries = (text) => isRetryableAssistantError({ stopReason: 'error', errorMessage: text });

test('broke off mid-answer: the engine retries the turn', () => {
  const text = midStreamError('Provider finish_reason: error', 'north-mini-code · openrouter');
  assert.ok(engineRetries(text), text);
  assert.match(text, /north-mini-code/);
});

test('broke off mid-answer: limit words do not block the retry', () => {
  for (const cause of [
    'quota exceeded for this model, check billing',
    'insufficient_quota: out of budget',
    'subscription_sharing_usage_limit_exceeded',
    '{"code": 1308, "message": "usage limit"}',
  ]) {
    const text = midStreamError(cause, 'x');
    assert.ok(engineRetries(text), text);
  }
});

test('order: ranked picks, then models new from the catalogue, then models known to be down', () => {
  const ok = { provider: 'openrouter', id: 'ok:free', ping: 'ok' };
  const bare = { provider: 'groq', id: 'bare' }; // a direct service: no ping, still ranked
  const flaky = { provider: 'openrouter', id: 'flaky:free', ping: 'flaky' };
  const down = { provider: 'openrouter', id: 'down:free', ping: 'down' };
  const fresh1 = { provider: 'openrouter', id: 'new1:free', new: true };
  const fresh2 = { provider: 'openrouter', id: 'new2:free', new: true };
  const got = orderModels([down, fresh1, flaky, ok, fresh2, bare]).map((m) => m.id);
  assert.deepEqual(got, ['ok:free', 'bare', 'flaky:free', 'new1:free', 'new2:free', 'down:free']);
});

test('plan: a new catalogue model never jumps ahead of an awake ranked pick', () => {
  const flaky = { provider: 'openrouter', id: 'flaky:free', ping: 'flaky' };
  const fresh = { provider: 'openrouter', id: 'new:free', new: true };
  const got = plan({ models: [flaky, fresh], usable: all, rest: new Map(), now: NOW }).map((t) => t.entry.id);
  assert.deepEqual(got, ['flaky:free', 'new:free']);
});
