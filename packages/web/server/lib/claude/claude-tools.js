/**
 * Claude Code tool calls as the OpenCode v2 tool parts the UI already renders.
 *
 * The UI matches tools by OpenCode's names and input keys (`shell` with
 * `command`, `edit` with a diff in `metadata.files`, `subagent` with a child
 * session in `metadata.sessionID`, `question` with `questions[].multiple`).
 * Claude Code names them `Bash`, `Edit`, `Agent`, `AskUserQuestion`, with its
 * own keys (`file_path`, `old_string`, `subagent_type`, `multiSelect`). Passed
 * through verbatim they fell to the generic renderer: no command block, no
 * diff, no link to a subagent's transcript, no question card.
 *
 * `toV2Tool` maps a call; the original input keys are kept alongside the
 * mapped ones, so nothing a renderer already read is lost. Diffs come from the
 * structured result Claude Code records for an edit (`structuredPatch`: exact
 * hunks with line numbers); without it — a call still running — they are
 * built from the call's own old/new strings.
 */

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const stringOf = (value) => (typeof value === 'string' ? value : '');

/** Claude Code's tool name → OpenCode v2's, for the tools the UI renders specially. */
const TOOL_NAMES = new Map([
  ['bash', 'shell'],
  ['edit', 'edit'],
  ['multiedit', 'edit'],
  ['write', 'write'],
  ['read', 'read'],
  ['glob', 'glob'],
  ['grep', 'grep'],
  ['webfetch', 'webfetch'],
  ['websearch', 'websearch'],
  ['agent', 'subagent'],
  ['task', 'subagent'],
  ['askuserquestion', 'question'],
  ['exitplanmode', 'plan_exit'],
  ['todowrite', 'todowrite'],
  ['notebookedit', 'notebookedit'],
]);

/** Whether a Claude Code tool call starts a subagent. */
export const isSubagentTool = (name) => ['agent', 'task'].includes(String(name || '').toLowerCase());

/**
 * A unified diff from Claude Code's structured hunks
 * (`[{ oldStart, oldLines, newStart, newLines, lines: [' ctx', '-old', '+new'] }]`).
 */
export const patchFromStructured = (file, hunks) => {
  const valid = (Array.isArray(hunks) ? hunks : []).filter((hunk) => isRecord(hunk) && Array.isArray(hunk.lines));
  if (valid.length === 0) return null;
  let additions = 0;
  let deletions = 0;
  const body = valid.map((hunk) => {
    for (const line of hunk.lines) {
      if (typeof line !== 'string') continue;
      if (line.startsWith('+')) additions += 1;
      else if (line.startsWith('-')) deletions += 1;
    }
    const header = `@@ -${hunk.oldStart ?? 0},${hunk.oldLines ?? 0} +${hunk.newStart ?? 0},${hunk.newLines ?? 0} @@`;
    return [header, ...hunk.lines.filter((line) => typeof line === 'string')].join('\n');
  });
  return { file, patch: [`--- a/${file}`, `+++ b/${file}`, ...body].join('\n'), additions, deletions };
};

/**
 * A unified diff from an edit's own old/new strings, for a call whose result
 * (with exact line numbers) is not in yet. The hunk starts at line 1: the
 * content and the +/- counts are right, the position is not known.
 */
