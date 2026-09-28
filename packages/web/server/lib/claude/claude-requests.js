import { toV2Tool } from './claude-tools.js';

/**
 * Claude Code asking the user something — permission to run a tool, an
 * `AskUserQuestion`, a plan to approve — as OpenCode v2's permission and form
 * requests, so the cards the UI already has answer them.
 *
 * The Agent SDK asks through `canUseTool` and waits for the answer. Without a
 * `canUseTool` the CLI decides alone: in Manual mode every tool that needs
 * approval was refused, and a question or a plan could never be answered.
 * Each ask here becomes a pending request — published (`permission.asked`,
 * `form.created`), listed, fetched and answered through the routes the UI
 * uses for OpenCode's — and the answer becomes the SDK's `PermissionResult`.
 *
 * An ask the SDK withdraws (turn interrupted, process closed, answered from
 * claude.ai) settles here too, so no card outlives its question.
 */

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringOf = (value) => (typeof value === 'string' ? value : '');

/** Where an "always" approval is saved, in the words a prompt uses. */
const DESTINATION_LABELS = Object.freeze({
  userSettings: 'all projects',
  projectSettings: 'this project, shared',
  localSettings: 'this project',
  session: 'this session',
  cliArg: 'this session',
});

/**
 * One permission suggestion as the rule texts a card lists under "always
 * allow": `Bash(npm test:*)`, a directory, a mode — each naming where the
 * approval is saved.
 */
export const describeSuggestion = (update) => {
  if (!isRecord(update)) return [];
  const where = DESTINATION_LABELS[update.destination];
  const suffix = where ? ` (${where})` : '';
  if (update.type === 'addRules' || update.type === 'replaceRules') {
    if (update.behavior && update.behavior !== 'allow') return [];
    return (Array.isArray(update.rules) ? update.rules : [])
      .filter(isRecord)
      .map((rule) => {
        const tool = stringOf(rule.toolName);
        if (!tool) return '';
        return `${rule.ruleContent ? `${tool}(${rule.ruleContent})` : tool}${suffix}`;
      })
      .filter(Boolean);
  }
  if (update.type === 'addDirectories') {
    return (Array.isArray(update.directories) ? update.directories : []).filter((dir) => typeof dir === 'string' && dir).map((dir) => `${dir}${suffix}`);
  }
  if (update.type === 'setMode' && typeof update.mode === 'string') return [`mode ${update.mode}${suffix}`];
  return [];
};

/** What a tool call acts on, as the request's `resources`. */
const resourcesOf = (tool, input, blockedPath) => {
  const first = (...values) => values.find((value) => typeof value === 'string' && value.trim()) || '';
  let resource = '';
  switch (tool) {
    case 'shell': resource = first(input.command); break;
    case 'edit':
    case 'write':
    case 'read':
    case 'notebookedit': resource = first(input.filePath, input.file_path, input.notebook_path); break;
    case 'webfetch': resource = first(input.url); break;
    case 'websearch': resource = first(input.query); break;
    case 'glob':
    case 'grep': resource = first(input.pattern); break;
    default: resource = '';
  }
  return [resource || blockedPath].filter((value) => typeof value === 'string' && value);
};

/**
 * The permission request for one tool call, in OpenCode v2's shape: the
 * action the UI renders by (`shell`, `edit`, `write`, `webfetch`, …), what it
 * acts on, the patterns "always" would save, and what the card shows
 * (command, diff, file content, the raw input of anything else).
 */
