import React from 'react';
import type { Session } from '@/lib/opencode/model';
import { getSafeStorage } from '@/stores/utils/safeStorage';

/**
 * Files company-authored sessions into a "Compañía" folder automatically.
 *
 * The claude backend stamps `metadata.company` on sessions whose dispatch
 * prompt comes from the company's launchers (server/lib/claude/company-sessions.js).
 * This hook mirrors useArchivedAutoFolders, with one deliberate difference:
 * each session is filed exactly once. A folder the user drags a session out
 * of (or into) is their call and is never overruled again — the set of
 * already-filed ids lives in local storage for that purpose.
 */

export const COMPANY_FOLDER_NAME = 'Compañía';

const AUTO_FILED_STORAGE_KEY = 'oc.sessions.companyAutoFiled';

type FolderEntry = {
  id: string;
  name: string;
  sessionIds: string[];
};

type ProjectForCompanyFolders = {
  id: string;
  normalizedPath: string;
};

type Args = {
  enabled?: boolean;
  normalizedProjects: ProjectForCompanyFolders[];
  ownership: { sessionsByProject: Map<string, Session[]> };
  isSessionsLoading: boolean;
  hasAuthoritativeGlobalSessions: boolean;
  foldersMap: Record<string, FolderEntry[]>;
  createFolder: (scopeKey: string, name: string, parentId?: string | null) => FolderEntry;
  addSessionToFolder: (scopeKey: string, folderId: string, sessionId: string) => void;
};

const isCompanySession = (session: Session): boolean => (
  (session as Session & { metadata?: Record<string, unknown> | null }).metadata?.company === true
);

const readAutoFiledIds = (): Set<string> => {
  try {
    const parsed = JSON.parse(getSafeStorage().getItem(AUTO_FILED_STORAGE_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
};

const writeAutoFiledIds = (ids: Set<string>): void => {
  try {
    getSafeStorage().setItem(AUTO_FILED_STORAGE_KEY, JSON.stringify(Array.from(ids)));
  } catch {
    // A full or blocked storage only costs the drag-out guard for this tab.
  }
};

export const useCompanyAutoFolders = (args: Args): void => {
  const {
    enabled = true,
    normalizedProjects,
    ownership,
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    foldersMap,
    createFolder,
    addSessionToFolder,
  } = args;

  React.useEffect(() => {
    if (!enabled || isSessionsLoading || !hasAuthoritativeGlobalSessions) {
      return;
    }

    const autoFiled = readAutoFiledIds();
    let changed = false;

    normalizedProjects.forEach((project) => {
      const companySessions = (ownership.sessionsByProject.get(project.id) ?? [])
        .filter(isCompanySession)
        .filter((session) => !autoFiled.has(session.id));
      if (companySessions.length === 0) {
        return;
      }

      const scopeKey = project.normalizedPath;
      const scopeFolders = foldersMap[scopeKey] ?? [];
      const found = scopeFolders.find((entry) => entry.name.toLowerCase() === COMPANY_FOLDER_NAME.toLowerCase());
      const folder = found ?? createFolder(scopeKey, COMPANY_FOLDER_NAME);

      companySessions.forEach((session) => {
        if (!folder.sessionIds.includes(session.id)) {
          addSessionToFolder(scopeKey, folder.id, session.id);
        }
        autoFiled.add(session.id);
        changed = true;
      });
    });

    if (changed) {
      writeAutoFiledIds(autoFiled);
    }
  }, [
    enabled,
    normalizedProjects,
    ownership,
    isSessionsLoading,
    hasAuthoritativeGlobalSessions,
    foldersMap,
    createFolder,
    addSessionToFolder,
  ]);
};
