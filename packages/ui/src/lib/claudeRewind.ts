import { z } from 'zod';

import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Claude Code's file checkpoints, as the VS Code extension's "Rewind code to
 * here": the files Claude changed go back to how they were when a prompt was
 * sent; the conversation stays (POST /api/session/:id/claude/rewind).
 */

const resultSchema = z.object({
  canRewind: z.boolean().catch(false),
  error: z.string().optional().catch(undefined),
  filesChanged: z.array(z.string()).catch([]),
  insertions: z.number().catch(0),
  deletions: z.number().catch(0),
  skippedLinks: z.number().optional().catch(undefined),
});

const responseSchema = z.object({ data: resultSchema });
const errorSchema = z.object({ message: z.string() }).catch({ message: '' });

export type ClaudeRewindResult = z.infer<typeof resultSchema>;

/** A rewind of `sessionId`'s files to the prompt `messageId`, or its preview with `dryRun`. */
export const rewindClaudeCode = async (sessionId: string, messageId: string, { dryRun }: { dryRun: boolean }): Promise<ClaudeRewindResult> => {
  const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/claude/rewind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messageID: messageId, dryRun }),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw new Error(errorSchema.parse(body ?? {}).message || `HTTP ${response.status}`);
  return responseSchema.parse(body).data;
};

/** The files a rewind names, the first few by name. */
export const describeRewindFiles = (files: readonly string[], shown = 3): string => {
  const names = files.slice(0, shown).map((file) => file.split('/').pop() || file);
  return files.length > shown ? `${names.join(', ')} +${files.length - shown}` : names.join(', ');
};