export const permissionRequestOf = (toolName, input, options = {}) => {
  const raw = isRecord(input) ? input : {};
  const v2 = toV2Tool(toolName, raw);
  const mapped = v2.input;
  const metadata = { ...(v2.metadata || {}) };
  switch (v2.tool) {
    case 'shell':
      metadata.command = stringOf(mapped.command);
      if (mapped.description) metadata.description = mapped.description;
      if (Number.isFinite(raw.timeout)) metadata.timeout = raw.timeout;
      break;
    case 'write':
      metadata.filePath = stringOf(mapped.filePath);
      metadata.content = stringOf(raw.content);
      break;
    case 'edit':
      metadata.filePath = stringOf(mapped.filePath);
      if (raw.replace_all === true) metadata.replaceAll = true;
      break;
    case 'read':
    case 'notebookedit':
      metadata.filePath = stringOf(mapped.filePath);
      break;
    case 'webfetch':
      metadata.url = stringOf(raw.url);
      if (raw.prompt) metadata.description = stringOf(raw.prompt);
      break;
    default:
      // Anything else (MCP tools, skills…) shows its input as it came.
      metadata.input = raw;
  }
  const suggestions = Array.isArray(options.suggestions) ? options.suggestions.filter(isRecord) : [];
  const save = options.suppressAlwaysAllowRule === true ? [] : suggestions.flatMap(describeSuggestion);
  metadata.claude = {
    toolName: stringOf(toolName),
    ...(options.displayName ? { displayName: stringOf(options.displayName) } : {}),
    ...(options.description ? { description: stringOf(options.description) } : {}),
    ...(options.decisionReason ? { decisionReason: stringOf(options.decisionReason) } : {}),
    ...(options.blockedPath ? { blockedPath: stringOf(options.blockedPath) } : {}),
    ...(options.agentID ? { agentID: stringOf(options.agentID) } : {}),
    ...(options.defaultToNo === true ? { defaultToNo: true } : {}),
  };
  return {
    action: v2.tool,
    resources: resourcesOf(v2.tool, { ...raw, ...mapped }, options.blockedPath),
    save,
    metadata,
    ...(options.title ? { message: stringOf(options.title) } : {}),
  };
};

/**
 * An `AskUserQuestion` as a form: one field per question, its options as the
 * field's, free text allowed (Claude Code always offers "Other").
 */
export const questionFormOf = (input) => {
  const questions = (Array.isArray(input?.questions) ? input.questions : []).filter(isRecord);
  const fields = questions.map((question, index) => {
    const options = (Array.isArray(question.options) ? question.options : [])
      .filter(isRecord)
      .map((option) => ({
        value: stringOf(option.label),
        label: stringOf(option.label),
        ...(option.description ? { description: stringOf(option.description) } : {}),
      }))
      .filter((option) => option.value);
    return {
      key: `q${index}`,
      type: question.multiSelect === true ? 'multiselect' : 'string',
      title: stringOf(question.question),
      ...(question.header ? { description: stringOf(question.header) } : {}),
      required: true,
      options,
      custom: true,
    };
  });
  const title = questions.length === 1
    ? (stringOf(questions[0].header) || 'Claude has a question')
    : 'Claude has some questions';
  return { title, fields, questions };
};

/**
 * A form answer as `AskUserQuestion`'s `answers`: question text → answer,
 * several choices comma-separated (the tool's own format).
 */
export const answersOf = (questions, answer) => {
  const answers = {};
  questions.forEach((question, index) => {
    const value = isRecord(answer) ? answer[`q${index}`] : undefined;
    const text = Array.isArray(value)
      ? value.filter((entry) => typeof entry === 'string' && entry).join(', ')
      : (value === undefined || value === null ? '' : String(value));
    if (text) answers[stringOf(question.question)] = text;
  });
  return answers;
};

/**
 * The plan-approval choices, as a permission request's replies:
 *   once   → approve, and ask before each edit (Manual)
 *   always → approve, and let Claude edit without asking (Edit automatically)
 *   reject → keep planning; the reply's message is the feedback
 */
const PLAN_APPROVAL_MODES = Object.freeze({ once: 'default', always: 'acceptEdits' });

