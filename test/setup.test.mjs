import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PROVIDER_IDS, RETIRED_ENV } from '../lib/providers.mjs';
import { JANUS_THEME, ensureSettings, keyedProviders } from '../lib/setup.mjs';

const settingsAfter = (before) => {
  const dir = mkdtempSync(join(tmpdir(), 'janus-settings-'));
  if (before) writeFileSync(join(dir, 'settings.json'), JSON.stringify(before));
  ensureSettings(dir);
  return { dir, read: () => JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) };
};

test('a fresh install gets the Janus themes (light and dark by the terminal)', () => {
  const s = settingsAfter(null).read();
  assert.equal(s.theme, JANUS_THEME);
  assert.equal(s.defaultProvider, 'janus');
  assert.equal(s.defaultModel, 'free');
  assert.equal(s.tuiMode, 'regular');
});

test('the "light" the engine wrote on its first start is replaced once', () => {
  // the case behind the white bars under messages in a dark Ghostty (29.09)
  const { dir, read } = settingsAfter({ theme: 'light', defaultModel: 'free' });
  assert.equal(read().theme, JANUS_THEME);
  assert.equal(read().janusLook, 1);
  // the person switches to light later: Janus keeps it
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...read(), theme: 'light' }));
  ensureSettings(dir);
  assert.equal(read().theme, 'light');
});

test('a theme the person picked is kept', () => {
  assert.equal(settingsAfter({ theme: 'monokai' }).read().theme, 'monokai');
});

test('settings from before the rename: same model, same themes, same choices', () => {
  const old = {
    defaultProvider: 'anus',
    defaultModel: 'free',
    theme: 'anus-light/anus',
    anusLook: 1,
    anusCoauthor: false,
    modelThinkingLevels: { 'anus/free': 'high' },
  };
  const s = settingsAfter(old).read();
  assert.equal(s.defaultProvider, 'janus');
  assert.equal(s.theme, JANUS_THEME);
  assert.deepEqual(s.modelThinkingLevels, { 'janus/free': 'high' });
  assert.equal(s.anusCoauthor, false); // kept: main.mjs still reads it
  assert.equal(settingsAfter({ theme: 'anus', anusLook: 1 }).read().theme, 'janus');
  // a light theme the person picked under the old name is not reset
  assert.equal(settingsAfter({ theme: 'light', anusLook: 1 }).read().theme, 'light');
});

test('a saved Mistral key is left alone and not offered: its API is no longer free', () => {
  const dir = mkdtempSync(join(tmpdir(), 'janus-keys-'));
  writeFileSync(join(dir, 'auth.json'), JSON.stringify({ mistral: { type: 'api_key', key: 'test' } }));
  assert.deepEqual(keyedProviders(dir, {}), []);
  assert.ok(!PROVIDER_IDS.includes('mistral'));
  assert.ok(RETIRED_ENV.includes('MISTRAL_API_KEY'));
});
