import { runtimeFetch } from '@/lib/runtime-fetch';

/**
 * Claude Code's slash commands for the composer's `/` menu in a Claude session
 * (built-ins, ~/.claude/commands, the project's .claude/commands, skills,
 * plugins), as the server's Claude runtime last read them from a running CLI
 * (GET /api/claude/commands). OpenCode's command list means nothing to such a
 * session: a picked command is sent as `/name args` and Claude Code expands it.
 */
export type ClaudeCommand = { name: string; description: string; argumentHint: string };

const cache = new Map<string, { at: number; request: Promise<ClaudeCommand[] | null> }>();
const TTL_MS = 30_000;

const isCommand = (value: unknown): value is ClaudeCommand => {
  const record = value as Partial<ClaudeCommand> | null;
  return Boolean(record) && typeof record?.name === 'string' && record.name.trim().length > 0;
};

/** The commands, or `null` when they could not be read: a failure never reads as "no commands". */
export const fetchClaudeCommands = (directory: string | null | undefined): Promise<ClaudeCommand[] | null> => {
  const key = directory ?? '';
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.request;
  const request = runtimeFetch('/api/claude/commands', { query: directory ? { directory } : undefined })
    .then(async (response) => {
      if (!response.ok) throw new Error(`GET /api/claude/commands answered ${response.status}`);
      const payload = await response.json() as { commands?: unknown } | null;
      if (!Array.isArray(payload?.commands)) throw new Error('GET /api/claude/commands: unexpected payload');
      return payload.commands.filter(isCommand).map((command) => ({
        name: command.name.trim(),
        description: typeof command.description === 'string' ? command.description : '',
        argumentHint: typeof command.argumentHint === 'string' ? command.argumentHint : '',
      }));
    })
    .catch(() => {
      cache.delete(key);
      return null;
    });
  cache.set(key, { at: Date.now(), request });
  return request;
};
