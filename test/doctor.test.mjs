import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { check, collectDoctor, formatDoctor } from '../lib/doctor.mjs';

const KEY = 'test-key-123456';
const ROOT = join(import.meta.dirname, '..');

const home = (auth) => {
  const agentDir = join(mkdtempSync(join(tmpdir(), 'janus-doctor-')), 'agent');
  mkdirSync(agentDir, { recursive: true });
  if (auth) writeFileSync(join(agentDir, 'auth.json'), JSON.stringify(auth));
  return agentDir;
};
// answers by URL; records what was asked, so the test can check no key leaks into a URL
const fakeFetch = (answers, calls = []) => async (url, init) => {
  calls.push({ url, headers: init?.headers ?? {} });
  const a = Object.entries(answers).find(([part]) => url.includes(part))?.[1];
  if (a === 'offline' || !a) throw new TypeError('fetch failed');
  return { ok: a < 400, status: a, json: async () => ({}), text: async () => '{}' };
};

test('a working OpenRouter key: ready, three next models, exit 0, no key in the output', async () => {
  const calls = [];
  const f = await collectDoctor({
    version: '9.9.9',
    agentDir: home({ openrouter: { type: 'api_key', key: KEY } }),
    root: ROOT,
    env: {},
    fetchFn: fakeFetch({ '/api/v1/models': 200, '/api/v1/key': 200 }, calls),
  });
  const { lines, code } = formatDoctor(f);
  const text = lines.join('\n');
  assert.equal(code, 0);
  assert.match(text, /^Janus 9\.9\.9$/m);
  assert.match(text, /Keys: OpenRouter$/m);
  assert.match(text, /OpenRouter: catalogue: ok \(\d+\.\d s\) · key: ok/);
  assert.match(text, /Model list: \d{4}-\d\d-\d\d, bundled/);
  assert.match(text, /OpenRouter catalogue: not cached yet/);
  assert.equal(lines.filter((l) => /^  \d\. .+ · openrouter$/.test(l)).length, 3);
  assert.ok(!text.includes(KEY) && !text.includes(KEY.slice(-6)), 'no part of the key is printed');
  assert.ok(calls.every((c) => !c.url.includes(KEY)), 'the key goes in a header, never in a URL');
  assert.equal(calls.find((c) => c.url.includes('/key')).headers.authorization, `Bearer ${KEY}`);
});

test('no keys at all: not ready, exit 1, nothing fetched', async () => {
  const calls = [];
  const f = await collectDoctor({ version: '1', agentDir: home(null), root: ROOT, env: {}, fetchFn: fakeFetch({}, calls) });
  const { lines, code } = formatDoctor(f);
  assert.equal(code, 1);
  assert.match(lines.join('\n'), /Keys: none/);
  assert.match(lines.at(-1), /^Not ready/);
  assert.deepEqual(calls, []);
});

test('a refused key does not count; offline is said plainly; an OAuth login is "not checked"', async () => {
  const f = await collectDoctor({
    version: '1',
    agentDir: home({ openrouter: { type: 'api_key', key: KEY }, groq: { type: 'oauth' } }),
    root: ROOT,
    env: {},
    fetchFn: fakeFetch({ '/api/v1/models': 'offline', '/api/v1/key': 401 }),
  });
  const text = formatDoctor(f).lines.join('\n');
  assert.match(text, /OpenRouter: catalogue: unreachable · key: refused \(401\)/);
  assert.match(text, /Groq: key: not checked/);
  // groq's models are reachable through the OAuth login, so a model can still take the request
  assert.match(text, /qwen3\.8-27b · groq|gpt-oss-120b · groq/);
});

test('a slow service times out after a short wait', async () => {
  const never = (_u, { signal }) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const keep = setTimeout(() => {}, 1000); // AbortSignal.timeout does not hold the test process open by itself
  const r = await check('https://x', {}, { fetchFn: never, timeoutMs: 50 });
  clearTimeout(keep);
  assert.deepEqual(r, { ok: false, text: 'timed out after 0.05 s' });
});

test('catalogue state comes from the cache: its age and what it dropped or added', async () => {
  const agentDir = home({ openrouter: { type: 'api_key', key: KEY } });
  const free = { prompt: '0', completion: '0' };
  const data = [
    'nvidia/nemotron-3.5-super-vl:free',
    'google/gemma-4-31b-it:free',
    'nvidia/nemotron-3-ultra-550b-a55b:free',
    'google/gemma-4-26b-a4b-it:free',
    'nvidia/nemotron-3.5-lightning:free',
    'baidu/ernie-5.5-flash-preview:free',
    'recursive/flint-v1.0:free',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',
    'particle-ai/particle-1:free',
    'inclusionai/ling-3.2-flash:free',
  ].map((id) => ({ id, pricing: free, supported_parameters: ['tools'], context_length: 262144, created: 1 }));
  data.push({ id: 'z/brand-new:free', pricing: free, supported_parameters: ['tools'], context_length: 262144, created: 9 });
  writeFileSync(join(agentDir, 'openrouter-models.json'), JSON.stringify({ data }));
  const f = await collectDoctor({ version: '1', agentDir, root: ROOT, env: {}, fetchFn: fakeFetch({ '/api/v1/': 200 }) });
  assert.match(formatDoctor(f).lines.join('\n'), /OpenRouter catalogue: 1 min ago, dropped 1, added 1 \(-liquid\/lfm-3-1\.7b:free \+z\/brand-new:free\)/);
});
