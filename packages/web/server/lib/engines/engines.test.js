import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { ENGINES, ENGINE_OPERATIONS, operationOfPath, registerEnginesRoute, sendUnsupportedOperation } from './engines.js';

describe('engine declarations', () => {
  it('declares every operation for every engine, as a boolean', () => {
    for (const engine of Object.values(ENGINES)) {
      for (const operation of ENGINE_OPERATIONS) {
        expect(typeof engine.capabilities[operation]).toBe('boolean');
      }
    }
  });

  it('OpenCode can do everything; Claude Code declares what it cannot', () => {
    expect(ENGINE_OPERATIONS.every((operation) => ENGINES.opencode.capabilities[operation])).toBe(true);
    const claude = ENGINES.claude.capabilities;
    expect(claude).toMatchObject({ prompt: true, fork: true, forkAtMessage: true, compact: true, metadata: true, shell: false, revert: false, move: false, goals: false });
    expect(claude).toMatchObject({ models: 'catalog', agents: 'modes', commands: 'prompt' });
  });
});

describe('parity', () => {
  const rows = readFileSync(new URL('../../../../../docs/agent-parity.md', import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('| `'))
    .map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
  const byFeature = new Map(rows.map(([feature, , , status, reason]) => [feature.replaceAll('`', ''), { status, reason }]));

  it('every Claude capability that is false has a GAP row with a reason or a linked issue', () => {
    for (const [feature, value] of Object.entries(ENGINES.claude.capabilities)) {
      const row = byFeature.get(feature);
      expect(row, feature).toBeDefined();
      expect(row.status, feature).toBe(value === false ? 'GAP' : 'OK');
      if (value === false) expect(row.reason, feature).toMatch(/^Motivo: \S|https:\/\/\S+/);
    }
  });

  it('declares only the engines that have an implementation', () => {
    expect(Object.keys(ENGINES)).toEqual(['opencode', 'claude']);
  });
});

describe('operationOfPath', () => {
  it.each([
    ['shell', 'shell'],
    ['revert/stage', 'revert'],
    ['/revert/commit', 'revert'],
    ['permission/req_1', 'permissions'],
    ['form/f1', 'forms'],
    ['command', 'commands'],
    ['', 'unknown'],
  ])('%s → %s', (rest, operation) => {
    expect(operationOfPath(rest)).toBe(operation);
  });
});

describe('GET /api/engines', () => {
  const appWith = (options) => {
    const app = express();
    registerEnginesRoute(app, options);
    app.get('/api/unsupported', (_req, res) => sendUnsupportedOperation(res, 'claude', 'shell'));
    return app;
  };

  it('reports Claude available only when it is enabled and its backend loaded', async () => {
    const on = await request(appWith({ isClaudeEnabled: () => true, isClaudeAvailable: async () => true })).get('/api/engines');
    expect(on.body.engines.map((engine) => [engine.id, engine.available])).toEqual([['opencode', true], ['claude', true]]);

    const noSdk = await request(appWith({ isClaudeEnabled: () => true, isClaudeAvailable: async () => false })).get('/api/engines');
    expect(noSdk.body.engines[1].available).toBe(false);

    const off = await request(appWith({ isClaudeEnabled: () => false, isClaudeAvailable: async () => true })).get('/api/engines');
    expect(off.body.engines[1].available).toBe(false);

    const broken = await request(appWith({ isClaudeEnabled: () => true, isClaudeAvailable: async () => { throw new Error('boom'); } })).get('/api/engines');
    expect(broken.status).toBe(200);
    expect(broken.body.engines[1].available).toBe(false);
  });

  it('carries each engine\'s capabilities', async () => {
    const response = await request(appWith({})).get('/api/engines');
    expect(response.body.engines[1].capabilities.shell).toBe(false);
    expect(response.body.engines[0].capabilities.shell).toBe(true);
  });

  it('refuses with a 400 every SDK method declares, tagged and naming the engine', async () => {
    const response = await request(appWith({})).get('/api/unsupported');
    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      _tag: 'UnsupportedOperationError',
      message: 'Claude Code sessions do not support shell',
      engine: 'claude',
      operation: 'shell',
    });
  });
});
