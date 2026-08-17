import crypto from 'crypto';

export const GHOST_PROMPT_VERSION = 2;
export const GHOST_PREFIX_BUDGET_BYTES = 16 * 1024;
export const GHOST_COMPACT_TARGET_BYTES = 8 * 1024;
export const GHOST_FIRST_USER_MAX_BYTES = 2 * 1024;

export const GHOST_SYSTEM_PROMPT =
  `OpenChamber ghost prompt v${GHOST_PROMPT_VERSION}. Predict the complete message the user would send next. `
  + 'Write only in the user voice and language. Never answer the conversation.';

export const GHOST_SUFFIX =
  '[GHOST AUTOCOMPLETE: write the complete next user message. One or two short sentences of plain text; '
  + 'no markdown, lists, quotes, code fences, or preamble.]';

const byteLength = (value) => Buffer.byteLength(value, 'utf8');

const truncateUtf8 = (value, maxBytes) => {
  if (byteLength(value) <= maxBytes) return value;
  const buffer = Buffer.from(value, 'utf8').subarray(0, maxBytes);
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer).replace(/\uFFFD$/, '');
};

const messageText = (message) => {
  const parts = Array.isArray(message?.parts) ? message.parts : [];
  return parts
    .filter((part) => part?.type === 'text' && part.synthetic !== true && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n')
    .trim();
};

export function projectGhostTurns(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message, index) => {
    const role = message?.info?.role;
    if (message?.info?.summary === true) return [];
    if (role === 'assistant' && !Number.isFinite(message?.info?.time?.completed)) return [];
    const text = messageText(message);
    if ((role !== 'user' && role !== 'assistant') || !text) return [];
    return [{
      id: typeof message?.info?.id === 'string' ? message.info.id : `${index}:${role}`,
      role,
      text,
    }];
  });
}

const firstSentence = (text) => {
  const match = text.match(/^.*?(?:[.!?](?=\s|$)|$)/s);
  return match?.[0]?.trim() || text.trim();
};

const prefixMessages = (state) => [
  { role: 'system', content: state.systemPrompt },
  { role: 'user', content: state.firstUser },
  ...state.ledger.map(({ role, text }) => ({ role, content: text })),
];

const prefixBytes = (state) => byteLength(JSON.stringify(prefixMessages(state)));

const compactLedger = (state) => {
  const compacted = state.ledger.map((turn) => ({ ...turn }));
  let compactedPrefixEnd = 0;
  for (let index = 0; index < compacted.length; index += 1) {
    if (compacted[index].role !== 'assistant') continue;
    compacted[index].text = firstSentence(compacted[index].text);
    if (prefixBytes({ ...state, ledger: compacted }) <= GHOST_COMPACT_TARGET_BYTES) {
      compactedPrefixEnd = index + 1;
      break;
    }
  }
  if (prefixBytes({ ...state, ledger: compacted }) > GHOST_COMPACT_TARGET_BYTES) {
    const error = new Error('Ghost user context exceeds the deterministic compaction budget');
    error.statusCode = 409;
    error.code = 'ghost_context_budget_exceeded';
    throw error;
  }
  state.ledger = compacted;
  state.compactedPrefixEnd = compactedPrefixEnd;
  state.generation += 1;
};

export function reconcileGhostContext(existing, { sessionId, directory, turns }) {
  const firstUserIndex = turns.findIndex((turn) => turn.role === 'user');
  if (firstUserIndex < 0) return null;
  const firstUser = truncateUtf8(turns[firstUserIndex].text, GHOST_FIRST_USER_MAX_BYTES);
  const nextTurns = turns.slice(firstUserIndex + 1);

  const state = {
    sessionId,
    directory,
    generation: GHOST_PROMPT_VERSION,
    systemPrompt: GHOST_SYSTEM_PROMPT,
    firstUser,
    ledger: [],
    compactedPrefixEnd: 0,
  };
  const previousLedger = existing?.directory === directory && existing.firstUser === firstUser
    ? existing.ledger
    : null;
  for (const turn of nextTurns) {
    const index = state.ledger.length;
    const previousTurn = previousLedger?.[index];
    const unchanged = previousTurn?.id === turn.id
      && previousTurn.role === turn.role
      && previousTurn.text === turn.text;
    state.ledger.push(unchanged ? previousTurn : { id: turn.id, role: turn.role, text: turn.text });
  }
  if (prefixBytes(state) > GHOST_PREFIX_BUDGET_BYTES) compactLedger(state);
  return state;
}

