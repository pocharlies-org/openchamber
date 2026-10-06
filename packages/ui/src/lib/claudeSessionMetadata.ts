import type { Session } from '@/lib/opencode/model';
import { z } from 'zod';
import { getSessionMetadata } from '@/lib/sessionReviewMetadata';

/**
 * Where a Claude Code session is live, as the Claude backend publishes it in
 * session metadata (server/lib/claude/runtime.js `withLiveState`).
 *
 * `liveElsewhere` means another CLI process — a terminal, VS Code, Claude
 * Desktop — is writing the transcript: OpenChamber shows it live and, when it
 * is linked to claude.ai (`attachable`), writes to it through that link as
 * Claude Desktop does; otherwise only after taking it over. `remoteControlUrl` is the session's
 * claude.ai link, whoever holds it.
 */
export type ClaudeLiveOwnerKind = 'terminal' | 'vscode' | 'desktop' | 'other';

export type ClaudeLiveElsewhere = {
  kind: ClaudeLiveOwnerKind;
  name: string;
  busy: boolean;
  /** Linked to claude.ai: OpenChamber writes to it through that link. */
  attachable: boolean;
};

export type ClaudeLiveState = {
  liveElsewhere: ClaudeLiveElsewhere | null;
  remoteControlUrl: string | null;
};

const OWNER_KINDS = {
  cli: 'terminal',
  'claude-vscode': 'vscode',
  'claude-desktop': 'desktop',
} as const satisfies Record<string, ClaudeLiveOwnerKind>;

const isKnownEntrypoint = (entrypoint: string): entrypoint is keyof typeof OWNER_KINDS =>
  Object.hasOwn(OWNER_KINDS, entrypoint);

const liveElsewhereSchema = z.object({
  entrypoint: z.string().catch(''),
  name: z.string().catch(''),
  status: z.string().catch('idle'),
  attachable: z.boolean().catch(false),
}).transform(({ entrypoint, name, status, attachable }): ClaudeLiveElsewhere => ({
  kind: isKnownEntrypoint(entrypoint) ? OWNER_KINDS[entrypoint] : 'other',
  name,
  busy: status === 'busy',
  attachable,
}));

// Only a claude.ai link is ever rendered as one.
const remoteControlSchema = z.object({
  url: z.string().startsWith('https://claude.ai/'),
});

export const getClaudeLiveState = (session: Session | null | undefined): ClaudeLiveState => {
  const metadata = getSessionMetadata(session);
  const liveElsewhere = liveElsewhereSchema.safeParse(metadata.liveElsewhere);
  const remoteControl = remoteControlSchema.safeParse(metadata.remoteControl);
  return {
    liveElsewhere: liveElsewhere.success ? liveElsewhere.data : null,
    remoteControlUrl: remoteControl.success ? remoteControl.data.url : null,
  };
};

/**
 * What the Claude engine knows about a session as it runs (server
 * runtime.js `sessionState`, published as `metadata.claude`): the permission
 * mode it is in, the prompt cache's lifetime, the model's context window.
 */
type ClaudeEngineState = {
  mode: string | null;
  cacheTtlMs: number | null;
  contextWindow: number | null;
};

const positive = z.number().positive().finite();
const engineStateSchema = z.object({
  mode: z.string().min(1).nullable().catch(null),
  cacheTtlMs: positive.nullable().catch(null),
  contextWindow: positive.nullable().catch(null),
}).partial();

export const getClaudeEngineState = (session: Session | null | undefined): ClaudeEngineState => {
  const parsed = engineStateSchema.safeParse(getSessionMetadata(session).claude ?? {});
  const data = parsed.success ? parsed.data : {};
  return { mode: data.mode ?? null, cacheTtlMs: data.cacheTtlMs ?? null, contextWindow: data.contextWindow ?? null };
};

/** A subagent's child session: what it is and whether it still runs (`metadata.subagent`). */
type ClaudeSubagentState = {
  agentType: string;
  status: string;
  startedAt: number | null;
  endedAt: number | null;
};

const subagentSchema = z.object({
  agentType: z.string().catch(''),
  status: z.string().catch('completed'),
  startedAt: z.number().nullable().catch(null).optional(),
  endedAt: z.number().nullable().catch(null).optional(),
});

export const getClaudeSubagentState = (session: Session | null | undefined): ClaudeSubagentState | null => {
  const parsed = subagentSchema.safeParse(getSessionMetadata(session).subagent);
  if (!parsed.success) return null;
  return {
    agentType: parsed.data.agentType,
    status: parsed.data.status,
    startedAt: parsed.data.startedAt ?? null,
    endedAt: parsed.data.endedAt ?? null,
  };
};

const CLAUDE_SESSION_PREFIX = 'ses_ccc';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Link that opens a Claude Code session in the Claude Code VS Code extension
 * (its `/open` URI handler). The transcript lives on the machine that wrote it,
 * so it resolves in a VS Code window connected there with the project open.
 */
export const claudeVSCodeUrl = (sessionId: string | null | undefined): string | null => {
  if (!sessionId?.startsWith(CLAUDE_SESSION_PREFIX)) return null;
  const uuid = sessionId.slice(CLAUDE_SESSION_PREFIX.length);
  return UUID.test(uuid) ? `vscode://anthropic.claude-code/open?session=${uuid}` : null;
};
