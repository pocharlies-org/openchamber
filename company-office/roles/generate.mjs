#!/usr/bin/env node
/**
 * Materialises one folder per role, with a `plan` and a `normal` mode inside it,
 * holding the native configuration of all three engines.
 *
 * WHY A FOLDER AND NOT AN AGENT FILE
 * ----------------------------------
 * A role is not an OpenCode agent that two other runtimes have to imitate. It is
 * a boundary — what this employee may read, change and run — and each engine
 * spells that boundary in its own file. Keeping one folder per role, with the
 * three spellings side by side, makes the boundary something you can open and
 * read instead of something you have to derive.
 *
 * Layout:
 *
 *   roles/<role>/prompt.md                      shared, mode-independent
 *   roles/<role>/<mode>/opencode.md             OpenCode agent
 *   roles/<role>/<mode>/claude.settings.json    passed with `--settings`
 *   roles/<role>/<mode>/codex.config.toml       layered with `--profile`
 *
 * Neither CLI has to move its home for this: Claude takes `--settings` and Codex
 * layers a profile, so credentials and session history stay where they are and
 * `claude --resume` / `codex exec resume` keep working on the operator's own
 * store.
 *
 * PERMISSION SEMANTICS DIFFER, AND THAT IS THE HARD PART
 * -----------------------------------------------------
 * OpenCode evaluates with `findLast`: the LAST matching rule wins, which is why
 * the CTO can deny `kubectl *` and then allow `kubectl get*` underneath it.
 * Claude resolves by precedence instead — deny beats ask beats allow — so the
 * same two rules translated literally would take `kubectl get` away from the
 * role that exists to audit the stack.
 *
 * So a broad deny is dropped when a narrower allow sits under it, and the
 * specific allows are emitted on their own. What is not allowed then falls to
 * the default, which unattended means it does not run. The boundary stays
 * closed; the reads the role needs survive.
 *
 * Codex is coarser still: its sandbox has no per-command patterns, so a role's
 * bash rules collapse into a sandbox mode. That loss is real and is recorded in
 * the generated file rather than hidden.
 *
 * Run: node company-office/roles/generate.mjs
 */

import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, '..', 'agents', 'company');
const MODES = ['normal', 'plan'];

const FRONTMATTER = /^---\n(?<yaml>[\s\S]*?)\n---\n(?<body>[\s\S]*)$/;

/** Commands that change the world; plan mode refuses them whatever the role says. */
const MUTATING = ['git push', 'gh pr merge', 'git merge', 'helm', 'argocd', 'kubectl', 'systemctl', 'rm', 'docker'];

const parseAgent = (text) => {
  const match = FRONTMATTER.exec(text);
  if (!match) throw new Error('agent file has no frontmatter');
  return { meta: parse(match.groups.yaml), body: match.groups.body.trim() };
};

/** `git push*` -> `git push`, `helm *` -> `helm`, `*` -> null (means "all bash"). */
const prefixOf = (glob) => {
  const trimmed = String(glob).replace(/\*+$/, '').trim();
  return trimmed === '' ? null : trimmed;
};

const bashRules = (meta) => {
  const bash = meta?.permission?.bash;
  if (!bash || typeof bash !== 'object') return [];
  return Object.entries(bash).map(([glob, action]) => ({ glob, prefix: prefixOf(glob), action }));
};

// ── OpenCode ────────────────────────────────────────────────────────────────
const opencodeAgent = (meta, body, mode) => {
  const next = structuredClone(meta);
  if (mode === 'plan') {
    next.permission = next.permission ?? {};
    next.permission.edit = 'deny';
    const bash = { ...(next.permission.bash ?? {}) };
    // Reads stay whatever the role allows; anything that writes is refused.
    for (const command of MUTATING) bash[`${command}*`] = 'deny';
    next.permission.bash = bash;
    next.description = `[PLAN] ${next.description ?? ''}`.trim();
  }
  const yaml = Object.entries(next)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join('\n');
  return `---\n${yaml}\n---\n\n${body}\n`;
};