export function buildGhostPrompt(state, draft = '') {
  const prefix = prefixMessages(state);
  const prefixJson = JSON.stringify(prefix);
  const prefixHash = crypto.createHash('sha256').update(prefixJson).digest('hex');
  return {
    messages: [
      ...prefix,
      { role: 'user', content: draft },
      { role: 'user', content: GHOST_SUFFIX },
    ],
    prefixHash,
    prefixBytes: byteLength(prefixJson),
    generation: state.generation,
    turnCount: 1 + state.ledger.length,
    promptCacheKey: `ghost:${state.sessionId}:${state.generation}:${prefixHash}`,
  };
}

export function createGhostContextStore({ maxEntries = 100, ttlMs = 60 * 60 * 1000, now = Date.now } = {}) {
  const entries = new Map();
  const entryKey = (sessionId, directory) => `${directory || ''}\0${sessionId}`;
  const prune = () => {
    const cutoff = now() - ttlMs;
    for (const [key, entry] of entries) if (entry.lastAccess < cutoff) entries.delete(key);
    while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
  };
  return {
    reconcile(input) {
      prune();
      const key = entryKey(input.sessionId, input.directory);
      const previous = entries.get(key);
      if (previous) entries.delete(key);
      const previousHash = previous ? buildGhostPrompt(previous.state, '').prefixHash : null;
      const state = reconcileGhostContext(previous?.state, input);
      if (!state) return null;
      const samePrefix = previousHash !== null
        && previousHash === buildGhostPrompt(state, '').prefixHash;
      entries.set(key, {
        state,
        lastAccess: now(),
        ...(samePrefix && previous.completion ? { completion: previous.completion } : {}),
        ...(samePrefix && previous.pendingCompletion ? { pendingCompletion: previous.pendingCompletion } : {}),
      });
      prune();
      return { state, changed: !samePrefix };
    },
    get(sessionId, directory) {
      const key = entryKey(sessionId, directory);
      const entry = entries.get(key);
      if (!entry || entry.lastAccess < now() - ttlMs) {
        entries.delete(key);
        return null;
      }
      entries.delete(key);
      entries.set(key, { ...entry, lastAccess: now() });
      return entry.state;
    },
    getCompletion(sessionId, directory, completionKey) {
      const entry = entries.get(entryKey(sessionId, directory));
      if (!entry || entry.lastAccess < now() - ttlMs || entry.completion?.key !== completionKey) return null;
      return entry.completion.value;
    },
    async getOrCreateCompletion(sessionId, directory, completionKey, create) {
      const key = entryKey(sessionId, directory);
      const entry = entries.get(key);
      if (!entry) return create();
      if (entry.completion?.key === completionKey) return entry.completion.value;
      if (entry.pendingCompletion?.key === completionKey) return entry.pendingCompletion.promise;

      const promise = Promise.resolve().then(create);
      entry.pendingCompletion = { key: completionKey, promise };
      try {
        const value = await promise;
        const current = entries.get(key);
        if (current?.pendingCompletion?.promise === promise) {
          current.completion = { key: completionKey, value };
        }
        return value;
      } finally {
        const current = entries.get(key);
        if (current?.pendingCompletion?.promise === promise) delete current.pendingCompletion;
      }
    },
    size: () => entries.size,
  };
}
