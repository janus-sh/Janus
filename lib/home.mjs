/**
 * The home folder of Janus (~/.janus) and the names it had before.
 *
 * Earlier releases had another name for the folder and the variables. On the
 * first start after the rename, the old folder is copied (never moved, never
 * deleted), and the old variable names still work; the new name wins.
 */
import { cpSync, existsSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';

/** The variables a person may set: the old name of each is still read. */
export const USER_ENV = ['HOME', 'ENV_KEYS', 'COAUTHOR', 'DEBUG', 'MODELS_URL'];

/** Copy the old name into JANUS_<x> where only the old name is set. */
export function adoptOldEnv(env = process.env) {
  for (const name of USER_ENV) {
    if (env[`JANUS_${name}`] === undefined && env[`ANUS_${name}`] !== undefined) env[`JANUS_${name}`] = env[`ANUS_${name}`];
  }
  return env;
}

/**
 * Copy the old home folder into the new one, once: only when `to` does not
 * exist and `from` does. File modes are kept (auth.json stays 0600). The
 * engine cache (<home>/engine) is left behind: it is rebuilt on start.
 * The copy goes to a temporary sibling first, so a failed copy leaves no
 * half-filled ~/.janus behind. Returns true when it copied.
 */
export function migrateHome({ from, to }) {
  if (existsSync(to) || !existsSync(from)) return false;
  const tmp = join(dirname(to), `${basename(to)}.copy-${process.pid}`);
  try {
    cpSync(from, tmp, {
      recursive: true,
      filter: (src) => relative(from, src).split(sep)[0] !== 'engine',
    });
    renameSync(tmp, to);
  } catch (err) {
    rmSync(tmp, { recursive: true, force: true });
    throw err;
  }
  return true;
}
