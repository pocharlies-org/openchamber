import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const MAX_AGENT_FILES = 50;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_LISTED_TOOLS = 40;
const MAX_DESCRIPTION_CHARS = 300;

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/;

const optionalString = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * What an installation can see about the agent files on the OpenCode host.
 *
 * This exists because two halves of a role live in different places and only one
 * of them is data. `model` and `permission` travel inline on session creation, so
 * the plugin owns them; `tools` (the MCP gating) is NOT accepted by POST /session,
 * so it lives in the agent file and only applies when OpenCode restarts. Showing
 * the file-owned half read-only is the honest way to render that split: an
 * operator must not believe they can change an MCP from Jira when they cannot.
 *
 * Everything here is deliberately bounded. The prompt body is never read out —
 * it is the longest and most sensitive part of the file, and a Jira admin page
 * has a wider audience than the host.
 */
const summarisePermission = (permission) => {
  if (permission === 'deny' || permission === 'allow' || permission === 'ask') {
    return { edit: null, bashDefault: permission, denied: [], scalar: permission };
  }
  if (!permission || typeof permission !== 'object') return null;
  const bash = permission.bash;
  const bashMap = bash && typeof bash === 'object' && !Array.isArray(bash) ? bash : null;
  const denied = bashMap
    ? Object.entries(bashMap)
      .filter(([, action]) => action === 'deny')
      .map(([pattern]) => pattern)
      .slice(0, MAX_LISTED_TOOLS)
    : [];
  return {
    edit: optionalString(permission.edit),
    bashDefault: bashMap ? optionalString(bashMap['*']) : optionalString(bash),
    denied,
    scalar: null,
  };
};

/** Tool/MCP gating as declared in the file: only the explicitly disabled globs. */
const disabledTools = (tools) => {
  if (!tools || typeof tools !== 'object' || Array.isArray(tools)) return [];
  return Object.entries(tools)
    .filter(([, enabled]) => enabled === false)
    .map(([pattern]) => pattern)
    .slice(0, MAX_LISTED_TOOLS);
};

export const parseAgentFile = (id, text) => {
  const match = FRONTMATTER.exec(text ?? '');
  if (!match) return { id, readable: false, reason: 'no_frontmatter' };
  let front;
  try {
    front = parseYaml(match[1]);
  } catch {
    return { id, readable: false, reason: 'invalid_yaml' };
  }
  if (!front || typeof front !== 'object') return { id, readable: false, reason: 'invalid_yaml' };
  const description = optionalString(front.description);
  return {
    id,
    readable: true,
    mode: optionalString(front.mode),
    description: description ? description.slice(0, MAX_DESCRIPTION_CHARS) : null,
    // A model pinned in the file is a fallback: the ruleset the plugin sends wins.
    fileModel: optionalString(front.model),
    disabledTools: disabledTools(front.tools),
    permission: summarisePermission(front.permission),
  };
};

/**
 * Reads every `company/*.md` agent file.
 *
 * A directory that cannot be listed yields `state: 'error'` rather than an empty
 * inventory: "no agents" and "I could not look" must never render the same, or a
 * broken path would show up in Jira as a company with nobody in it.
 */
export const readAgentInventory = async ({
  directory,
  readdirImpl = readdir,
  readFileImpl = readFile,
} = {}) => {
  if (!optionalString(directory)) return { state: 'error', reason: 'no_directory', agents: [] };
  let names;
  try {
    names = await readdirImpl(directory);
  } catch (error) {
    return { state: 'error', reason: error?.code === 'ENOENT' ? 'missing' : 'unreadable', agents: [] };
  }
  const files = names.filter((name) => name.endsWith('.md')).sort();
  const truncated = files.length > MAX_AGENT_FILES;
  const agents = [];
  for (const name of files.slice(0, MAX_AGENT_FILES)) {
    const id = name.replace(/\.md$/, '');
    try {
      const text = await readFileImpl(join(directory, name), 'utf8');
      agents.push(parseAgentFile(id, typeof text === 'string' ? text.slice(0, MAX_FILE_BYTES) : ''));
    } catch {
      agents.push({ id, readable: false, reason: 'unreadable' });
    }
  }
  return { state: truncated ? 'partial' : 'ready', agents };
};
