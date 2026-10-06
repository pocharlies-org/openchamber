import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import type { AgentProvider } from './sessionEngine';
import { SESSION_ENGINE_INFO } from './sessionEngine';

const root = new URL('../../../../', import.meta.url);
const enginesModule = await import(new URL('packages/web/server/lib/engines/engines.js', root).href);
const serverEngines: Record<string, AgentProvider> = enginesModule.ENGINES;

const matrix = new Map(
  readFileSync(new URL('docs/agent-parity.md', root), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      return [cells[0].replaceAll('`', ''), { opencode: cells[1], claude: cells[2], status: cells[3], reason: cells[4] }] as const;
    }),
);

describe('parity', () => {
  test('SESSION_ENGINE_INFO declares the same engines and capabilities as /api/engines', () => {
    expect(Object.keys(SESSION_ENGINE_INFO).sort()).toEqual(Object.keys(serverEngines).sort());
    for (const [id, client] of Object.entries(SESSION_ENGINE_INFO)) {
      const server = serverEngines[id];
      expect(client.label).toBe(server.label);
      expect(client.capabilities).toEqual(server.capabilities);
    }
  });

  test('the matrix has one row per capability and every GAP is justified', () => {
    const capabilities = Object.entries(serverEngines.claude.capabilities);
    expect([...matrix.keys()].sort()).toEqual(capabilities.map(([feature]) => feature).sort());
    for (const [feature, claude] of capabilities) {
      const row = matrix.get(feature);
      expect(row?.status).toBe(claude === false ? 'GAP' : 'OK');
      if (claude === false) expect(/^Motivo: \S|https:\/\/\S+/.test(row?.reason ?? '')).toBe(true);
    }
  });

  test('no Codex engine: only OpenCode and Claude implement the provider seam', () => {
    expect(Object.keys(SESSION_ENGINE_INFO).sort()).toEqual(['claude', 'opencode']);
  });
});
