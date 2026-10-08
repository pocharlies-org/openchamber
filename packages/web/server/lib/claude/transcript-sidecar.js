import fsDefault from 'fs';
import osDefault from 'os';
import pathDefault from 'path';
import readline from 'readline';
import { isClaudeGeneratedName, isClaudeTitlePlaceholder } from './claude-transcript.js';

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
 * @param {typeof fsDefault.createReadStream} [options.createReadStream] How a transcript is read: line by line, never whole
 * @param {typeof pathDefault} [options.path]
 * @param {string} [options.configDir] Claude Code's config directory (CLAUDE_CONFIG_DIR, else ~/.claude)
 */
export const createTranscriptSidecar = ({
  fsPromises = fsDefault.promises,
  createReadStream = fsDefault.createReadStream,
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

  /**
   * Calls `onLine` with each line of a transcript; a `true` answer stops the
   * read. A transcript runs to hundreds of MB (images pasted into it): one
   * line at a time keeps memory at the longest line, not the file. A read
   * error rejects, so each reader answers empty rather than partial.
   */
  const forEachLine = async (file, onLine) => {
    const stream = createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    // Without a listener a transcript that vanishes after `locate` (ENOENT,
    // EIO) is an uncaught exception that takes the whole server down.
    let failure = null;
    stream.once('error', (error) => {
      failure = error;
      rl.close();
    });
    try {
      for await (const line of rl) {
        if (onLine(line) === true) break;
      }
    } finally {
      // Closing the interface pauses the stream but keeps its descriptor.
      rl.close();
      stream.destroy();
    }
    if (failure) throw failure;
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
    try {
      await forEachLine(file, (line) => {
        if (!line.includes('"toolUseResult"')) return;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(entry.toolUseResult)) return;
        const blocks = Array.isArray(entry.message?.content) ? entry.message.content : [];
        for (const block of blocks) {
          if (block?.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            results.set(block.tool_use_id, entry.toolUseResult);
          }
        }
      });
    } catch {
      return new Map();
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
    let title = '';
    try {
      await forEachLine(file, (line) => {
        if (!line.includes('"ai-title"')) return;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof entry.aiTitle === 'string' && entry.aiTitle.trim()) title = entry.aiTitle.trim();
      });
    } catch {
      return '';
    }
    return title;
  };

  /**
   * The title the session actually had before a generated name masked it.
   * VS Code stamps `<host>-<adjective>-<animal>` as the transcript's last
   * `custom-title` on every turn; the titles the conversation earned sit in
   * the earlier records. Returns the last real custom title when the newest
   * one is generated (or the old Remote Control placeholder), empty otherwise
   * — meaning the newest title stands as it is.
   */
  const readRealCustomTitle = async (sessionId, directory) => {
    const file = await locate(sessionId, directory);
    if (!file) return '';
    const titles = [];
    try {
      await forEachLine(file, (line) => {
        if (!line.includes('"custom-title"')) return;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          return;
        }
        if (typeof entry.customTitle === 'string' && entry.customTitle.trim()) titles.push(entry.customTitle.trim());
      });
    } catch {
      return '';
    }
    if (titles.length === 0) return '';
    const newest = titles[titles.length - 1];
    if (!isClaudeGeneratedName(newest) && !isClaudeTitlePlaceholder(newest)) return '';
    for (let i = titles.length - 2; i >= 0; i -= 1) {
      if (!isClaudeGeneratedName(titles[i]) && !isClaudeTitlePlaceholder(titles[i])) return titles[i];
    }
    return '';
  };

  /**
   * What the person first asked: the text of the first real user record
   * (no meta, compact summary, tool result or `<tag>` part). The SDK's
   * `firstPrompt` comes back empty when that record carries a pasted image —
   * the line outgrows the head it scans — so this reads the transcript itself.
   */
  const readFirstPrompt = async (sessionId, directory) => {
    const file = await locate(sessionId, directory);
    if (!file) return '';
    let prompt = '';
    try {
      await forEachLine(file, (line) => {
        if (!line.includes('"type":"user"')) return;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          return;
        }
        if (entry.type !== 'user' || entry.isMeta || entry.isCompactSummary || entry.isSidechain) return;
        const content = entry.message?.content;
        const parts = typeof content === 'string' ? [content] : Array.isArray(content)
          ? content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text)
          : [];
        prompt = parts.map((part) => part.trim()).filter((part) => part && !part.startsWith('<')).join(' ').replace(/\s+/g, ' ');
        return Boolean(prompt);
      });
    } catch {
      return '';
    }
    return prompt;
  };

  return { locate, read, readSubagent, readAiTitle, readRealCustomTitle, readFirstPrompt, projectsDir };
};
