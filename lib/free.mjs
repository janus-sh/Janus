/**
 * The lines of `/free`: one per model, at most 80 columns, plain text.
 * A resting model says why and when it is back, from what the router
 * recorded when the model refused (lib/route.mjs restFor).
 */

const WIDTH = 80;

export const shortName = (entry) => `${entry.id.replace(/:free$/, '').split('/').pop()} · ${entry.provider}`;

const pad = (n) => String(n).padStart(2, '0');

/** "back in ~40 s", "back in 5 min", "back in 6 h", or, for a daily cap, "back at 03:00" (local time). */
export function backAt(until, now, why) {
  const ms = until - now;
  if (why === 'daily cap') {
    const d = new Date(until);
    return `back at ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  if (ms < 90_000) return `back in ~${Math.max(1, Math.round(ms / 10_000) * 10)} s`;
  if (ms < 90 * 60_000) return `back in ${Math.round(ms / 60_000)} min`;
  return `back in ${Math.round(ms / 3_600_000)} h`;
}

/**
 * What /free says about one model.
 * hasKey: the person has a key for its service; until/why: the longest rest
 * on the model or its whole service; gone: no longer free on OpenRouter.
 */
export function modelState({ hasKey, until = 0, why, ping, gone }, now) {
  if (gone) return 'not free any more';
  if (!hasKey) return 'no key';
  if (until > now) return `resting: ${why ?? 'refused'}, ${backAt(until, now, why)}`;
  return ping === 'down' ? 'awake, missed the last ping' : 'awake';
}

/** One line, cut to `width`: the model name gives way first, the state is kept whole. */
export function freeLine(entry, state, width = WIDTH) {
  const tail = `${entry.iq != null ? ` iq ${entry.iq}` : ''}${entry.new ? ' new' : ''} — ${state}`;
  const name = shortName(entry);
  const service = ` · ${entry.provider}`;
  const room = width - [...tail].length - [...service].length; // for the model's own name
  if ([...name].length + [...tail].length <= width) return `${name}${tail}`;
  if (room < 6) return [...`${name}${tail}`].slice(0, width).join('');
  const model = [...name.slice(0, name.length - service.length)];
  return `${model.slice(0, room - 1).join('')}…${service}${tail}`;
}