/**
 * @param {object} dependencies
 * @param {(payload: object) => void} dependencies.emit internal event (see v2-wire.js)
 * @param {() => string} dependencies.createId unique suffix for request ids
 * @param {(sessionId: string, directory: string) => Promise<boolean>} [dependencies.isAutoAccepting] OpenChamber's auto-accept policy for a session
 * @param {(request: object, directory: string) => Promise<{ action?: string } | null>} [dependencies.evaluatePermission] the routing safety net
 */
export const createClaudeRequests = ({ emit, createId, isAutoAccepting = null, evaluatePermission = null, now = Date.now }) => {
  /** id → { kind, sessionId, directory, request, resolve, detach, createdAt } */
  const pending = new Map();

  const settle = (id, outcome) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
    entry.detach?.();
    const { sessionId, directory } = entry;
    if (entry.kind === 'permission') {
      emit({
        type: 'permission.replied',
        properties: { directory, sessionID: sessionId, requestID: id, reply: outcome.decision || 'reject' },
      });
    } else if (outcome.type === 'answered') {
      emit({ type: 'form.replied', properties: { directory, sessionID: sessionId, id, answer: outcome.answer } });
    } else {
      emit({ type: 'form.cancelled', properties: { directory, sessionID: sessionId, id } });
    }
    entry.resolve(outcome);
    return true;
  };

  /** Publish a request and wait for its answer (or its withdrawal). */
  const open = (kind, { sessionId, directory, request, signal }) => new Promise((resolve) => {
    if (signal?.aborted) {
      resolve({ type: 'aborted' });
      return;
    }
    const entry = { kind, sessionId, directory, request, resolve, createdAt: now() };
    const onAbort = () => settle(request.id, { type: 'aborted' });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    entry.detach = () => signal?.removeEventListener?.('abort', onAbort);
    pending.set(request.id, entry);
    if (kind === 'permission') {
      emit({ type: 'permission.asked', properties: { directory, request } });
    } else {
      emit({ type: 'form.created', properties: { directory, form: request } });
    }
  });

  const newId = (prefix) => `${prefix}${createId()}`;

  const askPermission = async ({ sessionId, directory, toolName, input, options }) => {
    const request = { id: newId('per_ccc'), sessionID: sessionId, ...permissionRequestOf(toolName, input, options) };
    // OpenChamber's auto-accept is honoured here: its own runtime only
    // watches OpenCode's stream, and the UI hides requests of a session that
    // auto-accepts — a Claude request nobody answered would hang the turn.
    if (isAutoAccepting && await isAutoAccepting(sessionId, directory).catch(() => false)) {
      const verdict = evaluatePermission ? await evaluatePermission(request, directory).catch(() => null) : null;
      if (verdict?.action !== 'hold') return { type: 'answered', decision: 'once', auto: true };
    }
    return open('permission', { sessionId, directory, request, signal: options.signal });
  };

  /**
   * The `canUseTool` of one session's CLI process. `onModeChange` hears the
   * mode a plan approval switches to, so the process's idea of its mode
   * stays true.
   */
  const canUseToolFor = ({ sessionId, directory, onModeChange }) => async (toolName, input, options = {}) => {
    const raw = isRecord(input) ? input : {};
    const name = String(toolName || '').toLowerCase();

    if (name === 'askuserquestion') {
      const { title, fields, questions } = questionFormOf(raw);
      if (fields.length === 0) return { behavior: 'allow', updatedInput: raw };
      const form = {
        id: newId('frm_ccc'),
        sessionID: sessionId,
        title,
        metadata: { claude: { toolName: 'AskUserQuestion', toolUseID: stringOf(options.toolUseID) } },
        fields,
      };
      const outcome = await open('form', { sessionId, directory, request: form, signal: options.signal });
      if (outcome.type !== 'answered') {
        return { behavior: 'deny', message: 'The user dismissed the questions without answering.' };
      }
      return { behavior: 'allow', updatedInput: { ...raw, answers: answersOf(questions, outcome.answer) } };
    }

    if (name === 'exitplanmode') {
      const plan = stringOf(raw.plan);
      const request = {
        id: newId('per_ccc'),
        sessionID: sessionId,
        action: 'plan_exit',
        resources: [],
        save: [],
        metadata: { plan, claude: { toolName: 'ExitPlanMode' } },
        message: 'Claude has finished planning. Approve the plan to start?',
      };
      const outcome = await open('permission', { sessionId, directory, request, signal: options.signal });
      const mode = outcome.type === 'answered' ? PLAN_APPROVAL_MODES[outcome.decision] : undefined;
      if (!mode) {
        const feedback = outcome.type === 'answered' ? stringOf(outcome.message).trim() : '';
        return {
          behavior: 'deny',
          message: feedback
            ? `The user wants to keep planning. Their feedback on the plan: ${feedback}`
            : 'The user wants to keep planning; revise the plan before asking again.',
        };
      }
      onModeChange?.(mode);
      return {
        behavior: 'allow',
        updatedInput: raw,
        updatedPermissions: [{ type: 'setMode', mode, destination: 'session' }],
      };
    }

    const outcome = await askPermission({ sessionId, directory, toolName, input: raw, options });
    if (outcome.type !== 'answered' || outcome.decision === 'reject') {
      const feedback = outcome.type === 'answered' ? stringOf(outcome.message).trim() : '';
      return {
        behavior: 'deny',
        message: feedback
          ? `The user refused this ${toolName} call and said: ${feedback}`
          : `The user refused this ${toolName} call.`,
        // A plain refusal stops the turn, as Claude Code's own prompt does;
        // one with instructions lets Claude carry them out.
        ...(feedback ? {} : { interrupt: true }),
      };
    }
    const suggestions = Array.isArray(options.suggestions) ? options.suggestions.filter(isRecord) : [];
    const always = outcome.decision === 'always' && options.suppressAlwaysAllowRule !== true && suggestions.length > 0;
    return {
      behavior: 'allow',
      updatedInput: raw,
      ...(always ? { updatedPermissions: suggestions } : {}),
    };
  };

  const find = (kind, sessionId, id) => {
    const entry = pending.get(id);
    if (!entry || entry.kind !== kind) return null;
    if (sessionId && entry.sessionId !== sessionId) return null;
    return entry;
  };

  /** Answer a permission request; false when there is none by that id. */
  const replyPermission = (sessionId, id, { decision, message } = {}) => {
    if (!find('permission', sessionId, id)) return false;
    const valid = ['once', 'always', 'reject'].includes(decision) ? decision : 'reject';
    return settle(id, { type: 'answered', decision: valid, message: typeof message === 'string' ? message : '' });
  };

  /** Answer a form; false when there is none by that id. */
  const replyForm = (sessionId, id, answer) => {
    if (!find('form', sessionId, id)) return false;
    return settle(id, { type: 'answered', answer: isRecord(answer) ? answer : {} });
  };

  const cancelForm = (sessionId, id) => {
    if (!find('form', sessionId, id)) return false;
    return settle(id, { type: 'cancelled' });
  };

  /** Withdraw every request a session has open (its process ended). */
  const withdrawSession = (sessionId) => {
    for (const [id, entry] of Array.from(pending.entries())) {
      if (entry.sessionId === sessionId) settle(id, { type: 'aborted' });
    }
  };

  /** Open requests of one kind, oldest first; by session and/or directory when given. */
  const list = (kind, { sessionId = null, directory = null } = {}) => Array.from(pending.values())
    .filter((entry) => entry.kind === kind)
    .filter((entry) => !sessionId || entry.sessionId === sessionId)
    .filter((entry) => !directory || entry.directory === directory)
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((entry) => entry.request);

  const get = (kind, sessionId, id) => find(kind, sessionId, id)?.request ?? null;

  return { canUseToolFor, replyPermission, replyForm, cancelForm, withdrawSession, list, get };
};
