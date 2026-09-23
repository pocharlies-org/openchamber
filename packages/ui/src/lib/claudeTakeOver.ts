import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Continue here a Claude Code session another process holds: the server
 * closes that process and resumes the session in its own
 * (POST /api/session/:id/claude/takeover). Resolves `true` once it is ours.
 */
export const takeOverClaudeSession = async (sessionId: string, directory: string | null): Promise<boolean> => {
  try {
    const response = await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/claude/takeover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory }),
    });
    return response.ok;
  } catch {
    return false;
  }
};