// ── Claude ──────────────────────────────────────────────────────────────────
const claudeSettings = (meta, mode) => {
  const rules = bashRules(meta);
  const allowPrefixes = rules.filter((r) => r.action === 'allow' && r.prefix).map((r) => r.prefix);

  const allow = [];
  const deny = [];
  for (const rule of rules) {
    if (!rule.prefix) continue; // the catch-all is the default mode's business
    const target = `Bash(${rule.prefix}:*)`;
    if (rule.action === 'allow') { allow.push(target); continue; }
    if (rule.action !== 'deny') continue;
    // Dropping a broad deny that has narrower allows under it: keeping it would
    // win on precedence and silently remove the reads the role depends on.
    const overridden = allowPrefixes.some((prefix) => prefix !== rule.prefix && prefix.startsWith(rule.prefix));
    if (!overridden) deny.push(target);
  }

  if (meta?.permission?.edit === 'deny' || mode === 'plan') deny.push('Edit', 'Write', 'NotebookEdit');
  if (meta?.permission?.webfetch === 'allow' && mode !== 'plan') allow.push('WebFetch');
  if (mode === 'plan') for (const command of MUTATING) deny.push(`Bash(${command}:*)`);

  return {
    permissions: {
      // `plan` is Claude's own read-only mode; `acceptEdits` is the working one.
      defaultMode: mode === 'plan' ? 'plan' : 'acceptEdits',
      allow: [...new Set(allow)].sort(),
      deny: [...new Set(deny)].sort(),
    },
  };
};

// ── Codex ───────────────────────────────────────────────────────────────────
const codexProfile = (role, meta, mode) => {
  const writes = mode !== 'plan' && meta?.permission?.edit !== 'deny';
  const denied = bashRules(meta).filter((r) => r.action === 'deny').map((r) => r.glob);
  return `# ${role} · ${mode}
#
# Layered onto the base config with \`codex exec --profile ${role}-${mode}\`, so the
# ChatGPT login and the rollout history in CODEX_HOME are untouched.
#
# FIDELITY: Codex's sandbox has no per-command patterns, so this role's bash rules
# collapse into a sandbox mode. These stay denied by the role definition and are
# NOT enforceable here -- do not read this file as if they were:
${denied.length ? denied.map((glob) => `#   ${glob}`).join('\n') : '#   (none)'}

model_reasoning_effort = "${mode === 'plan' ? 'high' : 'medium'}"
approval_policy = "never"
sandbox_mode = "${writes ? 'workspace-write' : 'read-only'}"
`;
};

// ── Materialise ─────────────────────────────────────────────────────────────
const main = async () => {
  const files = (await readdir(SOURCE)).filter((name) => name.endsWith('.md'));
  const written = [];

  for (const file of files) {
    const role = file.replace(/\.md$/, '');
    const { meta, body } = parseAgent(await readFile(join(SOURCE, file), 'utf8'));
    const roleDir = join(HERE, role);

    await mkdir(roleDir, { recursive: true });
    await writeFile(join(roleDir, 'prompt.md'), `${body}\n`);
    written.push(`${role}/prompt.md`);

    for (const mode of MODES) {
      const modeDir = join(roleDir, mode);
      await mkdir(modeDir, { recursive: true });
      await writeFile(join(modeDir, 'opencode.md'), opencodeAgent(meta, body, mode));
      await writeFile(join(modeDir, 'claude.settings.json'), `${JSON.stringify(claudeSettings(meta, mode), null, 2)}\n`);
      await writeFile(join(modeDir, 'codex.config.toml'), codexProfile(role, meta, mode));
      written.push(`${role}/${mode}/`);
    }
  }

  console.log(`${files.length} roles x ${MODES.length} modes materialised:`);
  for (const entry of written) console.log(`  ${entry}`);
};

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
