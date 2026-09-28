import { getClaudeSubagentState } from '@/lib/claudeSessionMetadata';
import type { Session } from '@/lib/opencode/model';

/** Where a subagent stands, as the agent map shows it. */
export type AgentStatus = 'running' | 'completed' | 'failed' | 'stopped';

/** A child's status: live (its busy status) first, then what the engine recorded. */
export const agentStatusOf = (session: Session, busy: boolean): AgentStatus => {
    if (busy) return 'running';
    const recorded = getClaudeSubagentState(session)?.status ?? 'completed';
    if (recorded === 'running') return 'running';
    if (recorded === 'failed' || recorded === 'error') return 'failed';
    if (recorded === 'stopped' || recorded === 'killed') return 'stopped';
    return 'completed';
};

/** Children in the store (live) merged over the ones read from the server (history), oldest first. */
export const mergeChildren = (live: readonly Session[], fetched: readonly Session[]): Session[] => {
    const byId = new Map<string, Session>();
    for (const session of fetched) byId.set(session.id, session);
    for (const session of live) byId.set(session.id, session);
    return [...byId.values()].sort((a, b) => (a.time?.created ?? 0) - (b.time?.created ?? 0));
};

/** Elapsed time as the agent map shows it: 42s, 3m 5s, 1h 2m. */
export const formatElapsed = (ms: number): string => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
};
