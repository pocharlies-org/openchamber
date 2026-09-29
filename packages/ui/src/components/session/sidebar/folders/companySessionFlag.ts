import type { Session } from '@/lib/opencode/model';

/**
 * The single rule the sidebar uses for company-authored sessions.
 *
 * The server decides which sessions the company's bots wrote
 * (`server/lib/claude/company-sessions.js`) and stamps them
 * `metadata.company`. Everything the sidebar does about them — filing them into
 * the «Compañía» folder, keeping them out of Recent and Timeline — reads that
 * flag through this one predicate, so the three cannot drift apart.
 */
export const isCompanySession = (session: Session): boolean => (
  (session as Session & { metadata?: Record<string, unknown> | null }).metadata?.company === true
);
