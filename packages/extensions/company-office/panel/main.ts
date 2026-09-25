// Company Office panel: who is working, on what, and where to watch it.
// Everything comes from the package's local service in one `/overview` call.
// The live transcript is the CTO's own Claude Code session, opened in the
// host chat, which already follows it live; this panel never re-renders it.
import { connectHost, type HostReadyContext } from '@openchamber/sdk';
import {
  applyHostReady,
  mountBadge,
  mountBanner,
  mountButton,
  mountEmpty,
  mountList,
  mountTabs,
  type ListItem,
  type Tone,
} from '@openchamber/sdk/ui';
import type { EpicRow, Overview, RoleDefinition } from '../service/model.ts';
import { format, pickDictionary, type PanelKey } from './i18n.ts';

/** The prefix OpenChamber gives Claude Code sessions (lib/claude/routes.js). */
const CLAUDE_SESSION_PREFIX = 'ses_ccc';
const REFRESH_MS = 15_000;

type Tab = 'live' | 'epics' | 'roster';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing root');

let dict = pickDictionary(null);
let locale = 'en';
const t = (key: PanelKey, values?: Record<string, string | number>): string =>
  values ? format(dict[key], values) : dict[key];

let overview: Overview | null = null;
let serviceError: string | null = null;
let tab: Tab = 'live';
let selectedId: string | null = null;
let loading = false;

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const style = el('style');
style.textContent = `
  html, body { margin: 0; height: 100%; background: var(--oc-bg); color: var(--oc-fg); font: 13px/1.45 var(--oc-font); }
  #root { height: 100%; }
  .co-shell { display: flex; flex-direction: column; gap: 10px; height: 100%; box-sizing: border-box; padding: 12px; }
  .co-head { display: flex; flex-direction: column; gap: 6px; }
  .co-title-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .co-title-row h1 { margin: 0; font-size: 14px; font-weight: 600; }
  .co-badges { display: flex; gap: 4px; flex-wrap: wrap; }
  .co-spacer { flex: 1; }
  .co-note, .co-foot { margin: 0; color: var(--oc-muted); font-size: 11px; }
  .co-body { display: flex; flex-direction: column; gap: 10px; min-height: 0; flex: 1; overflow: auto; }
  .co-detail { border: 1px solid var(--oc-border); border-radius: var(--oc-radius); padding: 10px; display: flex; flex-direction: column; gap: 8px; }
  .co-detail h2 { margin: 0; font-size: 13px; font-weight: 600; }
  .co-detail dl { margin: 0; display: grid; grid-template-columns: max-content 1fr; gap: 4px 10px; }
  .co-detail dt { color: var(--oc-muted); }
  .co-detail dd { margin: 0; overflow-wrap: anywhere; }
  .co-actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .co-hint { color: var(--oc-muted); margin: 0; }
  .co-warn { color: var(--oc-warning-text); margin: 0; }
`;
document.head.append(style);

const shell = el('div', 'co-shell');
const head = el('header', 'co-head');
const titleRow = el('div', 'co-title-row');
const title = el('h1');
const badges = el('span', 'co-badges');
const refreshSlot = el('span');
const note = el('p', 'co-note');
titleRow.append(title, badges, el('span', 'co-spacer'), refreshSlot);
head.append(titleRow, note);
const bannerSlot = el('div');
const tabsSlot = el('div');
const body = el('div', 'co-body');
const listSlot = el('div');
const detailSlot = el('div');
body.append(listSlot, detailSlot);
const foot = el('p', 'co-foot');
shell.append(head, bannerSlot, tabsSlot, body, foot);
root.append(shell);

const disposers: Array<() => void> = [];
const track = <T extends { dispose: () => void }>(handle: T): T => {
  disposers.push(() => handle.dispose());
  return handle;
};

const liveRows = (): EpicRow[] => (overview?.epics ?? []).filter((row) => row.live);

const epicItem = (row: EpicRow): ListItem => {
  let badge: { label: string; tone?: Tone } | undefined;
  if (row.live) badge = { label: t('badgeLive'), tone: 'success' };
  else if (row.questionPending) badge = { label: t('badgeVp'), tone: 'warning' };
  else if (row.queuePosition !== null) badge = { label: `#${row.queuePosition}`, tone: 'info' };
  return {
    id: row.key,
    leading: row.key,
    title: row.title ?? row.key,
    subtitle: row.state,
    meta: row.jiraStatus ?? undefined,
    badge,
  };
};

const roleItem = (role: RoleDefinition): ListItem => ({
  id: role.id,
  title: role.name,
  subtitle: role.description,
  meta: role.model ?? undefined,
});

const addRow = (list: HTMLElement, label: string, value: string | null | undefined): void => {
  if (!value) return;
  list.append(el('dt', '', label), el('dd', '', value));
};

