/**
 * Janus inside the engine: the model `janus/free`.
 *
 * Every request goes to the best free model that is awake and has a key.
 * If that model refuses before it says anything (rate limit, daily cap, a
 * provider hiccup), the next one takes the same request at once, and the
 * one that refused rests (lib/route.mjs decides for how long). The model
 * that answered is shown in the footer.
 */
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';
import { CustomEditor } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, visibleWidth } from '@earendil-works/pi-tui';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  boxLines,
  boxUserMessage,
  footerLine,
  headerLines,
  PHRASES,
  starAnswer,
  useLightPalette,
  workingLine,
} from '../lib/look.mjs';
import { PROVIDERS, PROVIDER_IDS } from '../lib/providers.mjs';
import { catalogueModel, getCatalogue, healList } from '../lib/catalogue.mjs';
import { downloadList, isNewer, LIST_MAX_AGE_MS, loadList } from '../lib/list.mjs';
import { coauthorEnabled, withTrailer } from '../lib/coauthor.mjs';
import { estimateTokens, keyOf, midStreamError, plan, restFor } from '../lib/route.mjs';

const ROOT = process.env.JANUS_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENT_DIR = process.env.JANUS_CODING_AGENT_DIR ?? join(homedir(), '.janus', 'agent');
// The list host stays where it was before the rename.
const LIST_URL = process.env.JANUS_MODELS_URL ?? process.env.ANUS_MODELS_URL ?? 'https://anus.dev/free-models.json';
const LIST_CACHE = join(AGENT_DIR, 'free-models.json');
const LIST_PATHS = { bundledPath: join(ROOT, 'lib', 'free-models.json'), cachePath: LIST_CACHE };
const REST_FILE = join(AGENT_DIR, 'janus-rest.json');
const CATALOGUE_CACHE = join(AGENT_DIR, 'openrouter-models.json');
const MAX_TRIES = 6;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };

/** JANUS_DEBUG=1: every routing decision goes to <agent dir>/janus-debug.log. */
function debug(...parts) {
  if (!(process.env.JANUS_DEBUG ?? process.env.ANUS_DEBUG)) return;
  try {
    appendFileSync(join(AGENT_DIR, 'janus-debug.log'), `${new Date().toISOString()} ${parts.join(' ')}\n`);
  } catch {}
}

/** Long rests (daily caps, gated models) survive a restart; short ones do not matter. */
function loadRest() {
  const rest = new Map();
  try {
    const now = Date.now();
    for (const [k, until] of Object.entries(JSON.parse(readFileSync(REST_FILE, 'utf8'))))
      if (until > now) rest.set(k, until);
  } catch {}
  return rest;
}

function saveRest(rest) {
  try {
    const soon = Date.now() + 10 * 60_000;
    const long = Object.fromEntries([...rest].filter(([, until]) => until > soon));
    mkdirSync(AGENT_DIR, { recursive: true });
    writeFileSync(REST_FILE, JSON.stringify(long) + '\n');
  } catch {}
}

const hasImages = (messages) =>
  (messages ?? []).some((m) => Array.isArray(m?.content) && m.content.some((c) => c?.type === 'image'));

const ignoredLine = ({ wouldDrop, of }) =>
  `OpenRouter catalogue would drop ${wouldDrop} of ${of} picks at once: ignored, list kept`;

const shortName = (entry) => `${entry.id.replace(/:free$/, '').split('/').pop()} · ${entry.provider}`;

/** The input in a rounded box with "> ", like this project's 2025 CLI (0.1.0). */
class BoxEditor extends CustomEditor {
  render(width) {
    if (width < 12) return super.render(width);
    const lines = super.render(width - 6);
    const shown = this.renderedVisibleLineCount ?? Math.max(1, lines.length - 2);
    // the box hugs the text and grows as you type, like the 0.1.0 screenshot
    const content = lines.slice(1, 1 + shown).map((line) => line.replace(/ +$/, ''));
    const inner = Math.min(width - 6, Math.max(20, ...content.map((line) => visibleWidth(line) + 1)));
    const padded = content.map((line) => line + ' '.repeat(Math.max(0, inner - visibleWidth(line))));
    const below = lines.slice(2 + shown); // the slash-command menu
    return [...boxLines(padded, inner + 6), ...below.map((line) => `   ${line}`)].map((line) =>
      truncateToWidth(line, width),
    );
  }
}

