# Contributing to Janus

Janus is small on purpose: about a dozen files, no build step, one dependency (the engine). Changes that keep it that way are the easiest to merge.

## Set up

```sh
git clone https://github.com/janus-sh/janus.git
cd janus
npm ci
npm test
node bin/janus.mjs --version
```

Needs Node.js 22.19 or newer. To try your copy without touching your real settings:

```sh
JANUS_HOME=$(mktemp -d) node bin/janus.mjs setup
```

## Where things are

| Path | What it does |
| --- | --- |
| `bin/janus.mjs` | the command; hands over to `lib/main.mjs` |
| `lib/main.mjs` | start-up: settings folder, keys, then the engine |
| `lib/setup.mjs` | first run and `janus setup`: free keys, default settings |
| `lib/providers.mjs` | the free services Janus can use |
| `lib/free-models.json` | the ranked list of free models shipped with the package |
| `lib/list.mjs` | loads that list or the cached copy, and downloads a fresh one in the background |
| `lib/route.mjs` | which model gets the next request, and when a model rests |
| `lib/catalogue.mjs` | OpenRouter's own catalogue: drops models that stopped being free, adds new free ones |
| `lib/store.mjs` | writes cache files so that a reader never sees half of one |
| `extension/janus.mjs` | the router inside the engine: `/free`, retries, the footer |
| `lib/look.mjs`, `lib/phrases.json` | logo, colors, loading phrases |
| `lib/coauthor.mjs` | the credit line in commits |
| `lib/home.mjs` | the settings folder and the names it had before |
| `test/` | `node --test`, no framework |

`JANUS_DEBUG=1` writes every routing decision to `~/.janus/agent/janus-debug.log`. Attach that file to any routing bug.

## Rules for changes

- **Free means free.** A service goes into `lib/providers.mjs` only if a person can get a key and use it without paying and without a card. Link the service's own page that says so, and the date you checked. A trial that needs a card is listed as optional and says so.
- **A model goes into the list only if it is free today and can call tools.** An agent that cannot call tools cannot edit files.
- **Janus uses only the keys it was given in `janus setup`.** No code that spends a paid key found in the shell by default.
- **No new runtime dependencies** without a very good reason.
- **A behaviour change comes with a test.** `npm test` must pass.
- **Plain words** in messages and docs. Short sentences.

## Pull requests

- One change per pull request. Small ones get reviewed fast.
- Say what you saw, what you changed and how you checked it.
- If a person using Janus would notice the change, add a line to `CHANGELOG.md`.
- CI runs the tests on every pull request.

## Reporting bugs

Open an [issue](https://github.com/janus-sh/janus/issues) with the error text, what you ran, your OS and the output of `janus --version`. For security problems see [SECURITY.md](SECURITY.md).
