import { describe, expect, it, vi } from 'vitest';

import { answersOf, createClaudeRequests, describeSuggestion, permissionRequestOf, questionFormOf } from './claude-requests.js';

const makeRequests = (overrides = {}) => {
  const events = [];
  let counter = 0;
  const requests = createClaudeRequests({
    emit: (payload) => events.push(payload),
    createId: () => `id${++counter}`,
    ...overrides,
  });
  return { requests, events };
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('permissionRequestOf', () => {
  it('describes a shell call as the card renders it', () => {
    const request = permissionRequestOf('Bash', { command: 'rm -rf build', description: 'Clean', timeout: 5000 }, {
      title: 'Claude wants to run rm -rf build',
      suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'rm -rf build:*' }] }],
      decisionReason: 'asks',
      agentID: 'agent1',
    });
    expect(request).toMatchObject({
      action: 'shell',
      resources: ['rm -rf build'],
      save: ['Bash(rm -rf build:*) (this project)'],
      message: 'Claude wants to run rm -rf build',
      metadata: { command: 'rm -rf build', description: 'Clean', timeout: 5000, claude: { toolName: 'Bash', decisionReason: 'asks', agentID: 'agent1' } },
    });
  });

  it('carries an edit diff and a write body', () => {
    const edit = permissionRequestOf('Edit', { file_path: '/r/a', old_string: 'a', new_string: 'b' });
    expect(edit.action).toBe('edit');
    expect(edit.resources).toEqual(['/r/a']);
    expect(edit.metadata.files[0]).toMatchObject({ file: '/r/a', additions: 1, deletions: 1 });
    const write = permissionRequestOf('Write', { file_path: '/r/b', content: 'body' });
    expect(write).toMatchObject({ action: 'write', resources: ['/r/b'], metadata: { filePath: '/r/b', content: 'body' } });
  });

  it('shows the raw input of anything else and offers no always rule when told not to', () => {
    const request = permissionRequestOf('mcp__srv__do', { a: 1 }, {
      blockedPath: '/etc',
      suppressAlwaysAllowRule: true,
      suggestions: [{ type: 'addRules', behavior: 'allow', destination: 'session', rules: [{ toolName: 'mcp__srv__do' }] }],
    });
    expect(request).toMatchObject({ action: 'mcp__srv__do', resources: ['/etc'], save: [], metadata: { input: { a: 1 } } });
  });
});

describe('describeSuggestion', () => {
  it('names rules, directories and modes with where they are saved', () => {
    expect(describeSuggestion({ type: 'addRules', behavior: 'allow', destination: 'userSettings', rules: [{ toolName: 'Read' }] }))
      .toEqual(['Read (all projects)']);
    expect(describeSuggestion({ type: 'addDirectories', destination: 'session', directories: ['/tmp/x'] })).toEqual(['/tmp/x (this session)']);
    expect(describeSuggestion({ type: 'setMode', mode: 'acceptEdits', destination: 'session' })).toEqual(['mode acceptEdits (this session)']);
    expect(describeSuggestion({ type: 'addRules', behavior: 'deny', rules: [{ toolName: 'Bash' }] })).toEqual([]);
    expect(describeSuggestion(null)).toEqual([]);
  });
});

describe('questionFormOf / answersOf', () => {
  const input = {
    questions: [
      { question: 'Which library?', header: 'Library', multiSelect: false, options: [{ label: 'dayjs', description: 'small' }, { label: 'luxon', description: 'big' }] },
      { question: 'Which features?', header: 'Features', multiSelect: true, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] },
    ],
  };

  it('asks one required field per question, free text allowed', () => {
    const { title, fields } = questionFormOf(input);
    expect(title).toBe('Claude has some questions');
    expect(fields).toEqual([
      { key: 'q0', type: 'string', title: 'Which library?', description: 'Library', required: true, custom: true, options: [{ value: 'dayjs', label: 'dayjs', description: 'small' }, { value: 'luxon', label: 'luxon', description: 'big' }] },
      { key: 'q1', type: 'multiselect', title: 'Which features?', description: 'Features', required: true, custom: true, options: [{ value: 'a', label: 'a' }, { value: 'b', label: 'b' }] },
    ]);
    expect(questionFormOf({ questions: [input.questions[0]] }).title).toBe('Library');
  });

  it('answers by question text, several choices comma-separated', () => {
    const { questions } = questionFormOf(input);
    expect(answersOf(questions, { q0: 'something else entirely', q1: ['a', 'b'] })).toEqual({
      'Which library?': 'something else entirely',
      'Which features?': 'a, b',
    });
    expect(answersOf(questions, {})).toEqual({});
  });
});

