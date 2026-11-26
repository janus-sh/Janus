/**
 * `janus`: set the stage, then hand the terminal to the engine.
 *
 *   janus                 start in the current folder (first run asks for free keys)
 *   janus setup           add or change free keys
 *   janus update          update Janus itself
 *   janus doctor          what Janus would use now, for a bug report
 *   janus --version       the version, without touching the disk
 *   janus <anything else> the engine's own flags and commands (janus --help)
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findEngine, prepareFront, prepareTheme } from './engine.mjs';
import { collectDoctor, formatDoctor } from './doctor.mjs';
import { adoptOldEnv, migrateHome } from './home.mjs';
import { listUrl } from './list.mjs';
import { PROVIDERS, RETIRED_ENV } from './providers.mjs';
import { ensureSettings, keyedProviders, readSettings, runSetup } from './setup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;

// Engine commands that manage packages and credentials: no router needed.
const ENGINE_COMMANDS = new Set(['install', 'remove', 'uninstall', 'list', 'config', 'auth']);
const ONE_SHOT = new Set(['-p', '--print', '--mode', '--export']);
const INFO = new Set(['-h', '--help', '-v', '--version', '--list-models']);
const CLOSED = new Set(['EACCES', 'EPERM', 'EROFS']); // a folder we may not write to

export async function main(argv) {
  adoptOldEnv(process.env); // variable names from before the rename still work
  const home = process.env.JANUS_HOME ?? join(homedir(), '.janus');
  // Settings, keys and sessions of the old name move over once, before
  // anything reads the folder. A home set by hand is the person's own.
  if (process.env.JANUS_HOME === undefined && process.env.JANUS_CODING_AGENT_DIR === undefined) {
    try {
      if (migrateHome({ from: join(homedir(), '.anus'), to: home })) console.error('Settings copied from ~/.anus to ~/.janus.');
    } catch {
      // a home folder closed for writing: start without the old settings
    }
  }
  const agentDir = process.env.JANUS_CODING_AGENT_DIR ?? join(home, 'agent');
  process.env.JANUS_CODING_AGENT_DIR = agentDir;
  process.env.JANUS_ROOT = ROOT;
  // Janus uses only the keys given to it in `janus setup`: a paid key that
  // happens to sit in the shell must not be spent by a "free" agent.
  if (process.env.JANUS_ENV_KEYS !== '1') for (const env of [...PROVIDERS.map((p) => p.env), ...RETIRED_ENV]) delete process.env[env];

  if (argv[0] === 'setup') {
    process.exitCode = (await runSetup(agentDir)) ? 0 : 1;
    return;
  }
  if (argv[0] === 'doctor') {
    const { lines, code } = formatDoctor(await collectDoctor({ version: VERSION, agentDir, root: ROOT, listUrl: listUrl() }));
    console.log(lines.join('\n'));
    process.exitCode = code;
    return;
  }
  if (argv[0] === 'update') {
    const res = spawnSync('npm', ['install', '-g', '@janus-sh/janus@latest'], { stdio: 'inherit', shell: process.platform === 'win32' });
    process.exitCode = res.status ?? 1;
    return;
  }

  // The version needs no disk and no engine (issue #93: a closed home folder
  // used to crash `--version`).
  if (argv[0] === '-v' || argv[0] === '--version') {
    console.log(VERSION);
    return;
  }
  const command = ENGINE_COMMANDS.has(argv[0]);
  const info = argv.some((a) => INFO.has(a));
  try {
    ensureSettings(agentDir);
  } catch (err) {
    if (!info) throw err;
  }
  const settings = readSettings(agentDir);
  if ((settings.janusCoauthor ?? settings.anusCoauthor) === false) process.env.JANUS_COAUTHOR = '0';
  const interactive = process.stdin.isTTY && process.stdout.isTTY && !argv.some((a) => ONE_SHOT.has(a));
  if (!command && !info && !keyedProviders(agentDir).length) {
    if (!interactive) {
      console.error('Janus has no free keys yet. Run `janus setup` first.');
      process.exitCode = 1;
      return;
    }
    if (!(await runSetup(agentDir))) {
      process.exitCode = 1;
      return;
    }
  }

  const engine = findEngine();
  // A home folder closed for writing (a sandbox, a read-only mount) must not
  // stop Janus: themes are skipped, the front folder moves to the system temp.
  try {
    prepareTheme({ agentDir, engine });
  } catch (err) {
    if (!CLOSED.has(err.code)) throw err;
  }
  try {
    process.env.PI_PACKAGE_DIR = prepareFront({ home, engine, version: VERSION, root: ROOT });
  } catch (err) {
    if (!CLOSED.has(err.code)) throw err;
    const spare = join(tmpdir(), `janus-${process.getuid?.() ?? 'user'}`);
    process.env.PI_PACKAGE_DIR = prepareFront({ home: spare, engine, version: VERSION, root: ROOT });
  }
  process.env.PI_SKIP_VERSION_CHECK = '1'; // the engine would compare its own releases with Janus's version
  const args = command ? argv : ['-e', join(ROOT, 'extension', 'janus.mjs'), ...argv];
  process.argv = [process.argv[0], engine.cli, ...args];
  await import(pathToFileURL(engine.cli).href);
}
