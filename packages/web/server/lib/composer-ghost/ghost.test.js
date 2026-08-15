import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../opencode/shared.js', () => ({ readConfig: vi.fn() }));

const { generateComposerGhost, resolveGhostEndpoint } = await import('./ghost.js');
const { readConfig } = await import('../opencode/shared.js');

const LITELLM_PLUGIN_CONFIG = {
  plugin: [
    'some-unrelated-plugin',
    ['file:///plugins/litellm.js', { baseURL: 'https://llm.example.com/v1/', apiKey: 'sk-test' }],
  ],
};

const okResponse = (content) => ({
  ok: true,
  status: 200,
  json: async () => ({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 210, prompt_tokens_details: { cached_tokens: 128 } },
  }),
});

const messages = [
  { role: 'system', content: 'you are a ghost' },
  { role: 'user', content: 'arregla el stock' },
];

let fetchMock;

beforeEach(() => {
  readConfig.mockReset();
  readConfig.mockReturnValue(LITELLM_PLUGIN_CONFIG);
  fetchMock = vi.fn(async () => okResponse('revisa el stock'));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.OPENCHAMBER_GHOST_BASE_URL;
  delete process.env.OPENCHAMBER_GHOST_API_KEY;
  delete process.env.OPENCHAMBER_GHOST_MODEL;
});

describe('resolveGhostEndpoint', () => {
  it('reads the endpoint from the plugin entry that carries a baseURL', () => {
    expect(resolveGhostEndpoint('/repo')).toEqual({
      baseURL: 'https://llm.example.com/v1',
      apiKey: 'sk-test',
      source: 'file:///plugins/litellm.js',
    });
  });

  it('lets the environment override the configured endpoint', () => {
    process.env.OPENCHAMBER_GHOST_BASE_URL = 'https://other.example.com/v1';
    process.env.OPENCHAMBER_GHOST_API_KEY = 'sk-env';
    expect(resolveGhostEndpoint('/repo')).toEqual({
      baseURL: 'https://other.example.com/v1',
      apiKey: 'sk-env',
      source: 'env',
    });
  });

  it('returns null when no plugin entry carries a baseURL', () => {
    readConfig.mockReturnValue({ plugin: ['plain-plugin', ['x', { providerKey: 'p' }]] });
    expect(resolveGhostEndpoint('/repo')).toBeNull();
  });
});

describe('generateComposerGhost', () => {
  it('sends max_completion_tokens and reasoning_effort, never max_tokens', async () => {
    await generateComposerGhost({ directory: '/repo', messages });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://llm.example.com/v1/chat/completions');
    const body = JSON.parse(init.body);
    // A reasoning model spends `max_tokens` entirely on reasoning and answers
    // with `content: null`; these two params are what make it emit text.
    expect(body.max_completion_tokens).toBe(256);
    expect(body.reasoning_effort).toBe('low');
    expect(body).not.toHaveProperty('max_tokens');
    expect(body.stream).toBe(false);
    expect(init.headers.Authorization).toBe('Bearer sk-test');
  });

  it('forwards a prompt cache key only when one is supplied', async () => {
    await generateComposerGhost({ directory: '/repo', messages, promptCacheKey: 'ghost:session-1' });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt_cache_key).toBe('ghost:session-1');

    await generateComposerGhost({ directory: '/repo', messages });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).not.toHaveProperty('prompt_cache_key');
  });

  it('clamps the completion budget', async () => {
    await generateComposerGhost({ directory: '/repo', messages, maxCompletionTokens: 99999 });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).max_completion_tokens).toBe(512);

    await generateComposerGhost({ directory: '/repo', messages, maxCompletionTokens: 1 });
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).max_completion_tokens).toBe(32);
  });

  it('reports a content-less answer as a miss, not a failure', async () => {
    fetchMock.mockResolvedValueOnce(okResponse(null));
    await expect(generateComposerGhost({ directory: '/repo', messages }))
      .resolves.toMatchObject({ text: null });
  });

  it('surfaces cache usage when the endpoint reports it', async () => {
    const result = await generateComposerGhost({ directory: '/repo', messages });
    expect(result).toMatchObject({ cachedTokens: 128, promptTokens: 210, model: 'agent' });
  });

  it('uses the model from the environment when set', async () => {
    process.env.OPENCHAMBER_GHOST_MODEL = 'flash';
    await generateComposerGhost({ directory: '/repo', messages });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).model).toBe('flash');
  });

  it('marks rate limiting so the caller can drop it silently', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 429, text: async () => 'usage limit' });
    await expect(generateComposerGhost({ directory: '/repo', messages }))
      .rejects.toMatchObject({ statusCode: 429, code: 'ghost_rate_limited' });
  });

  it('rejects when no endpoint is configured', async () => {
    readConfig.mockReturnValue({});
    await expect(generateComposerGhost({ directory: '/repo', messages }))
      .rejects.toMatchObject({ statusCode: 501, code: 'ghost_endpoint_unconfigured' });
  });

  it('rejects an empty or unusable message list', async () => {
    await expect(generateComposerGhost({ directory: '/repo', messages: [] }))
      .rejects.toMatchObject({ statusCode: 400 });
    await expect(generateComposerGhost({ directory: '/repo', messages: [{ role: 'tool', content: 'x' }] }))
      .rejects.toMatchObject({ statusCode: 400 });
  });
});
