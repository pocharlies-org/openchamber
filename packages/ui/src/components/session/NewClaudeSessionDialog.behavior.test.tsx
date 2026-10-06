import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { createRoot, installDom, mockDialogKit } from '@/test-utils/happyDomHarness';

import type { ClaudeModelCatalog } from '@/lib/claudeModels';

const CATALOG: ClaudeModelCatalog = {
  models: [
    { id: 'opus[1m]', label: 'Opus (1M)' },
    { id: 'sonnet', label: 'Sonnet' },
  ],
  defaultModelId: 'opus[1m]',
  efforts: [
    { id: 'low', label: 'Low' },
    { id: 'high', label: 'High' },
  ],
  defaultEffort: 'low',
  modes: [
    { id: 'default', label: 'Manual', isDefault: true },
    { id: 'plan', label: 'Plan mode' },
  ],
  defaultMode: 'default',
};

let catalog: ClaudeModelCatalog | null = CATALOG;
const creations: Array<{ directory: string; selection?: unknown }> = [];
let createResult: unknown = { id: 'ses_ccc1' };
const errors: string[] = [];

const actualI18n = await import('@/lib/i18n');

await mockDialogKit();

mock.module('@/components/ui', () => ({
  toast: {
    error: (message: string) => { errors.push(message); },
    success: () => undefined,
  },
}));
mock.module('@/components/icon/Icon', () => ({ Icon: () => null }));
mock.module('@/lib/utils', () => ({
  cn: (...values: Array<string | false | null | undefined>) => values.filter(Boolean).join(' '),
  formatPathForDisplay: (path: string) => path,
}));
mock.module('@/lib/claudeModels', () => ({
  fetchClaudeModelCatalog: async () => catalog,
}));
mock.module('@/sync/session-actions', () => ({
  createClaudeSession: async (directory: string, selection?: unknown) => {
    creations.push({ directory, selection });
    return createResult;
  },
}));
mock.module('@/lib/i18n', () => ({
  ...actualI18n,
  useI18n: () => ({ t: (key: string) => key }),
}));

const { NewClaudeSessionDialog } = await import('./NewClaudeSessionDialog');

const pickSelect = (container: HTMLElement, index: number, value: string) => {
  const select = container.querySelectorAll<HTMLSelectElement>('select')[index];
  if (!select) throw new Error(`Missing select #${index}`);
  return act(async () => {
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
};

describe('NewClaudeSessionDialog behavior', () => {
  test('opens on the catalog defaults and sends the pick with the create', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    creations.length = 0;
    catalog = CATALOG;
    createResult = { id: 'ses_ccc1' };
    try {
      await act(async () => {
        root.render(<NewClaudeSessionDialog open onOpenChange={() => undefined} directory="/repo" />);
      });

      const selects = dom.container.querySelectorAll<HTMLSelectElement>('select');
      expect(selects).toHaveLength(3);
      expect(selects[0]?.value).toBe('opus[1m]');
      expect(selects[1]?.value).toBe('low');
      expect(selects[2]?.value).toBe('default');

      await pickSelect(dom.container, 0, 'sonnet');
      await pickSelect(dom.container, 1, 'high');
      await pickSelect(dom.container, 2, 'plan');

      const create = [...dom.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'dialog.claudeNew.create');
      if (!create) throw new Error('Missing create button');
      await act(async () => { create.click(); });

      expect(creations).toEqual([
        { directory: '/repo', selection: { model: 'sonnet', effort: 'high', mode: 'plan' } },
      ]);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('a failed create reports it and does not close the dialog', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    creations.length = 0;
    errors.length = 0;
    catalog = CATALOG;
    createResult = null;
    let open = true;
    try {
      await act(async () => {
        root.render(<NewClaudeSessionDialog open={open} onOpenChange={(next) => { open = next; }} directory="/repo" />);
      });
      const create = [...dom.container.querySelectorAll('button')]
        .find((button) => button.textContent === 'dialog.claudeNew.create');
      if (!create) throw new Error('Missing create button');
      await act(async () => { create.click(); });

      expect(errors).toEqual(["dialog.claudeNew.failed"]);
      expect(open).toBe(true);
    } finally {
      await act(async () => root.unmount());
      catalog = CATALOG;
      createResult = { id: 'ses_ccc1' };
      dom.restore();
    }
  });
});
