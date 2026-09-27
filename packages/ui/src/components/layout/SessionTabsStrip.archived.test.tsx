import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

import type { Session } from '@/lib/opencode/model';

// The strip decides which sessions have a tab and what the session menu is
// handed for each of them. Archiving must not take the tab away: the session
// stays open on screen, and the menu has to see the archive stamp so it offers
// Restore instead of Archive.
const ARCHIVED_AT = 1_700_000_000_000;

const ZERO_TOKENS: Session['tokens'] = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } };

const sessionFixture = (id: string, title: string, time: Session['time']): Session => ({
  id,
  projectID: 'prj_test',
  directory: '/repo',
  title,
  cost: 0,
  tokens: ZERO_TOKENS,
  time,
});

const activeSession = sessionFixture('ses_active', 'Active session', { created: 1, updated: 2 });

const archivedSession = sessionFixture('ses_archived', 'Archived session', {
  created: 1,
  updated: 2,
  archived: ARCHIVED_AT,
});

type MenuArg = { session: Session };
const menuArgs: MenuArg[] = [];

mock.module('@dnd-kit/core', () => ({
  DndContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MouseSensor: class {},
  TouchSensor: class {},
  closestCenter: () => null,
  useSensor: () => null,
  useSensors: () => [],
}));

mock.module('@dnd-kit/sortable', () => ({
  SortableContext: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  horizontalListSortingStrategy: {},
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => undefined,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1 },
    transition: undefined,
    isDragging: false,
  }),
  arrayMove: <T,>(list: T[]) => list,
}));

mock.module('@dnd-kit/utilities', () => ({
  CSS: { Translate: { toString: () => 'translate3d(0px, 0px, 0)' } },
}));

// Menus render their content as if open, so what the header's menu builder is
// handed becomes observable without a pointer interaction.
mock.module('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div data-session-menu>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => null,
}));

// The trigger mock hands the component an empty props object to spread on its
// own element; nothing else crosses this boundary.
type MockTriggerProps = Record<never, never>;

mock.module('@base-ui/react/context-menu', () => ({
  ContextMenu: {
    Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Trigger: ({ render }: { render: (props: MockTriggerProps) => React.ReactNode }) => <>{render({})}</>,
    Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Positioner: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    Popup: () => null,
    Item: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Separator: () => null,
  },
}));

mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

mock.module('@/components/icon/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

mock.module('@/components/session/SessionActivityIndicator', () => ({
  SessionActivityIndicator: () => null,
}));

mock.module('@/lib/sessionTabs', () => ({
  closeSessionTabAndActivateNeighbour: () => undefined,
}));

mock.module('@/sync/global-session-status', () => ({
  useSessionTurnActive: () => false,
}));

mock.module('@/sync/notification-store', () => ({
  useSessionUnseenCount: () => 0,
}));

mock.module('@/sync/use-session-ai-rename', () => ({
  useIsSessionAiRenamePending: () => false,
}));

const tabsState = {
  tabIds: [activeSession.id, archivedSession.id],
  ensureTab: () => undefined,
  closeOtherTabs: () => undefined,
  reorderTabs: () => undefined,
};

mock.module('@/stores/useSessionTabsStore', () => ({
  useSessionTabsStore: <T,>(selector: (state: typeof tabsState) => T): T => selector(tabsState),
}));

const sessionsState = {
  activeSessions: [activeSession],
  archivedSessions: [archivedSession],
};

mock.module('@/stores/useGlobalSessionsStore', () => ({
  useGlobalSessionsStore: <T,>(selector: (state: typeof sessionsState) => T): T => selector(sessionsState),
  resolveGlobalSessionDirectory: () => '/repo',
}));

type SessionUiState = { currentSessionId: string; setCurrentSession: () => void };

const uiState: SessionUiState = {
  currentSessionId: archivedSession.id,
  setCurrentSession: () => undefined,
};

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: <T,>(selector: (state: typeof uiState) => T): T => selector(uiState),
}));

const { SessionTabsStrip } = await import('./SessionTabsStrip');

describe('SessionTabsStrip and archived sessions', () => {
  let windowInstance: Window;
  let root: Root;
  let host: HTMLDivElement;

  beforeEach(() => {
    windowInstance = new Window({ url: 'http://localhost/' });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      navigator: windowInstance.navigator,
      Node: windowInstance.Node,
      Element: windowInstance.Element,
      HTMLElement: windowInstance.HTMLElement,
      Event: windowInstance.Event,
      MouseEvent: windowInstance.MouseEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    menuArgs.length = 0;
    uiState.currentSessionId = archivedSession.id;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
  });

  const renderStrip = async () => {
    await act(async () => {
      root.render(
        <SessionTabsStrip
          renderMenu={({ session }) => {
            menuArgs.push({ session });
            return <span data-menu-session={session.id} />;
          }}
        >
          <span data-active-title />
        </SessionTabsStrip>,
      );
    });
  };

  test('gives the archived session a real tab while it is the open one', async () => {
    await renderStrip();

    // Without a tab, the strip replaces it with the new-draft pill, which has
    // no menu or close control: the session looked unsaved instead of archived.
    expect(host.querySelectorAll('[aria-label="header.sessionTabs.closeTab"]').length).toBe(2);
    const selected = host.querySelectorAll('[role="tab"][aria-selected="true"]');
    expect(selected.length).toBe(1);
    expect(selected[0].querySelector('[data-active-title]')).not.toBeNull();
    expect(selected[0].querySelector('[title="header.session.archived"]')).not.toBeNull();
  });

  test('shows the archive marker and hands the archive stamp to the session menu', async () => {
    uiState.currentSessionId = activeSession.id;
    await renderStrip();

    expect(host.textContent).toContain('Archived session');
    const badge = host.querySelector('[title="header.session.archived"]');
    expect(badge).not.toBeNull();
    expect(badge?.querySelector('[data-icon="inbox-archive"]')).not.toBeNull();
    // The active session's own tab carries no marker.
    expect(host.querySelectorAll('[title="header.session.archived"]').length).toBe(1);

    const archivedArg = menuArgs.find((arg) => arg.session.id === archivedSession.id);
    expect(archivedArg?.session.time?.archived).toBe(1_700_000_000_000);
    const activeArg = menuArgs.find((arg) => arg.session.id === activeSession.id);
    expect(activeArg?.session.time?.archived).toBeUndefined();
  });
});
