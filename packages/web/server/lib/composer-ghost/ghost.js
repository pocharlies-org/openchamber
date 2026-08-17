import fs from 'fs';
import os from 'os';
import path from 'path';
import { readConfig } from '../opencode/shared.js';

/**
 * Ghost autocomplete for the composer: one direct, non-streaming chat
 * completion against the OpenAI-compatible endpoint the user already
 * configured for OpenCode.
 *
 * This does not go through `small-model`, which sends `max_tokens`. Reasoning
 * models can spend that budget without emitting content, so this module must
 * use `max_completion_tokens` with `reasoning_effort`.
 */

const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_MAX_COMPLETION_TOKENS = 256;
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TOTAL_CHARS = 120000;

const trimTrailingSlash = (value) => value.replace(/\/+$/, '');

/**
 * Expand OpenCode's `{env:NAME}` / `{file:PATH}` indirection. Relative file
 * paths resolve against the user config directory, which is where the plugin
 * entry that carries them lives.
 */
const expandSecret = (value) => {
  if (typeof value !== 'string') return null;

  const envMatch = value.match(/^\{env:([^}]+)\}$/i);
  if (envMatch) return process.env[envMatch[1].trim()]?.trim() || null;

  const fileMatch = value.match(/^\{file:(.+)\}$/i);
  if (!fileMatch) return value.trim() || null;

  const configured = fileMatch[1].trim();
  let resolved;
  if (configured === '~' || configured.startsWith('~/') || configured.startsWith('~\\')) {
    resolved = path.join(os.homedir(), configured.slice(2));
  } else if (path.isAbsolute(configured)) {
    resolved = configured;
  } else {
    resolved = path.resolve(path.join(os.homedir(), '.config', 'opencode'), configured);
  }

  const key = fs.readFileSync(resolved, 'utf8').trim();
  if (!key) throw new Error(`Configured ghost apiKey file is empty: ${resolved}`);
  return key;
};

/**
 * The OpenAI-compatible endpoint to use. OpenCode's own provider is added at
 * runtime by a plugin, so its `baseURL`/`apiKey` live in the plugin entry's
 * options rather than under `provider.<id>`; that is the only place to read
 * them from. Env vars win so a deployment can point the ghost elsewhere
 * without touching OpenCode's config.
 */
export function resolveGhostEndpoint(workingDirectory) {
  const envBaseURL = process.env.OPENCHAMBER_GHOST_BASE_URL?.trim();
  const envApiKey = process.env.OPENCHAMBER_GHOST_API_KEY?.trim();
  if (envBaseURL) {
    return {
      baseURL: trimTrailingSlash(envBaseURL),
      apiKey: envApiKey || null,
      source: 'env',
    };
  }

  const config = readConfig(workingDirectory);
  const plugins = Array.isArray(config?.plugin) ? config.plugin : [];
  for (const entry of plugins) {
    if (!Array.isArray(entry)) continue;
    const [specifier, options] = entry;
    if (!options || typeof options !== 'object') continue;
    if (typeof options.baseURL !== 'string' || !options.baseURL) continue;
    return {
      baseURL: trimTrailingSlash(options.baseURL),
      apiKey: envApiKey || expandSecret(options.apiKey),
      source: typeof specifier === 'string' ? specifier : 'plugin',
    };
  }

  return null;
}

const sanitizeMessages = (messages) => {
  if (!Array.isArray(messages) || messages.length === 0) {
    const error = new Error('messages must be a non-empty array');
    error.statusCode = 400;
    throw error;
  }

  const sanitized = [];
  let total = 0;
  for (const message of messages) {
    const role = message?.role;
    const content = message?.content;
    if (role !== 'system' && role !== 'user' && role !== 'assistant') continue;
    if (typeof content !== 'string') continue;
    total += content.length;
    if (total > MAX_TOTAL_CHARS) break;
    sanitized.push({ role, content });
  }

  if (sanitized.length === 0) {
    const error = new Error('messages contained no usable content');
    error.statusCode = 400;
    throw error;
  }
  return sanitized;
};

/**
 * Run one ghost completion. Returns `text: null` when the model produced no
 * content — a reasoning model that spent its whole budget thinking answers
 * HTTP 200 with `content: null`, which is a miss, not a failure.
 */
export async function generateComposerGhost({
  directory,
  messages,
  model,
  maxCompletionTokens,
  promptCacheKey,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  signal,
} = {}) {
  const endpoint = resolveGhostEndpoint(directory);
  if (!endpoint) {
    const error = new Error('No OpenAI-compatible endpoint is configured for composer ghost completions');
    error.statusCode = 501;
    error.code = 'ghost_endpoint_unconfigured';
    throw error;
  }

  const sanitized = sanitizeMessages(messages);
  const resolvedModel = (typeof model === 'string' && model.trim())
    || process.env.OPENCHAMBER_GHOST_MODEL?.trim()
    || DEFAULT_MODEL;
  const budget = Number.isFinite(maxCompletionTokens)
    ? Math.min(512, Math.max(32, Math.trunc(maxCompletionTokens)))
    : DEFAULT_MAX_COMPLETION_TOKENS;

  const body = {
    model: resolvedModel,
    messages: sanitized,
    // See the file header: `max_tokens` yields `content: null` here.
    max_completion_tokens: budget,
    reasoning_effort: 'low',
    stream: false,
  };
  // Stable per session, never per keystroke: a key that changes with the
  // draft would open a fresh cache namespace on every poll.
  if (typeof promptCacheKey === 'string' && promptCacheKey) {
    body.prompt_cache_key = promptCacheKey;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort, { once: true });

  let response;
  try {
    response = await fetch(`${endpoint.baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (cause) {
    const error = new Error(
      controller.signal.aborted ? 'Ghost completion timed out' : `Ghost completion request failed: ${cause?.message || cause}`,
    );
    error.statusCode = controller.signal.aborted ? 504 : 502;
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    const error = new Error(`Ghost completion upstream ${response.status}: ${detail.slice(0, 300)}`);
    // Rate limiting is routine on a shared plan; the caller drops it silently.
    error.statusCode = response.status === 429 ? 429 : 502;
    if (response.status === 429) error.code = 'ghost_rate_limited';
    throw error;
  }

  const payload = await response.json().catch(() => null);
  const raw = payload?.choices?.[0]?.message?.content;
  const text = typeof raw === 'string' && raw.trim() ? raw : null;

  return {
    text,
    model: resolvedModel,
    // Surfaced so cache engagement can be confirmed against a real
    // conversation instead of assumed. This endpoint does not always
    // report it.
    cachedTokens: payload?.usage?.prompt_tokens_details?.cached_tokens ?? null,
    promptTokens: payload?.usage?.prompt_tokens ?? null,
  };
}
