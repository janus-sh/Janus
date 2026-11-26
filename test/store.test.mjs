import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { saveText } from '../lib/store.mjs';

const leftovers = (dir) => readdirSync(dir).filter((n) => n.endsWith('.tmp'));

test('the list is saved whole, with no .tmp file next to it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'janus-store-'));
  const path = join(dir, 'free-models.json');
  saveText(path, '{"models":[]}\n');
  saveText(path, '{"models":[1]}\n');
  assert.equal(readFileSync(path, 'utf8'), '{"models":[1]}\n');
  assert.deepEqual(leftovers(dir), []);
});

test('a save that fails still leaves no .tmp file', () => {
  // the rename fails: something that is not a file sits where the list goes
  const dir = mkdtempSync(join(tmpdir(), 'janus-store-'));
  const path = join(dir, 'free-models.json');
  mkdirSync(path);
  writeFileSync(join(path, 'x'), 'x');
  assert.throws(() => saveText(path, '{"models":[]}\n'));
  assert.deepEqual(leftovers(dir), []);
});
