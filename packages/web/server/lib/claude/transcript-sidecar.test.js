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

  it('reads the CLI\'s own summary: the last ai-title entry wins', async () => {
    const dir = `${PROJECTS}/-repo`;
    const files = {
      [`${dir}/s3.jsonl`]: [
        line({ type: 'user', message: { content: 'hi' } }),
        line({ type: 'ai-title', aiTitle: 'First guess', sessionId: 's3' }),
        line({ type: 'custom-title', customTitle: 'OpenChamber · repo', sessionId: 's3' }),
        '{broken "ai-title"',
        line({ type: 'ai-title', aiTitle: '  Debug image issue  ', sessionId: 's3' }),
        line({ type: 'ai-title', aiTitle: '   ', sessionId: 's3' }),
      ].join('\n'),
    };
    const sidecar = createTranscriptSidecar({ fsPromises: makeFs(files), path, configDir: CONFIG });
    expect(await sidecar.readAiTitle('s3', '/repo')).toBe('Debug image issue');
    expect(await sidecar.readAiTitle('missing', '/repo')).toBe('');
  });

  it('unearths the real custom title a generated VS Code name buried', async () => {
    const dir = `${PROJECTS}/-repo`;
    const titles = (names) => [
      ...names.map((customTitle) => line({ type: 'custom-title', customTitle, sessionId: 's4' })),
    ].join('\n');
    const build = (names) => createTranscriptSidecar({
      fsPromises: makeFs({ [`${dir}/s4.jsonl`]: titles(names) }),
      path,
      configDir: CONFIG,
    });
    // Stamp over a real title: the real one, closest to the stamp.
    expect(await build(['iOS: no salen los nombres', 'ubuntu-bright-duckling', 'ubuntu-bright-duckling'])
      .readRealCustomTitle('s4', '/repo')).toBe('iOS: no salen los nombres');
    // Newest title is real: nothing to unearth.
    expect(await build(['ubuntu-bright-duckling', 'Fix auth flow']).readRealCustomTitle('s4', '/repo')).toBe('');
    // Only stamps (and the old placeholder): nothing real to restore.
    expect(await build(['OpenChamber · repo', 'ubuntu-bright-duckling']).readRealCustomTitle('s4', '/repo')).toBe('');
    expect(await build([]).readRealCustomTitle('s4', '/repo')).toBe('');
  });

  it('reads the first prompt past meta records, tags and a pasted image', async () => {
    const dir = `${PROJECTS}/-repo`;
    const user = (content, extra = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra });
    const sidecar = createTranscriptSidecar({
      fsPromises: makeFs({
        [`${dir}/s5.jsonl`]: [
          line({ type: 'bridge-session', sessionId: 's5' }),
          user('This session is being continued…', { isCompactSummary: true }),
          user([{ type: 'text', text: '<ide_selection>x</ide_selection>' }], { isMeta: true }),
          user([
            { type: 'image', source: { type: 'base64', data: 'A'.repeat(4096) } },
            { type: 'text', text: '<ide_opened_file>app.py</ide_opened_file>' },
            { type: 'text', text: 'porque hay 2 precios?' },
          ]),
          user('segundo prompt'),
        ].join('\n'),
        [`${dir}/s6.jsonl`]: user([{ type: 'tool_result', tool_use_id: 't', content: 'ok' }]),
      }),
      path,
      configDir: CONFIG,
    });
    expect(await sidecar.readFirstPrompt('s5', '/repo')).toBe('porque hay 2 precios?');
    expect(await sidecar.readFirstPrompt('s6', '/repo')).toBe('');
    expect(await sidecar.readFirstPrompt('missing', '/repo')).toBe('');
  });
});