describe('createClaudeRequests', () => {
  const baseOptions = () => ({ signal: new AbortController().signal, toolUseID: 'toolu_1', requestId: 'r1' });

  it('asks, waits and allows once', async () => {
    const { requests, events } = makeRequests();
    const canUseTool = requests.canUseToolFor({ sessionId: 's1', directory: '/repo' });
    const pending = canUseTool('Bash', { command: 'ls' }, baseOptions());
    await settle();
    expect(events[0]).toMatchObject({ type: 'permission.asked', properties: { directory: '/repo', request: { id: 'per_cccid1', sessionID: 's1', action: 'shell' } } });
    expect(requests.list('permission')).toHaveLength(1);
    expect(requests.list('permission', { directory: '/other' })).toHaveLength(0);
    expect(requests.get('permission', 's1', 'per_cccid1')).toMatchObject({ action: 'shell' });
    expect(requests.get('permission', 'other', 'per_cccid1')).toBeNull();

    expect(requests.replyPermission('s1', 'per_cccid1', { decision: 'once' })).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(events[1]).toMatchObject({ type: 'permission.replied', properties: { sessionID: 's1', requestID: 'per_cccid1', reply: 'once' } });
    expect(requests.list('permission')).toHaveLength(0);
    expect(requests.replyPermission('s1', 'per_cccid1', { decision: 'once' })).toBe(false);
  });

  it('always = the SDK suggestions saved; none offered = allowed once', async () => {
    const { requests } = makeRequests();
    const canUseTool = requests.canUseToolFor({ sessionId: 's1', directory: '/repo' });
    const suggestions = [{ type: 'addRules', behavior: 'allow', destination: 'localSettings', rules: [{ toolName: 'Bash', ruleContent: 'ls:*' }] }];
    const pending = canUseTool('Bash', { command: 'ls' }, { ...baseOptions(), suggestions });
    await settle();
    requests.replyPermission('s1', 'per_cccid1', { decision: 'always' });
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' }, updatedPermissions: suggestions });

    const second = canUseTool('Bash', { command: 'ls' }, { ...baseOptions(), suggestions, suppressAlwaysAllowRule: true });
    await settle();
    requests.replyPermission('s1', 'per_cccid2', { decision: 'always' });
    await expect(second).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
  });

  it('a plain refusal stops the turn; one with instructions hands them to Claude', async () => {
    const { requests } = makeRequests();
    const canUseTool = requests.canUseToolFor({ sessionId: 's1', directory: '/repo' });
    const plain = canUseTool('Bash', { command: 'ls' }, baseOptions());
    await settle();
    requests.replyPermission('s1', 'per_cccid1', { decision: 'reject' });
    await expect(plain).resolves.toEqual({ behavior: 'deny', message: 'The user refused this Bash call.', interrupt: true });

    const guided = canUseTool('Bash', { command: 'ls' }, baseOptions());
    await settle();
    requests.replyPermission('s1', 'per_cccid2', { decision: 'reject', message: 'use git ls-files' });
    await expect(guided).resolves.toEqual({ behavior: 'deny', message: 'The user refused this Bash call and said: use git ls-files' });
  });

  it('settles and withdraws the card when the SDK aborts the ask', async () => {
    const { requests, events } = makeRequests();
    const controller = new AbortController();
    const pending = requests.canUseToolFor({ sessionId: 's1', directory: '/repo' })('Bash', { command: 'ls' }, { ...baseOptions(), signal: controller.signal });
    await settle();
    controller.abort();
    await expect(pending).resolves.toMatchObject({ behavior: 'deny', interrupt: true });
    expect(events.at(-1)).toMatchObject({ type: 'permission.replied', properties: { reply: 'reject' } });
    expect(requests.list('permission')).toHaveLength(0);
  });

  it('withdraws every open request of a session whose process ended', async () => {
    const { requests } = makeRequests();
    const a = requests.canUseToolFor({ sessionId: 's1', directory: '/r' })('Bash', { command: 'a' }, baseOptions());
    const b = requests.canUseToolFor({ sessionId: 's2', directory: '/r' })('Bash', { command: 'b' }, baseOptions());
    await settle();
    requests.withdrawSession('s1');
    await expect(a).resolves.toMatchObject({ behavior: 'deny' });
    expect(requests.list('permission').map((request) => request.sessionID)).toEqual(['s2']);
    requests.withdrawSession('s2');
    await b;
  });

  it('answers AskUserQuestion through a form', async () => {
    const { requests, events } = makeRequests();
    const input = { questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'A', description: '' }, { label: 'B', description: '' }] }] };
    const pending = requests.canUseToolFor({ sessionId: 's1', directory: '/r' })('AskUserQuestion', input, baseOptions());
    await settle();
    expect(events[0]).toMatchObject({ type: 'form.created', properties: { form: { id: 'frm_cccid1', sessionID: 's1', title: 'Pick' } } });
    expect(requests.list('form')).toHaveLength(1);
    expect(requests.replyForm('s1', 'frm_cccid1', { q0: 'B' })).toBe(true);
    await expect(pending).resolves.toEqual({ behavior: 'allow', updatedInput: { ...input, answers: { 'Which?': 'B' } } });
    expect(events[1]).toMatchObject({ type: 'form.replied', properties: { id: 'frm_cccid1', answer: { q0: 'B' } } });
  });

  it('a dismissed question is a refusal', async () => {
    const { requests, events } = makeRequests();
    const pending = requests.canUseToolFor({ sessionId: 's1', directory: '/r' })('AskUserQuestion', { questions: [{ question: 'Q?', options: [] }] }, baseOptions());
    await settle();
    expect(requests.cancelForm('s1', 'frm_cccid1')).toBe(true);
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    expect(events[1].type).toBe('form.cancelled');
    expect(requests.cancelForm('s1', 'frm_cccid1')).toBe(false);
  });

  it('approves a plan into the chosen mode, or keeps planning with feedback', async () => {
    const onModeChange = vi.fn();
    const { requests, events } = makeRequests();
    const canUseTool = requests.canUseToolFor({ sessionId: 's1', directory: '/r', onModeChange });
    const approved = canUseTool('ExitPlanMode', { plan: '# Plan' }, baseOptions());
    await settle();
    expect(events[0]).toMatchObject({ type: 'permission.asked', properties: { request: { action: 'plan_exit', metadata: { plan: '# Plan' } } } });
    requests.replyPermission('s1', 'per_cccid1', { decision: 'always' });
    await expect(approved).resolves.toEqual({
      behavior: 'allow',
      updatedInput: { plan: '# Plan' },
      updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits', destination: 'session' }],
    });
    expect(onModeChange).toHaveBeenCalledWith('acceptEdits');

    const manual = canUseTool('ExitPlanMode', { plan: '# Plan' }, baseOptions());
    await settle();
    requests.replyPermission('s1', 'per_cccid2', { decision: 'once' });
    await expect(manual).resolves.toMatchObject({ updatedPermissions: [{ mode: 'default' }] });

    const refused = canUseTool('ExitPlanMode', { plan: '# Plan' }, baseOptions());
    await settle();
    requests.replyPermission('s1', 'per_cccid3', { decision: 'reject', message: 'split step 2' });
    await expect(refused).resolves.toEqual({
      behavior: 'deny',
      message: 'The user wants to keep planning. Their feedback on the plan: split step 2',
    });
    expect(onModeChange).toHaveBeenCalledTimes(2);
  });

  it('auto-accepts for a session set to, unless the safety net holds it', async () => {
    const isAutoAccepting = vi.fn(async () => true);
    const evaluatePermission = vi.fn(async (request) => (request.metadata.command === 'rm -rf /' ? { action: 'hold' } : { action: 'allow' }));
    const { requests, events } = makeRequests({ isAutoAccepting, evaluatePermission });
    const canUseTool = requests.canUseToolFor({ sessionId: 's1', directory: '/r' });
    await expect(canUseTool('Bash', { command: 'ls' }, baseOptions())).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'ls' } });
    expect(events).toHaveLength(0);
    expect(isAutoAccepting).toHaveBeenCalledWith('s1', '/r');

    const held = canUseTool('Bash', { command: 'rm -rf /' }, baseOptions());
    await settle();
    expect(events[0].type).toBe('permission.asked');
    requests.replyPermission('s1', events[0].properties.request.id, { decision: 'reject' });
    await expect(held).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('an invalid decision counts as a refusal', async () => {
    const { requests } = makeRequests();
    const pending = requests.canUseToolFor({ sessionId: 's1', directory: '/r' })('Bash', { command: 'ls' }, baseOptions());
    await settle();
    requests.replyPermission('s1', 'per_cccid1', { decision: 'sure' });
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
  });
});
