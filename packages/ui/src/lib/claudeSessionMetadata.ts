import type { Session } from '@opencode-ai/sdk/v2';
import { z } from 'zod';
import { getSessionMetadata } from '@/lib/sessionReviewMetadata';

/**
 * Where a Claude Code session is live, as the Claude backend publishes it in
 * session metadata (server/lib/claude/runtime.js `withLiveState`).
 *
 * `liveElsewhere` means another CLI process — a terminal, VS Code, Claude
 * Desktop — is writing the transcript: OpenChamber shows it live but cannot
 * write to it until it takes it over. `remoteControlUrl` is the session's
 * claude.ai link, whoever holds it.
 */
export type ClaudeLiveOwnerKind = 'terminal' | 'vscode' | 'desktop' | 'other';

export type ClaudeLiveElsewhere = {
  kind: ClaudeLiveOwnerKind;
  name: string;
  busy: boolean;
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
}).transform(({ entrypoint, name, status }): ClaudeLiveElsewhere => ({
  kind: isKnownEntrypoint(entrypoint) ? OWNER_KINDS[entrypoint] : 'other',
  name,
  busy: status === 'busy',
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
