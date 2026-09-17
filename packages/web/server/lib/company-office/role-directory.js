/**
 * Resolves a role folder into the configuration each engine wants.
 *
 * The folder is the source of truth for what a role may do:
 *
 *   roles/<role>/prompt.md
 *   roles/<role>/<mode>/opencode.md
 *   roles/<role>/<mode>/claude.settings.json
 *   roles/<role>/<mode>/codex.config.toml
 *
 * `mode` is `normal` or `plan`, and it is a folder rather than a flag so the two
 * boundaries can be read side by side instead of derived from one another.
 *
 * HOW EACH ENGINE TAKES IT, AND WHY THEY DIFFER
 * --------------------------------------------
 * Claude and Codex are handed the configuration per invocation -- `--settings`
 * and `-c` overrides -- so neither has to move its home. That matters: the login
 * and the session history live in those homes, and relocating them would break
 * `claude --resume` and `codex exec resume`, which is the reason for driving the
 * real clients at all.
 *
 * OpenCode cannot do that. A session names its agent (`company/devops`) and the
 * server resolves it from its own agents directory, so those files have to exist
 * there. `installOpenCodeAgents` copies them in. The asymmetry is not tidy, but
 * hiding it behind a uniform-looking API would mean pretending no copy happens.
 */

import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const MODES = Object.freeze(['normal', 'plan']);

const TOML_SCALAR = /^\s*(?<key>[A-Za-z0-9_.]+)\s*=\s*(?<value>.+?)\s*$/;

/**
 * The handful of scalars the generated profiles carry, as `-c key=value` pairs.
 *
 * Reading them out rather than installing the file as a Codex profile keeps the
 * folder the only copy: a profile installed into CODEX_HOME is a second one that
 * drifts the first time somebody edits either side.
 */
export const codexOverrides = (toml) => {
  const overrides = [];
  for (const line of String(toml).split('\n')) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = TOML_SCALAR.exec(line);
    if (match) overrides.push(`${match.groups.key}=${match.groups.value}`);
  }
  return overrides;
};

export const createRoleDirectory = ({ root, readFileImpl = readFile, readdirImpl = readdir }) => {
  const cache = new Map();

  const load = async (role, mode) => {
    if (!MODES.includes(mode)) {
      throw new Error(`Unknown role mode "${mode}". Expected one of: ${MODES.join(', ')}.`);
    }
    const key = `${role}/${mode}`;
    if (cache.has(key)) return cache.get(key);

    const modeDir = join(root, role, mode);
    const claudeSettingsPath = join(modeDir, 'claude.settings.json');
    let codexConfig;
    let opencodeAgent;
    try {
      // Read the settings here to fail in the dispatcher rather than inside a
      // spawned CLI, where a missing file is a silently unrestricted turn.
      await readFileImpl(claudeSettingsPath, 'utf8');
      codexConfig = await readFileImpl(join(modeDir, 'codex.config.toml'), 'utf8');
      opencodeAgent = await readFileImpl(join(modeDir, 'opencode.md'), 'utf8');
    } catch (error) {
      throw new Error(`Role "${role}" has no usable "${mode}" mode in ${root}: ${error.message}`);
    }

    const resolved = {
      role,
      mode,
      claudeSettingsPath,
      codexOverrides: codexOverrides(codexConfig),
      opencodeAgent,
      opencodeAgentId: `company/${role}`,
    };
    cache.set(key, resolved);
    return resolved;
  };

  return {
    root,
    load,

    /** Role folders present on disk, so a misconfigured role fails with a list. */
    async list() {
      const entries = await readdirImpl(root, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    },

    /**
     * Copies the mode's OpenCode agents into the server's agents directory.
     *
     * Only OpenCode needs this: the agent a session names must already exist on
     * the server, so there is no per-invocation way to hand it one.
     */
    async installOpenCodeAgents(mode, agentsDir, { mkdirImpl = mkdir, writeFileImpl = writeFile } = {}) {
      const roles = await this.list();
      await mkdirImpl(agentsDir, { recursive: true });
      const installed = [];
      for (const role of roles) {
        const resolved = await load(role, mode);
        await writeFileImpl(join(agentsDir, `${role}.md`), resolved.opencodeAgent);
        installed.push(resolved.opencodeAgentId);
      }
      return installed;
    },
  };
};
