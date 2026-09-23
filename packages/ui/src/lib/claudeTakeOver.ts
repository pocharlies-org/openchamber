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

/** How often a session shown live keeps its server-side follow alive (the follow lapses after 15 min). */
export const CLAUDE_FOLLOW_KEEPALIVE_MS = 4 * 60 * 1000;

/**
 * Tell the server this window still shows a session another process is
 * writing, so it keeps publishing that process's messages here.
 */
export const keepFollowingClaudeSession = async (sessionId: string, directory: string | null): Promise<void> => {
  try {
    await runtimeFetch(`/api/session/${encodeURIComponent(sessionId)}/claude/follow`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ directory }),
    });
  } catch {
    // The next tick retries; the transcript stays readable either way.
  }
};
