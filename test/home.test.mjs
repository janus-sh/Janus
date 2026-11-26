import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { adoptOldEnv, migrateHome } from '../lib/home.mjs';

const oldHome = () => {
  const base = mkdtempSync(join(tmpdir(), 'janus-home-'));
  const from = join(base, '.anus');
  mkdirSync(join(from, 'agent', 'sessions'), { recursive: true });
  writeFileSync(join(from, 'agent', 'auth.json'), '{"openrouter":{"type":"api_key","key":"test"}}\n', { mode: 0o600 });
  writeFileSync(join(from, 'agent', 'settings.json'), '{"defaultProvider":"anus"}\n');
  writeFileSync(join(from, 'agent', 'sessions', 'one.jsonl'), '{}\n');
  mkdirSync(join(from, 'engine', 'x'), { recursive: true });
  // a dangling link in the engine cache; Windows needs extra rights for links, so it is left out there
  if (process.platform !== 'win32') symlinkSync(join(base, 'nowhere'), join(from, 'engine', 'x', 'dangling'));
  return { base, from, to: join(base, '.janus') };
};

test('old home is copied once, modes kept, the old folder stays', () => {
  const { from, to } = oldHome();
  assert.equal(migrateHome({ from, to }), true);
  assert.equal(readFileSync(join(to, 'agent', 'settings.json'), 'utf8'), '{"defaultProvider":"anus"}\n');
  assert.ok(existsSync(join(to, 'agent', 'sessions', 'one.jsonl')));
  // Windows has no owner-only file mode; there the copy keeps what the system gives
  if (process.platform !== 'win32') assert.equal(statSync(join(to, 'agent', 'auth.json')).mode & 0o777, 0o600);
  assert.ok(existsSync(join(from, 'agent', 'auth.json')), 'old folder untouched');
  assert.ok(!existsSync(join(to, 'engine')), 'engine cache is rebuilt, not copied');
  // second start: the new folder exists, nothing happens
  writeFileSync(join(to, 'agent', 'settings.json'), '{"defaultProvider":"janus"}\n');
  assert.equal(migrateHome({ from, to }), false);
  assert.equal(readFileSync(join(to, 'agent', 'settings.json'), 'utf8'), '{"defaultProvider":"janus"}\n');
});

test('no old home, or the new one already there: nothing to copy', () => {
  const base = mkdtempSync(join(tmpdir(), 'janus-home-'));
  assert.equal(migrateHome({ from: join(base, '.anus'), to: join(base, '.janus') }), false);
  assert.ok(!existsSync(join(base, '.janus')));
  const { from, to } = oldHome();
  mkdirSync(to);
  assert.equal(migrateHome({ from, to }), false);
  assert.deepEqual(readdirSync(to), []);
});

test('old variable names still work, the new name wins', () => {
  const env = adoptOldEnv({ ANUS_HOME: '/old', ANUS_DEBUG: '1', ANUS_COAUTHOR: '0', JANUS_COAUTHOR: '1', ANUS_ROOT: '/x' });
  assert.equal(env.JANUS_HOME, '/old');
  assert.equal(env.JANUS_DEBUG, '1');
  assert.equal(env.JANUS_COAUTHOR, '1');
  assert.equal(env.JANUS_ROOT, undefined); // internal names just switched
});
