import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test';
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';
const browser = new Window({ url: 'http://localhost' });
let root: Root;
const descriptors = new Map<string, PropertyDescriptor | undefined>();
// React DOM detects input-event support when imported, so install the DOM first.
for (const [key, value] of Object.entries({ window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage, Element: browser.Element, HTMLElement: browser.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
  descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { value, configurable: true });
}
const { createRoot } = await import('react-dom/client');
const { I18nProvider } = await import('@/lib/i18n');
const { useUIStore } = await import('@/stores/useUIStore');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { ArchiveView } = await import('./ArchiveView');
const initialUI = useUIStore.getState();
const initialSessions = useGlobalSessionsStore.getState();
const session = (id: string, title: string, archived = 2): Session => ({
  id, title, projectID: 'project', cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, directory: '/workspace',
  time: { created: 1, updated: 1, archived },
});

beforeEach(() => {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  useUIStore.setState({ isArchivePageOpen: true });
});

afterEach(async () => {
  await act(async () => root.unmount());
  useUIStore.setState(initialUI);
  useGlobalSessionsStore.setState(initialSessions);
  document.body.replaceChildren();
});

afterAll(async () => {
  await browser.happyDOM.close();
  for (const [key, descriptor] of descriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test('archive search uses exact IDs and preserves title search and archive membership', async () => {
  const id = 'ses_f88b1a2b3c4d';
  useGlobalSessionsStore.setState({
    archivedSessions: [session(id, 'Release notes'), session('ses_f88b1a2b3c4e', id)],
    activeSessions: [session('ses_active', 'Active session', 0)],
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  const input = browser.document.querySelector('input');
  if (!input) throw new Error('Archive search input missing');
  const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, 'value')?.set;
  if (!setValue) throw new Error('Input value setter missing');
  const search = async (query: string) => {
    await act(async () => {
      setValue.call(input, query);
      input.dispatchEvent(new browser.Event('input', { bubbles: true }));
      input.dispatchEvent(new browser.Event('change', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    });
    return [...document.querySelectorAll('[role="button"] > span:first-child')].map((row) => row.textContent);
  };
  expect(await search(id)).toEqual(['Release notes']);
  expect(await search(`  ${id.toUpperCase()}  `)).toEqual(['Release notes']);
  for (const query of ['ses_', 'ses_f88b', 'ses_f88b1a2b3c4f', `${id}x`, `${id} error`, 'ses_active']) {
    expect(await search(query)).toEqual([]);
  }
  expect(await search('release')).toEqual(['Release notes']);
  expect(await search('releaze')).toEqual(['Release notes']);
  expect(await search('')).toHaveLength(2);
});

test('the chats of a deleted space are grouped under its name and cannot be restored', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => new Response(JSON.stringify({
    archives: [{ spaceId: 'a1b2c3d4e5f6', name: 'Fix login', directory: '/data/spaces/archive/a1b2c3d4e5f6' }],
  }), { status: 200 }), originalFetch);
  try {
    useGlobalSessionsStore.setState({
      archivedSessions: [
        { ...session('ses_space1', 'Agent chat'), directory: '/data/spaces/archive/a1b2c3d4e5f6' },
        session('ses_mine1', 'My chat'),
      ],
      activeSessions: [],
    });
    await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const groups = [...document.querySelectorAll('.group\\/dir button[title]')].map((button) => button.textContent);
    expect(groups.some((label) => label?.startsWith('Fix login'))).toBe(true);
    expect(document.querySelector('[aria-label="Restore Agent chat"]')).toBeNull();
    expect(document.querySelector('[aria-label="Restore My chat"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Delete Agent chat"]')).not.toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
  }
const claudeSession = (id: string, title: string, archived = 2): Session => ({
  ...session(id, title, archived),
  metadata: { backend: 'claude' },
});

test('archive rows glyph Claude sessions only, and the tool filter appears when both tools are archived', async () => {
  useGlobalSessionsStore.setState({
    archivedSessions: [session('ses_opencode1', 'Native chat', 3), claudeSession('ses_claude1', 'Claude chat', 2)],
    activeSessions: [],
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  const rows = [...document.querySelectorAll('[role="button"]')];
  const claudeRow = rows.find((row) => row.textContent?.includes('Claude chat'));
  const opencodeRow = rows.find((row) => row.textContent?.includes('Native chat'));
  expect(claudeRow?.querySelector('svg[aria-label="Claude Code"]')).toBeTruthy();
  expect(opencodeRow?.querySelector('svg[aria-label="Claude Code"]')).toBeFalsy();
  const chips = [...document.querySelectorAll('button[aria-pressed]')];
  expect(chips.map((chip) => chip.textContent)).toEqual(['All tools', 'opencode', 'Claude Code']);
});

test('archive tool filter narrows the list, the search and the counts together', async () => {
  useGlobalSessionsStore.setState({
    archivedSessions: [
      session('ses_opencode1', 'Native chat', 3),
      claudeSession('ses_claude1', 'Claude chat', 2),
      claudeSession('ses_claude2', 'Claude rewind', 1),
    ],
    activeSessions: [],
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  const clickChip = async (label: string) => {
    const chip = [...document.querySelectorAll('button[aria-pressed]')].find((c) => c.textContent === label);
    if (!chip) throw new Error(`Chip missing: ${label}`);
    await act(async () => { chip.click(); });
    return {
      titles: [...document.querySelectorAll('[role="button"]')].map((row) => row.textContent ?? ''),
      count: document.querySelector('span.self-start')?.textContent ?? '',
    };
  };
  const claude = await clickChip('Claude Code');
  expect(claude.titles).toHaveLength(2);
  expect(claude.titles.every((text) => text.includes('Claude'))).toBe(true);
  expect(claude.count).toContain('2');
  const opencode = await clickChip('opencode');
  expect(opencode.titles).toHaveLength(1);
  expect(opencode.titles[0]).toContain('Native chat');
  const all = await clickChip('All tools');
  expect(all.titles).toHaveLength(3);
});

test('archive keeps a single-source list free of the tool filter', async () => {
  useGlobalSessionsStore.setState({
    archivedSessions: [session('ses_opencode1', 'Native chat'), session('ses_opencode2', 'Another chat', 1)],
    activeSessions: [],
  });
  await act(async () => root.render(<I18nProvider><ArchiveView /></I18nProvider>));
  expect(document.querySelector('button[aria-pressed]')).toBeFalsy();
});