const renderEpicDetail = (row: EpicRow): void => {
  const card = el('section', 'co-detail');
  card.append(el('h2', '', `${row.key} · ${row.title ?? ''}`.replace(/ · $/, '')));
  const list = el('dl');
  addRow(list, t('supervisor'), row.state);
  addRow(list, t('reason'), row.reason);
  addRow(list, t('jira'), row.jiraStatus);
  addRow(list, t('difficulty'), row.difficulty);
  if (row.queuePosition !== null) addRow(list, '', t('queuePosition', { position: row.queuePosition }));
  if (row.resumes24h > 0) addRow(list, '', t('resumes', { count: row.resumes24h }));
  card.append(list);
  if (row.questionPending) card.append(el('p', 'co-warn', t('questionPending')));
  const actions = el('div', 'co-actions');
  if (row.sessionId) {
    const sessionId = `${CLAUDE_SESSION_PREFIX}${row.sessionId}`;
    track(mountButton(actions, {
      label: t('openSession'),
      size: 'sm',
      onClick: () => { void host.openSession(sessionId).catch((error) => void host.toast({ kind: 'error', message: String(error?.message ?? error) })); },
    }));
  }
  if (overview?.jiraBrowse) {
    const url = `${overview.jiraBrowse}/${row.key}`;
    track(mountButton(actions, { label: t('openJira'), size: 'sm', variant: 'outline', onClick: () => { void host.openUrl(url); } }));
  }
  card.append(actions);
  detailSlot.append(card);
};

const renderRoleDetail = (role: RoleDefinition): void => {
  const card = el('section', 'co-detail');
  card.append(el('h2', '', role.name));
  const list = el('dl');
  addRow(list, t('model'), role.model);
  card.append(list, el('p', '', role.description));
  detailSlot.append(card);
};

const render = (): void => {
  while (disposers.length) disposers.pop()?.();
  for (const slot of [badges, refreshSlot, bannerSlot, tabsSlot, listSlot, detailSlot]) slot.replaceChildren();

  document.documentElement.lang = locale;
  title.textContent = t('title');
  note.textContent = t('readOnly');

  const status = overview?.status;
  if (status) {
    track(mountBadge(badges, { label: status.on ? t('on') : t('off'), tone: status.on ? 'success' : 'neutral' }));
    if (status.llmStopped) track(mountBadge(badges, { label: t('llmStopped'), tone: 'error' }));
    if (status.dryRun) track(mountBadge(badges, { label: t('dryRun'), tone: 'warning' }));
    track(mountBadge(badges, { label: t('running', { count: status.running + status.runningIt, limit: status.limit ?? '—' }) }));
    if (status.queued > 0) track(mountBadge(badges, { label: t('queued', { count: status.queued }), tone: 'info' }));
  }
  track(mountButton(refreshSlot, { label: t('refresh'), size: 'xs', variant: 'ghost', loading, onClick: () => { void refresh(); } }));

  const problems: string[] = [];
  if (serviceError) problems.push(`${t('errorService')}: ${serviceError}`);
  if (overview?.errors.supervisor) problems.push(`${t('errorSupervisor')}: ${overview.errors.supervisor}`);
  if (overview?.errors.jira) problems.push(`${t('errorJira')}: ${overview.errors.jira}`);
  if (overview?.errors.roster) problems.push(`${t('errorRoster')}: ${overview.errors.roster}`);
  if (problems.length > 0) {
    track(mountBanner(bannerSlot, { tone: serviceError || overview?.errors.supervisor ? 'error' : 'warning', title: problems[0], body: problems.slice(1).join(' · ') || undefined }));
  }

  const live = liveRows();
  const epics = overview?.epics ?? [];
  const roster = overview?.roster ?? [];
  track(mountTabs(tabsSlot, {
    items: [
      { id: 'live', label: t('tabLive'), count: live.length },
      { id: 'epics', label: t('tabEpics'), count: epics.length },
      { id: 'roster', label: t('tabRoster'), count: roster.length },
    ],
    activeId: tab,
    trackBackground: true,
    onChange: (next) => { tab = next as Tab; selectedId = null; render(); },
  }));

  if (tab === 'roster') {
    if (roster.length === 0) {
      if (overview) track(mountEmpty(listSlot, { title: t('emptyRoster') }));
    } else {
      track(mountList(listSlot, { items: roster.map(roleItem), selectedId, ariaLabel: t('tabRoster'), onSelect: (id) => { selectedId = id; render(); } }));
      const role = roster.find((entry) => entry.id === selectedId);
      if (role) renderRoleDetail(role);
    }
  } else {
    const rows = tab === 'live' ? live : epics;
    if (rows.length === 0) {
      if (overview) {
        track(tab === 'live'
          ? mountEmpty(listSlot, { title: t('emptyLiveTitle'), body: t('emptyLiveBody') })
          : mountEmpty(listSlot, { title: t('emptyEpics') }));
      }
    } else {
      track(mountList(listSlot, { items: rows.map(epicItem), selectedId, ariaLabel: tab === 'live' ? t('tabLive') : t('tabEpics'), onSelect: (id) => { selectedId = id; render(); } }));
      const row = rows.find((entry) => entry.key === selectedId);
      if (row) renderEpicDetail(row);
      else detailSlot.append(el('p', 'co-hint', t('selectHint')));
    }
  }

  foot.textContent = overview
    ? t('updated', { time: new Date(overview.fetchedAt).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })
    : '';
};

const refresh = async (): Promise<void> => {
  if (loading) return;
  loading = true;
  render();
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/overview' });
    if (result.status >= 400) throw new Error(`HTTP ${result.status}`);
    overview = JSON.parse(result.body) as Overview;
    serviceError = null;
  } catch (error) {
    serviceError = error instanceof Error ? error.message : String(error);
  } finally {
    loading = false;
    render();
  }
};

let started = false;
host.onReady((context: HostReadyContext) => {
  applyHostReady(context, document.documentElement);
  dict = pickDictionary(context.locale);
  locale = context.locale || 'en';
  render();
  if (started) return;
  started = true;
  void refresh();
  window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, REFRESH_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void refresh(); });
});
