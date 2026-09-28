import { describe, expect, it } from 'vitest';
import path from 'path';

import { createTranscriptSidecar, projectSlug } from './transcript-sidecar.js';

const CONFIG = '/home/test/.claude';
const PROJECTS = `${CONFIG}/projects`;

const makeFs = (files) => {
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const has = (target) => Object.prototype.hasOwnProperty.call(files, target);
  return {
    access: async (target) => {
      if (!has(target)) throw missing();
    },
    readFile: async (target) => {
      if (!has(target)) throw missing();
      return files[target];
    },
    readdir: async (target) => {
      const prefix = `${target}/`;
      const names = new Set(Object.keys(files).filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split('/')[0]));
      if (names.size === 0) throw missing();
      return [...names];
    },
  };
};

const line = (value) => JSON.stringify(value);

describe('transcript sidecar', () => {
  it('slugs a directory as Claude Code does', () => {
    expect(projectSlug('/home/me/my.repo')).toBe('-home-me-my-repo');
  });

  it('reads structured tool results and the subagents a session started', async () => {
    const dir = `${PROJECTS}/-repo`;
    const files = {
      [`${dir}/s1.jsonl`]: [
        line({ type: 'user', message: { content: 'hi' } }),
        line({ type: 'user', toolUseResult: { structuredPatch: [{ lines: ['+a'] }] }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_edit' }] } }),
        line({ type: 'user', toolUseResult: { agentId: 'ag1' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent' }] } }),
        '{not json "toolUseResult"',
      ].join('\n'),
      [`${dir}/s1/subagents/agent-ag1.meta.json`]: JSON.stringify({ agentType: 'Explore', description: 'Find', toolUseId: 'toolu_agent' }),
      [`${dir}/s1/subagents/agent-ag1.jsonl`]: line({ type: 'user', toolUseResult: { stdout: 'x' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_inner' }] } }),
      [`${dir}/s1/subagents/agent-bad.meta.json`]: '{',
    };
    const sidecar = createTranscriptSidecar({ fsPromises: makeFs(files), path, configDir: CONFIG });

    const { toolResults, subagents } = await sidecar.read('s1', '/repo');
    expect(toolResults.get('toolu_edit')).toEqual({ structuredPatch: [{ lines: ['+a'] }] });
    expect(toolResults.get('toolu_agent')).toEqual({ agentId: 'ag1' });
    expect(subagents.get('toolu_agent')).toEqual({ agentId: 'ag1', agentType: 'Explore', description: 'Find' });

    const inner = await sidecar.read('s1', '/repo', { agentId: 'ag1' });
    expect([...inner.toolResults.keys()]).toEqual(['toolu_inner']);

    expect(await sidecar.readSubagent('s1', '/repo', 'ag1')).toEqual({ agentId: 'ag1', agentType: 'Explore', description: 'Find', toolUseId: 'toolu_agent' });
    expect(await sidecar.readSubagent('s1', '/repo', 'nope')).toBeNull();
  });

  it('never joins an id with a separator into a path', async () => {
    const files = { [`${PROJECTS}/-repo/s1.jsonl`]: '', ['/etc/secret.jsonl']: '{"toolUseResult":{"x":1},"message":{"content":[{"type":"tool_result","tool_use_id":"t"}]}}' };
    const sidecar = createTranscriptSidecar({ fsPromises: makeFs(files), path, configDir: CONFIG });
    expect(await sidecar.locate('../../../etc/secret', '/repo')).toBeNull();
    const read = await sidecar.read('s1', '/repo', { agentId: '../../../../../etc/secret' });
    expect(read.toolResults.size).toBe(0);
    expect(await sidecar.readSubagent('s1', '/repo', '../x')).toBeNull();
  });

  it('finds a transcript outside its directory slug by scanning, and never throws', async () => {
    const files = { [`${PROJECTS}/-somewhere-else/s2.jsonl`]: '' };
    const sidecar = createTranscriptSidecar({ fsPromises: makeFs(files), path, configDir: CONFIG });
    expect(await sidecar.locate('s2', '/repo')).toBe(`${PROJECTS}/-somewhere-else/s2.jsonl`);
    expect(await sidecar.locate('missing', '/repo')).toBeNull();
    const empty = await sidecar.read('missing', '/repo');
    expect(empty.toolResults.size).toBe(0);
    expect(empty.subagents.size).toBe(0);
    expect(await sidecar.readSubagent('missing', '/repo', 'a')).toBeNull();
  });
});
