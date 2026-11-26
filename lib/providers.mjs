/**
 * The free services Janus can run on. `id` is the engine's provider id; the
 * key a person pastes in `janus setup` is stored under it in auth.json.
 * Only models of these providers, and only the ones in free-models.json,
 * are ever picked by the router.
 */
export const PROVIDERS = [
  {
    id: 'openrouter',
    name: 'OpenRouter',
    env: 'OPENROUTER_API_KEY',
    keyUrl: 'https://openrouter.ai/keys',
    // `janus doctor`: a request that costs nothing (no model is called)
    check: { url: 'https://openrouter.ai/api/v1/key', auth: 'bearer' },
    note: 'one key, about a dozen free models; 50 requests a day, 1000 after a one-time $10 top-up',
  },
  {
    id: 'google',
    name: 'Google Gemini',
    env: 'GEMINI_API_KEY',
    keyUrl: 'https://aistudio.google.com/apikey',
    check: { url: 'https://generativelanguage.googleapis.com/v1beta/models', auth: 'x-goog-api-key' },
    note: 'free tier while billing is off on the project; not offered in every country',
  },
  {
    id: 'groq',
    name: 'Groq',
    env: 'GROQ_API_KEY',
    keyUrl: 'https://console.groq.com/keys',
    check: { url: 'https://api.groq.com/openai/v1/models', auth: 'bearer' },
    note: 'free plan, very fast; 8K tokens a minute, so big files hit the limit quickly',
  },
  {
    id: 'cerebras',
    name: 'Cerebras',
    env: 'CEREBRAS_API_KEY',
    keyUrl: 'https://cloud.cerebras.ai',
    check: { url: 'https://api.cerebras.ai/v1/models', auth: 'bearer' },
    note: 'not free any more: a $5 trial for 30 days, and it asks for a card',
  },
];

export const PROVIDER_IDS = PROVIDERS.map((p) => p.id);

/**
 * Services that had a free tier and lost it (Mistral, 2026-11: API keys now
 * need billing). A key saved earlier stays in auth.json unused; the same key
 * in the shell is ignored like any paid key.
 */
export const RETIRED_ENV = ['MISTRAL_API_KEY'];
