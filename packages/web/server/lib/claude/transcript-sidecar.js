import fsDefault from 'fs';
import osDefault from 'os';
import pathDefault from 'path';

/**
 * What the Agent SDK's transcript reader leaves out, read from Claude Code's
 * own files.
 *
 * `getSessionMessages()` drops each tool result's structured record
 * (`toolUseResult`): the exact hunks of an edit (`structuredPatch`) and the id
 * of the subagent a call started (`agentId`). Claude Code writes both, and a
 * subagent's `.meta.json` names the call that started it (`toolUseId`). This
 * module reads them back so an edit shows its real diff and a subagent call
 * links to the subagent's transcript.
 *
 * Transcripts live at `<config>/projects/<slug>/<sessionId>.jsonl`, where
 * `<slug>` is the working directory with every non-alphanumeric character
 * turned into `-`; a session found elsewhere (a long path Claude Code
 * shortened, a moved project) is located once by scanning and remembered.
 */

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * Session and agent ids become file names here, and they arrive from URLs:
 * only a plain id (a uuid, `a5df7622fa8de0538`) is ever joined into a path.
 */
export const isSafeId = (value) => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);

export const projectSlug = (directory) => String(directory || '').replace(/[^a-zA-Z0-9]/g, '-');

/**
 * @param {object} [options]
 * @param {typeof fsDefault.promises} [options.fsPromises]
 * @param {typeof pathDefault} [options.path]
 * @param {string} [options.configDir] Claude Code's config directory (CLAUDE_CONFIG_DIR, else ~/.claude)
 */
export const createTranscriptSidecar = ({
  fsPromises = fsDefault.promises,
  path = pathDefault,
  configDir = process.env.CLAUDE_CONFIG_DIR || pathDefault.join(osDefault.homedir(), '.claude'),
} = {}) => {
  const projectsDir = path.join(configDir, 'projects');
  const located = new Map();

  const exists = async (file) => {
    try {
      await fsPromises.access(file);
      return true;
    } catch {
      return false;
    }
  };

  /** The transcript file of a session, or null when there is none (yet). */
  const locate = async (sessionId, directory) => {
    if (!isSafeId(sessionId)) return null;
    const known = located.get(sessionId);
    if (known && await exists(known)) return known;
    const direct = directory ? path.join(projectsDir, projectSlug(directory), `${sessionId}.jsonl`) : null;
    if (direct && await exists(direct)) {
      located.set(sessionId, direct);
      return direct;
    }
    let projects = [];
    try {
      projects = await fsPromises.readdir(projectsDir);
    } catch {
      return null;
    }
    for (const project of projects) {
      const candidate = path.join(projectsDir, project, `${sessionId}.jsonl`);
      if (await exists(candidate)) {
        located.set(sessionId, candidate);
        return candidate;
      }
    }
    return null;
  };

  /**
   * `tool_use_id` → Claude Code's structured tool result, from the transcript
   * lines that carry one. Only those lines are parsed.
   */
  const readToolResults = async (file) => {
    const results = new Map();
    let raw;
    try {
      raw = await fsPromises.readFile(file, 'utf8');
    } catch {
      return results;
    }
    for (const line of raw.split('\n')) {
      if (!line.includes('"toolUseResult"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry.toolUseResult)) continue;
      const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
      for (const block of blocks) {
        if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          results.set(block.tool_use_id, entry.toolUseResult);
        }
      }
    }
    return results;
  };

  /** The subagents a session started: `toolUseId` → `{ agentId, agentType, description }`. */
  const readSubagents = async (file, sessionId) => {
    const subagents = new Map();
    const dir = path.join(path.dirname(file), sessionId, 'subagents');
    let names = [];
    try {
      names = await fsPromises.readdir(dir);
    } catch {
      return subagents;
    }
    for (const name of names) {
      const match = /^agent-(.+)\.meta\.json$/.exec(name);
      if (!match) continue;
      try {
        const meta = JSON.parse(await fsPromises.readFile(path.join(dir, name), 'utf8'));
        if (isRecord(meta) && typeof meta.toolUseId === 'string') {
          subagents.set(meta.toolUseId, {
            agentId: match[1],
            agentType: typeof meta.agentType === 'string' ? meta.agentType : '',
            description: typeof meta.description === 'string' ? meta.description : '',
          });
        }
      } catch {
        // A meta file being written right now: the next read has it.
      }
    }
    return subagents;
  };

  /**
   * Everything the SDK reader leaves out for one session. Never throws: what
   * cannot be read is simply absent, and the messages render as they did.
   */
  const read = async (sessionId, directory, { agentId = null } = {}) => {
    const file = agentId !== null && !isSafeId(agentId) ? null : await locate(sessionId, directory).catch(() => null);
    if (!file) return { toolResults: new Map(), subagents: new Map() };
    // A subagent's calls are in its own file; the subagents it starts are
    // listed with the session's (every depth lives under the root session).
    const callsFile = agentId ? path.join(path.dirname(file), sessionId, 'subagents', `agent-${agentId}.jsonl`) : file;
    const [toolResults, subagents] = await Promise.all([
      readToolResults(callsFile).catch(() => new Map()),
      readSubagents(file, sessionId).catch(() => new Map()),
    ]);
    return { toolResults, subagents };
  };

  /** One subagent's descriptor by id (its `.meta.json`), or null. */
  const readSubagent = async (sessionId, directory, agentId) => {
    if (!isSafeId(agentId)) return null;
    const file = await locate(sessionId, directory).catch(() => null);
    if (!file) return null;
    for (const [toolUseId, subagent] of await readSubagents(file, sessionId)) {
      if (subagent.agentId === agentId) return { ...subagent, toolUseId };
    }
    return null;
  };

  /**
   * The summary Claude Code generated for itself: the last `ai-title` entry in
   * the session's transcript, empty when the conversation has not produced one.
   * This is the title the CLI would show; a custom title written by another
   * surface can mask it in the SDK's answer but never here.
   */
  const readAiTitle = async (sessionId, directory) => {
    const file = await locate(sessionId, directory);
    if (!file) return '';
    let raw;
    try {
      raw = await fsPromises.readFile(file, 'utf8');
    } catch {
      return '';
    }
    let title = '';
    for (const line of raw.split('\n')) {
      if (!line.includes('"ai-title"')) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) title = entry.aiTitle.trim();
    }
    return title;
  };

  return { locate, read, readSubagent, readAiTitle, projectsDir };
};