export default function janus(pi) {
  let base = loadList(LIST_PATHS).list; // the ranked list as cached or bundled, at once
  const ending = new AbortController(); // a download still running when the session ends is dropped
  let catalogue = null; // OpenRouter's own catalogue, when there is one
  let healed = { dropped: [], added: [], ignored: null };
  let list = base; // the ranked list checked against the catalogue
  let catalogueReady = Promise.resolve();
  const heal = () => {
    if (!catalogue || !base) return void (list = base);
    const h = healList(base.models, catalogue);
    healed = h;
    list = { ...base, models: h.models };
  };
  let registry = null;
  let ui = null;
  let routed = 'free models'; // the real model that answered last, for the footer
  let tui = null;
  const rest = loadRest();
  const resting = (key, ms) => {
    rest.set(key, Date.now() + ms);
    if (ms > 10 * 60_000) saveRest(rest);
  };

  // A free OpenRouter model the engine's catalogue does not know yet is built
  // from OpenRouter's catalogue, in the shape of a free model the engine knows.
  let template;
  const openrouterTemplate = () => {
    if (template === undefined) {
      const known = (base?.models ?? []).filter((e) => e.provider === 'openrouter').map((e) => registry.find(e.provider, e.id));
      template = known.find((m) => m?.api === 'openai-completions') ?? null;
    }
    return template;
  };
  const usable = (needImages) => (entry) => {
    if (!registry || !PROVIDER_IDS.includes(entry.provider)) return null;
    const model = registry.find(entry.provider, entry.id) ?? catalogueModel(entry, openrouterTemplate());
    if (!model || !registry.hasConfiguredAuth(model)) return null;
    if (needImages && !model.input?.includes('image')) return null;
    return model;
  };

  const cut = (lines, width) => lines.map((line) => truncateToWidth(line, Math.max(1, width)));

  // "✦ Generating thrust... (esc to cancel, 3s)" above the input while working
  let working = null;
  const stopWorking = (ctx) => {
    if (working) clearInterval(working.timer);
    working = null;
    ctx?.ui?.setWidget('janus-working', undefined);
  };

  pi.on('session_start', async (_event, ctx) => {
    registry = ctx.modelRegistry;
    ui = ctx.hasUI ? ctx.ui : null;
    // The fresh list applies to the next request once it arrives.
    downloadList({ url: LIST_URL, cachePath: LIST_CACHE, signal: ending.signal }).then((fresh) => {
      debug('list', fresh ? `downloaded ${fresh.list.updated}` : 'not downloaded, using the one at hand');
      if (!fresh || !isNewer(fresh.list, base)) return;
      base = fresh.list;
      heal();
    });
    // OpenRouter's own catalogue: in the background, so start-up never waits;
    // the first request waits for it at most the download timeout.
    const hasKey = !!registry.getProviderAuthStatus('openrouter')?.configured;
    catalogueReady = getCatalogue({ hasKey, cachePath: CATALOGUE_CACHE, maxAgeMs: LIST_MAX_AGE_MS }).then(({ body, source }) => {
      catalogue = body;
      heal();
      debug('catalogue', source, `dropped: ${healed.dropped.join(' ') || 'none'}`, `added: ${healed.added.join(' ') || 'none'}`);
      if (healed.ignored) debug('catalogue ignored:', ignoredLine(healed.ignored));
    });
    if (ctx.mode === 'tui') {
      useLightPalette(ctx.ui.theme?.name === 'janus-light' || ctx.ui.theme?.name === 'light');
      // The look of this project's 2025 CLI (0.1.0, lib/look.mjs). The engine crashes on a
      // line wider than the terminal, so every line is cut to the width.
      ctx.ui.setHeader(() => ({ render: (width) => cut(headerLines(width), width), invalidate() {} }));
      ctx.ui.setEditorComponent((t, theme, keybindings) => {
        tui = t;
        return new BoxEditor(t, theme, keybindings, { paddingX: 0 });
      });
      ctx.ui.setWorkingVisible(false);
      ctx.ui.setHiddenThinkingLabel(''); // 0.1.0 showed no thinking at all
      ctx.ui.setFooter((t) => {
        tui = t;
        return {
          render: (width) => {
            const usage = ctx.getContextUsage();
            const left = usage?.percent == null ? null : Math.max(0, 100 - Math.round(usage.percent));
            return cut([footerLine({ cwd: ctx.cwd, model: routed, contextLeft: left }, width)], width);
          },
          invalidate() {},
        };
      });
    }
    const keys = PROVIDERS.filter((p) => registry.getProviderAuthStatus(p.id)?.configured);
    if (!keys.length && ui) ui.notify('Janus has no free keys yet. Quit (Ctrl+C twice) and run: janus setup', 'warning');
  });

  pi.on('agent_start', async (_event, ctx) => {
    if (ctx.mode !== 'tui') return;
    stopWorking(ctx);
    const start = Date.now();
    let phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    let changed = start;
    working = {
      timer: setInterval(() => {
        if (Date.now() - changed >= 15_000) {
          phrase = PHRASES[Math.floor(Math.random() * PHRASES.length)];
          changed = Date.now();
        }
        tui?.requestRender();
      }, 1000),
    };
    ctx.ui.setWidget('janus-working', () => ({
      render: (width) => cut([workingLine(phrase, Math.floor((Date.now() - start) / 1000), width)], width),
      invalidate() {},
    }));
  });
  pi.on('agent_settled', async (_event, ctx) => stopWorking(ctx));
  pi.on('session_shutdown', async (_event, ctx) => {
    stopWorking(ctx);
    ending.abort(); // `janus -p` must not wait for a slow download before it exits
  });

  pi.registerMarkdownTransformer((markdown, context) =>
    context.messageType === 'assistant'
      ? starAnswer(markdown)
      : context.messageType === 'user'
        ? boxUserMessage(markdown, context.availableWidth)
        : markdown,
  );

  pi.registerCommand('help', {
    description: 'How to use Janus',
    handler: async (_args, ctx) => {
      ctx.ui.notify(
        [
          'Type a task in plain words: Janus reads files, edits them and runs commands.',
          '',
          '/free      which free models are awake, resting or missing a key',
          '/model     pick a model by hand (janus/free is the automatic one)',
          '/compact   shrink a long conversation',
          '/resume    open an earlier session (janus -c continues the last one)',
          '/hotkeys   keyboard shortcuts',
          '!ls        run a shell command',
          'esc        stop the current answer; ctrl+c twice to quit',
          '',
          'Keys: janus setup · settings and sessions: ~/.janus/agent · https://github.com/janus-sh/janus',
        ].join('\n'),
        'info',
      );
    },
  });

  pi.registerCommand('free', {
    description: 'Show the free models Janus routes between',
    handler: async (_args, ctx) => {
      const now = Date.now();
      const lines = (list?.models ?? []).map((entry) => {
        const model = usable(false)(entry);
        const until = Math.max(rest.get(keyOf(entry)) ?? 0, rest.get(entry.provider) ?? 0);
        const state = !model
          ? 'no key'
          : until > now
            ? `resting ${Math.ceil((until - now) / 60_000)} min`
            : entry.ping === 'down'
              ? 'awake, missed the last ping'
              : 'awake';
        const iq = entry.iq != null ? ` iq ${entry.iq}` : '';
        return `${shortName(entry)}${iq}${entry.new ? ' new' : ''} — ${state}`;
      });
      const gone = healed.dropped.length
        ? [`no longer free on OpenRouter, skipped: ${healed.dropped.map((id) => shortName({ provider: 'openrouter', id })).join(', ')}`]
        : healed.ignored
          ? [ignoredLine(healed.ignored)]
          : [];
      ctx.ui.notify([`free models (list of ${list?.updated ?? 'unknown date'}):`, ...lines, ...gone].join('\n'), 'info');
    },
  });

  // OpenRouter credits requests to the app named in these headers (its public
  // app rankings), and some free models only serve named coding agents.
  // The category puts Janus into OpenRouter's cli-agent ranking.
  pi.registerProvider('openrouter', {
    headers: {
      'HTTP-Referer': 'https://github.com/janus-sh/janus',
      'X-Title': 'Janus',
      'X-OpenRouter-Title': 'Janus',
      'X-OpenRouter-Categories': 'cli-agent',
    },
  });

  // Credit in commits (lib/coauthor.mjs): the trailer goes into every
  // `git commit` the agent runs, unless the person turned it off.
  const credit = coauthorEnabled();
  pi.on('tool_call', async (event) => {
    if (credit && event.toolName === 'bash' && typeof event.input?.command === 'string') {
      event.input.command = withTrailer(event.input.command);
    }
    return undefined;
  });

  pi.registerProvider('janus', {
    name: 'Janus',
    baseUrl: 'https://github.com/janus-sh/janus', // required by the engine; requests never go here
    api: 'janus-router',
    apiKey: 'free',
    models: [
      {
        id: 'free',
        name: 'Janus free (auto)',
        reasoning: true,
        input: ['text', 'image'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
        maxTokens: 32768,
      },
    ],
    streamSimple: (_model, context, options) => route(context, options),
  });

  function route(context, options = {}) {
    const out = createAssistantMessageEventStream();
    let tries = [];

    // The engine's own key, headers and output cap belong to `janus/free`;
    // each real model gets its own.
    const { apiKey: _k, headers: _h, env: _e, maxTokens: _m, deferred: _d, ...passOn } = options;

    (async () => {
      await catalogueReady;
      tries = plan({
        models: list?.models ?? [],
        usable: usable(hasImages(context.messages)),
        rest,
        now: Date.now(),
        tokens: estimateTokens(context.messages),
      }).slice(0, MAX_TRIES);
      debug('plan', tries.map(({ entry }) => keyOf(entry)).join(' '));

      let lastError = null;
      const refusedKeys = new Set();
      for (const { entry, model } of tries) {
        if (options.signal?.aborted) break;
        if (refusedKeys.has(entry.provider)) continue;
        let inner;
        try {
          inner = registry.streamSimple(model, context, passOn);
        } catch (err) {
          lastError = err?.message ?? String(err);
          debug('throw', keyOf(entry), lastError);
          resting(entry.provider, restFor(lastError, Date.now()).ms);
          continue;
        }
        let held = null;
        let spoke = false;
        let failed = null;
        for await (const event of inner) {
          if (event.type === 'start') {
            held = event;
            continue;
          }
          if (event.type === 'error' && !spoke && event.reason !== 'aborted' && !options.signal?.aborted) {
            failed = event;
            break;
          }
          if (!spoke) {
            spoke = true;
            routed = `${entry.provider}/${entry.id}`;
            tui?.requestRender();
            if (held) out.push(held);
          }
          if (event.type === 'error' && event.reason !== 'aborted' && !options.signal?.aborted) {
            // Broke off after it started: the engine retries the turn, and
            // this model rests so the retry lands on the next one.
            const cause = event.error?.errorMessage;
            const { ms, scope } = restFor(cause, Date.now());
            if (ms > 0 && event.error) {
              resting(scope === 'provider' ? entry.provider : keyOf(entry), ms);
              event.error.errorMessage = midStreamError(cause, shortName(entry));
            }
            debug('broke', keyOf(entry), String(cause).slice(0, 300));
          }
          if (event.type === 'done' || event.type === 'error') {
            const message = event.type === 'done' ? event.message : event.error;
            if (message?.usage) message.usage.cost = { ...ZERO_COST };
          }
          out.push(event);
        }
        if (!failed) {
          debug('ended', keyOf(entry), spoke ? '' : '(empty)');
          out.end();
          return;
        }
        lastError = failed.error?.errorMessage ?? 'unknown error';
        const { ms, scope } = restFor(lastError, Date.now());
        debug('refused', keyOf(entry), `rest ${Math.round(ms / 1000)}s ${scope}:`, lastError.slice(0, 300));
        if (scope === 'provider') refusedKeys.add(entry.provider);
        if (ms > 0) resting(scope === 'provider' ? entry.provider : keyOf(entry), ms);
      }
      out.push({
        type: 'error',
        reason: options.signal?.aborted ? 'aborted' : 'error',
        error: failure(lastError, tries.length),
      });
      out.end();
    })().catch((err) => {
      out.push({ type: 'error', reason: 'error', error: failure(err?.message ?? String(err), tries.length) });
      out.end();
    });
    return out;
  }

  function failure(lastError, tried) {
    const text = !tried
      ? 'Janus has no free model to use: no keys yet, or the conversation is too long for every free model. Run `janus setup` to add keys, or /compact.'
      : restFor(lastError, Date.now()).scope === 'provider'
        ? `A free key was refused (${String(lastError).slice(0, 120)}). Run \`janus setup\` to paste it again.`
        : `All ${tried} free models refused this request. Last answer: ${lastError}`;
    return {
      role: 'assistant',
      content: [],
      api: 'janus-router',
      provider: 'janus',
      model: 'free',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST } },
      stopReason: 'error',
      errorMessage: text,
      timestamp: Date.now(),
    };
  }
}
