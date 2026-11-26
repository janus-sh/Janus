/**
 * Writing a cache file in the agent folder so that a reader never sees half
 * of it: the text goes to a temporary file of this process first, then
 * replaces the file in one rename. The temporary file never stays behind,
 * not even when the write or the rename fails.
 */
import { mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function saveText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, path);
  } finally {
    rmSync(tmp, { force: true });
  }
}