export const patchFromStrings = (file, oldString, newString) => {
  const oldLines = oldString ? oldString.split('\n') : [];
  const newLines = newString ? newString.split('\n') : [];
  if (oldLines.length === 0 && newLines.length === 0) return null;
  const header = `@@ -1,${oldLines.length} +1,${newLines.length} @@`;
  const patch = [
    `--- a/${file}`,
    `+++ b/${file}`,
    header,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
  return { file, patch, additions: newLines.length, deletions: oldLines.length };
};

const editFiles = (name, input, result) => {
  const file = stringOf(input.file_path) || stringOf(input.filePath);
  if (!file) return null;
  const structured = isRecord(result) ? patchFromStructured(file, result.structuredPatch) : null;
  if (structured) return [structured];
  if (name === 'multiedit') {
    const edits = Array.isArray(input.edits) ? input.edits.filter(isRecord) : [];
    const patches = edits.map((edit) => patchFromStrings(file, stringOf(edit.old_string), stringOf(edit.new_string))).filter(Boolean);
    if (patches.length === 0) return null;
    return [{
      file,
      patch: patches.map((entry, index) => (index === 0 ? entry.patch : entry.patch.split('\n').slice(2).join('\n'))).join('\n'),
      additions: patches.reduce((sum, entry) => sum + entry.additions, 0),
      deletions: patches.reduce((sum, entry) => sum + entry.deletions, 0),
    }];
  }
  const fromStrings = patchFromStrings(file, stringOf(input.old_string), stringOf(input.new_string));
  return fromStrings ? [fromStrings] : null;
};

/**
 * One Claude Code tool call as `{ tool, input, metadata }` in OpenCode v2's
 * vocabulary. `result` is Claude Code's structured tool result when known
 * (`toolUseResult` in the transcript, `tool_use_result` live); `childSessionId`
 * is the public id of the subagent session a subagent call ran.
 */
export const toV2Tool = (name, input, { result = null, childSessionId = null } = {}) => {
  const raw = isRecord(input) ? input : {};
  const key = String(name || 'tool').toLowerCase();
  const tool = TOOL_NAMES.get(key) || name || 'tool';
  const metadata = {};
  let mapped = raw;

  switch (key) {
    case 'bash':
      mapped = { ...raw, command: stringOf(raw.command), description: stringOf(raw.description) || undefined };
      break;
    case 'edit':
    case 'multiedit': {
      mapped = {
        ...raw,
        // v2's file tools name the file `path`; `filePath` for older renderers.
        path: stringOf(raw.file_path) || stringOf(raw.filePath),
        filePath: stringOf(raw.file_path) || stringOf(raw.filePath),
        oldString: raw.old_string,
        newString: raw.new_string,
        replaceAll: raw.replace_all,
      };
      const files = editFiles(key, raw, result);
      if (files) {
        metadata.files = files;
        metadata.filediff = { patch: files[0].patch };
      }
      break;
    }
    case 'write':
    case 'read': {
      const file = stringOf(raw.file_path) || stringOf(raw.filePath);
      mapped = { ...raw, path: file, filePath: file };
      break;
    }
    case 'agent':
    case 'task':
      mapped = {
        ...raw,
        agent: stringOf(raw.subagent_type) || 'general-purpose',
        description: stringOf(raw.description),
        prompt: stringOf(raw.prompt),
      };
      if (childSessionId) metadata.sessionID = childSessionId;
      break;
    case 'askuserquestion':
      mapped = {
        ...raw,
        questions: (Array.isArray(raw.questions) ? raw.questions : []).filter(isRecord).map((question) => ({
          ...question,
          question: stringOf(question.question),
          header: stringOf(question.header),
          options: (Array.isArray(question.options) ? question.options : []).filter(isRecord).map((option) => ({
            label: stringOf(option.label),
            description: stringOf(option.description),
          })),
          multiple: question.multiSelect === true,
        })),
      };
      break;
    case 'taskcreate':
      // The id Claude Code gave the task, so later TaskUpdate calls find it.
      if (isRecord(result?.task) && result.task.id !== undefined) {
        metadata.task = { id: String(result.task.id), subject: stringOf(result.task.subject) };
      }
      break;
    case 'notebookedit':
      mapped = { ...raw, path: stringOf(raw.notebook_path), filePath: stringOf(raw.notebook_path), description: stringOf(raw.notebook_path) || undefined };
      break;
    default:
      break;
  }

  // Drop keys the mapping left undefined: they would read as present to a renderer.
  const clean = {};
  for (const [field, value] of Object.entries(mapped)) {
    if (value !== undefined) clean[field] = value;
  }
  return { tool, input: clean, metadata: Object.keys(metadata).length > 0 ? metadata : undefined };
};
