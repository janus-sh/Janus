# Changelog

## [0.3.2] - unreleased

### Fixed

- New free models found in OpenRouter's catalogue no longer jump ahead of ranked ones. Ranked models that answered the last ping go first, then the new ones, and models known to be down go last. If the catalogue would drop more than three quarters of the OpenRouter models at once, Janus treats it as a broken catalogue, keeps the list and says so in `/free`.
- The model list download no longer loses to a slow connection. It used to give up after 3 seconds, so on a slow line Janus stayed on the list shipped with the package. Now it gets 10 seconds in the background; start-up does not wait for it, and the fresh list is used from the next request.

## [0.3.1] - 2026-11-26

### New Features

- Janus now checks OpenRouter's own list at start: models that stopped being free are skipped right away, and new free models are picked up the same day, before our ranked list catches up. `/free` marks them `new` and names the ones it skipped. Needs an OpenRouter key; offline, the last copy of the list is used.

### Changed

- The free model list is refreshed for late November: eight OpenRouter models that are no longer free are gone, and six new free models that can use tools are in, the strongest for coding first.
- Mistral is no longer offered as a free key: its API now needs billing. A key saved earlier stays where it is and is not used.

### Fixed

- The model list download no longer leaves a `free-models.json.tmp` file behind when saving it fails.

## [0.3.0] - 2026-11-26

### Changed

- New name: Janus.
- The package is now `@janus-sh/janus`, and the command is `janus`.
- The old command keeps working. On the first run, settings, keys and sessions are copied from the old settings folder to `~/.janus`; the old folder is left as it was.
- Old environment variable names still work; the new `JANUS_*` names win when both are set.

### Fixed

- The key notes were out of date. Cerebras is no longer free: it gives a $5 trial for 30 days and asks for a card. Mistral has a free plan with $10 a month in API credits, not the old Experiment plan. Groq's free plan allows 8K tokens a minute. `janus setup` and the README now say so, and warn that free tiers may use what you send to improve their models.

## [0.2.2] - 2026-09-30

### New Features

- Commits the agent makes carry a co-author line naming the agent, like Aider and OpenCode do. Turn it off with `"janusCoauthor": false` in `~/.janus/agent/settings.json` or `JANUS_COAUTHOR=0`. Needs git 2.32 or newer; older git is left alone.
- Janus now shows up in OpenRouter's ranking of CLI agents.

### Fixed

- `janus --version` no longer needs a writable home folder, and `janus --help` no longer crashes when it cannot write settings (issue #93).

## [0.2.1] - 2026-09-29

### Changed

- Janus looks like this project's 2025 CLI (0.1.0) again: the block logo in the orange-to-violet gradient, the welcome line and tips, your message and the input in a rounded box with `>`, `✦` before answers, the old loading phrases ("Generating thrust...") and the footer. `/help` is back.

### Fixed

- A free model that broke off in the middle of an answer ended the turn with an error. Now that model rests and the turn is retried on the next free model.
- The model list download no longer leaves a `free-models.json.tmp` file behind.
- The footer shows which free model answered and how much context is left, and shortens itself in a narrow terminal.
- Janus crashed on start in a terminal narrower than 84 columns (the header line was too long). The header now fits any width.

## [0.2.0] - 2026-09-29

### New Features

- Janus is a free coding agent in your terminal: `npm i -g @janus-sh/janus`, then `janus`.
- Every request goes to the smartest free model that is answering today. If a model refuses before it answers (rate limit, daily cap, overload), the next one takes the same request at once.
- `janus setup` saves free keys (OpenRouter, Google Gemini, Groq, Cerebras, Mistral). Keys stay on your machine.
- `/free` shows which free models are awake, resting or missing a key.
- The list of free models refreshes twice a day.
