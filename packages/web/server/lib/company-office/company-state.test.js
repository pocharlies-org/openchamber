import { describe, expect, test } from 'vitest';
import { buildCompanyState, summariseLiteLLMModels } from './company-state.js';

describe('LiteLLM model catalogue', () => {
  const providers = {
    all: [{
      id: 'litellm-auto',
      models: {
        deepseek: {
          id: 'deepseek-v4-flash-0731',
          name: 'DeepSeek V4 Flash',
          status: 'active',
          api: { url: 'https://private.example/v1' },
          headers: { Authorization: 'secret' },
          capabilities: { reasoning: true, attachment: false, toolcall: true },
        },
      },
    }],
  };

  test('projects configured LiteLLM models without private connection data', () => {
    expect(summariseLiteLLMModels(providers)).toEqual([{
      providerID: 'litellm-auto',
      modelID: 'deepseek-v4-flash-0731',
      name: 'DeepSeek V4 Flash',
      status: 'active',
      reasoning: true,
      attachments: false,
      toolcall: true,
    }]);
    expect(JSON.stringify(summariseLiteLLMModels(providers))).not.toContain('private.example');
    expect(JSON.stringify(summariseLiteLLMModels(providers))).not.toContain('secret');
  });

  test('distinguishes an unavailable catalogue from an empty one', () => {
    expect(summariseLiteLLMModels(null)).toBeNull();
    expect(summariseLiteLLMModels({ all: [{ id: 'litellm-auto', models: {} }] })).toEqual([]);
  });

  test('publishes the catalogue and its source state in the company snapshot', () => {
    const state = buildCompanyState({ providers, now: () => 1 });
    expect(state.sources.models).toBe('ready');
    expect(state.models).toHaveLength(1);
  });

  test('publishes the configured default model without changing role overrides', () => {
    const state = buildCompanyState({
      roles: {
        defaultModel: { providerID: 'litellm-auto', modelID: 'deepseek-v4-flash-0731' },
        roles: [],
      },
      now: () => 1,
    });
    expect(state.defaultModel).toEqual({ providerID: 'litellm-auto', modelID: 'deepseek-v4-flash-0731' });
  });
});
