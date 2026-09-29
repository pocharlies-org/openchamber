import type { Session } from '@/lib/opencode/model';
import { isFinalToolStatus, type Part } from '@/lib/opencode/model';
import { isExecuteTool, isFileChangeTool, isShellTool } from '@/lib/opencode/tools';
import { notifyGitStatusInvalidated } from '@/lib/gitStatusInvalidation';
import type { WorktreeMetadata } from '@/types/worktree';

export type SessionDeleteRequest = {
  sessions: Session[];
  dateLabel?: string;
  mode?: 'session' | 'worktree';
  worktree?: WorktreeMetadata | null;
};

export type SessionCreateRequest = {
  worktreeMode?: 'main' | 'create' | 'reuse';
  parentID?: string | null;
  projectId?: string | null;
};

/**
 * The `+` asked for a Claude session: the dialog picks its model, thinking
 * level and mode, and hands the created session back to whoever asked (a
 * folder, for one, has to place the session in it).
 */
export type NewClaudeSessionRequest = {
  directory: string;
  onCreated?: (session: Session | null) => void;
};

type DeleteListener = (request: SessionDeleteRequest) => void;
type CreateListener = (request: SessionCreateRequest) => void;
type NewClaudeSessionListener = (request: NewClaudeSessionRequest) => void;
type DirectoryListener = () => void;
type GitRefreshHint = { directory: string; paths?: string[] };
type GitRefreshListener = (hint: GitRefreshHint) => void;

const deleteListeners = new Set<DeleteListener>();
const createListeners = new Set<CreateListener>();
const newClaudeSessionListeners = new Set<NewClaudeSessionListener>();
const directoryListeners = new Set<DirectoryListener>();
const gitRefreshListeners = new Set<GitRefreshListener>();
// Shell and code-mode scripts can touch the worktree too, so they count
// alongside the file tools.
const isGitMutatingTool = (tool: string): boolean =>
  isFileChangeTool(tool) || isShellTool(tool) || isExecuteTool(tool);

export const sessionEvents = {
  onDeleteRequest(listener: DeleteListener) {
    deleteListeners.add(listener);
    return () => {
      deleteListeners.delete(listener);
    };
  },
  requestDelete(payload: SessionDeleteRequest) {
    if (!payload.sessions.length && payload.mode !== 'worktree') {
      return;
    }
    deleteListeners.forEach((listener) => listener(payload));
  },
  onCreateRequest(listener: CreateListener) {
    createListeners.add(listener);
    return () => {
      createListeners.delete(listener);
    };
  },
  requestCreate(payload?: SessionCreateRequest) {
    const request = payload ?? {};
    createListeners.forEach((listener) => listener(request));
  },
  onNewClaudeSessionRequest(listener: NewClaudeSessionListener) {
    newClaudeSessionListeners.add(listener);
    return () => {
      newClaudeSessionListeners.delete(listener);
    };
  },
  /**
   * Ask for the new-Claude-session dialog. Answers `false` when nothing is
   * mounted to show it (a surface without `SessionDialogs`), so the caller can
   * still create the session instead of dropping the click.
   */
  requestNewClaudeSession(payload: NewClaudeSessionRequest): boolean {
    if (!payload.directory || newClaudeSessionListeners.size === 0) {
      return false;
    }
    newClaudeSessionListeners.forEach((listener) => listener(payload));
    return true;
  },
  onDirectoryRequest(listener: DirectoryListener) {
    directoryListeners.add(listener);
    return () => {
      directoryListeners.delete(listener);
    };
  },
  requestDirectoryDialog() {
    directoryListeners.forEach((listener) => listener());
  },
  onGitRefreshHint(listener: GitRefreshListener) {
    gitRefreshListeners.add(listener);
    return () => {
      gitRefreshListeners.delete(listener);
    };
  },
  requestGitRefresh(hint: GitRefreshHint) {
    if (!hint.directory.trim()) {
      return;
    }
    notifyGitStatusInvalidated(hint.directory);
    gitRefreshListeners.forEach((listener) => listener(hint));
  },
  requestGitRefreshForToolTransition(directory: string, previousPart: Part | undefined, nextPart: Part) {
    // A failed patch or shell command may still have written files.
    if (nextPart.type !== 'tool' || !isFinalToolStatus(nextPart.state.status)) {
      return;
    }
    if (previousPart?.type === 'tool' && isFinalToolStatus(previousPart.state.status)) {
      return;
    }
    if (!isGitMutatingTool(nextPart.tool)) {
      return;
    }
    sessionEvents.requestGitRefresh({ directory });
  },
};
