import { describe, expect, it } from 'vitest';
import path from 'path';
import { Readable } from 'node:stream';

import { createTranscriptSidecar, projectSlug } from './transcript-sidecar.js';

const CONFIG = '/home/test/.claude';
const PROJECTS = `${CONFIG}/projects`;

const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
const has = (files, target) => Object.prototype.hasOwnProperty.call(files, target);

// The transcripts are read as streams: reading a .jsonl whole is a failure.
const makeFs = (files) => ({
  access: async (target) => {
    if (!has(files, target)) throw missing();
  },
  readFile: async (target) => {
    if (target.endsWith('.jsonl')) throw new Error(`readFile on a transcript: ${target}`);
    if (!has(files, target)) throw missing();
    return files[target];
  },
  readdir: async (target) => {
    const prefix = `${target}/`;
    const names = new Set(Object.keys(files).filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length).split('/')[0]));
    if (names.size === 0) throw missing();
    return [...names];
  },
});

function* chunked(text, size) {
  for (let at = 0; at < text.length; at += size) yield text.slice(at, at + size);
}

const failing = (error) => new Readable({ read() { this.destroy(error); } });

/**
 * A sidecar over `files` whose transcripts come back as streams of small
 * chunks (lines split across them). `source(target)` replaces the stream of
 * one file; `opened` keeps every stream handed out to see how it ended.
 */
const build = (files, { source, chunkSize = 64 } = {}) => {
  const opened = [];
  const createReadStream = (target) => {
    const stream = source?.(target)
      ?? (has(files, target) ? Readable.from(chunked(files[target], chunkSize)) : failing(missing()));
    opened.push(stream);
    return stream;
  };
  const sidecar = createTranscriptSidecar({ fsPromises: makeFs(files), createReadStream, path, configDir: CONFIG });
  return { sidecar, opened };
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
    const { sidecar } = build(files);

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
    const { sidecar } = build(files);
    expect(await sidecar.locate('../../../etc/secret', '/repo')).toBeNull();
    const read = await sidecar.read('s1', '/repo', { agentId: '../../../../../etc/secret' });
    expect(read.toolResults.size).toBe(0);
    expect(await sidecar.readSubagent('s1', '/repo', '../x')).toBeNull();
  });

  it('finds a transcript outside its directory slug by scanning, and never throws', async () => {
    const files = { [`${PROJECTS}/-somewhere-else/s2.jsonl`]: '' };
    const { sidecar } = build(files);
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
    const { sidecar } = build(files);
    expect(await sidecar.readAiTitle('s3', '/repo')).toBe('Debug image issue');
    expect(await sidecar.readAiTitle('missing', '/repo')).toBe('');
  });

  it('unearths the real custom title a generated VS Code name buried', async () => {
    const dir = `${PROJECTS}/-repo`;
    const titles = (names) => [
      ...names.map((customTitle) => line({ type: 'custom-title', customTitle, sessionId: 's4' })),
    ].join('\n');
    const sidecarOf = (names) => build({ [`${dir}/s4.jsonl`]: titles(names) }).sidecar;
    // Stamp over a real title: the real one, closest to the stamp.
    expect(await sidecarOf(['iOS: no salen los nombres', 'ubuntu-bright-duckling', 'ubuntu-bright-duckling'])
      .readRealCustomTitle('s4', '/repo')).toBe('iOS: no salen los nombres');
    // Newest title is real: nothing to unearth.
    expect(await sidecarOf(['ubuntu-bright-duckling', 'Fix auth flow']).readRealCustomTitle('s4', '/repo')).toBe('');
    // Only stamps (and the old placeholder): nothing real to restore.
    expect(await sidecarOf(['OpenChamber · repo', 'ubuntu-bright-duckling']).readRealCustomTitle('s4', '/repo')).toBe('');
    expect(await sidecarOf([]).readRealCustomTitle('s4', '/repo')).toBe('');
  });

  it('reads the first prompt past meta records, tags and a pasted image', async () => {
    const dir = `${PROJECTS}/-repo`;
    const user = (content, extra = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra });
    const { sidecar } = build({
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
    });
    expect(await sidecar.readFirstPrompt('s5', '/repo')).toBe('porque hay 2 precios?');
    expect(await sidecar.readFirstPrompt('s6', '/repo')).toBe('');
    expect(await sidecar.readFirstPrompt('missing', '/repo')).toBe('');
  });

  it('reads transcripts as streams, never whole, and always closes them', async () => {
    const dir = `${PROJECTS}/-repo`;
    const { sidecar, opened } = build({
      [`${dir}/s7.jsonl`]: [
        line({ type: 'user', message: { role: 'user', content: 'primer prompt' } }),
        line({ type: 'ai-title', aiTitle: 'Titulo' }),
        line({ type: 'custom-title', customTitle: 'Real name' }),
        line({ type: 'custom-title', customTitle: 'ubuntu-bright-duckling' }),
        line({ type: 'user', toolUseResult: { stdout: 'x' }, message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1' }] } }),
      ].join('\n'),
    });
    expect(await sidecar.readAiTitle('s7', '/repo')).toBe('Titulo');
    expect(await sidecar.readRealCustomTitle('s7', '/repo')).toBe('Real name');
    expect(await sidecar.readFirstPrompt('s7', '/repo')).toBe('primer prompt');
    expect((await sidecar.read('s7', '/repo')).toolResults.get('toolu_1')).toEqual({ stdout: 'x' });
    // Read to the end or stopped early, no descriptor is left open.
    expect(opened).toHaveLength(4);
    expect(opened.every((stream) => stream.destroyed)).toBe(true);
  });

  it('stops reading at the first prompt, wherever the file goes on', async () => {
    const dir = `${PROJECTS}/-repo`;
    const first = `${line({ type: 'user', message: { role: 'user', content: 'primer prompt' } })}\n`;
    const filler = `${line({ type: 'assistant', message: { content: 'relleno' } })}\n`;
    const FILLER_LINES = 5000;
    let pulled = 0;
    function* longFile() {
      yield first;
      for (; pulled < FILLER_LINES; pulled += 1) yield filler;
    }
    const { sidecar, opened } = build({ [`${dir}/s8.jsonl`]: first }, { source: () => Readable.from(longFile()) });
    expect(await sidecar.readFirstPrompt('s8', '/repo')).toBe('primer prompt');
    // The stream buffers a few lines ahead of the reader; it does not run to the end.
    expect(pulled).toBeLessThan(FILLER_LINES / 2);
    expect(opened).toHaveLength(1);
    expect(opened[0].destroyed).toBe(true);
  });

  it('resolves titles past a 5 MB line (a pasted image)', async () => {
    const dir = `${PROJECTS}/-repo`;
    const image = line({
      type: 'user',
      message: { role: 'user', content: [
        { type: 'image', source: { type: 'base64', data: 'A'.repeat(5 * 1024 * 1024) } },
        { type: 'text', text: 'que es esto?' },
      ] },
    });
    expect(image.length).toBeGreaterThan(5 * 1024 * 1024);
    const { sidecar } = build({
      [`${dir}/s9.jsonl`]: [image, line({ type: 'ai-title', aiTitle: 'Imagen pegada' })].join('\n'),
    }, { chunkSize: 256 * 1024 });
    expect(await sidecar.readFirstPrompt('s9', '/repo')).toBe('que es esto?');
    expect(await sidecar.readAiTitle('s9', '/repo')).toBe('Imagen pegada');
  });

  it('answers empty, not partial and not by crashing, when the stream fails', async () => {
    const dir = `${PROJECTS}/-repo`;
    const files = { [`${dir}/s10.jsonl`]: '' };
    // The transcript was there for `locate` and is gone when it is opened (rotated).
    const gone = build(files, { source: () => failing(missing()) });
    // It breaks halfway: what was read before the error is not an answer.
    const halfway = build(files, {
      source: () => {
        let sent = false;
        return new Readable({
          encoding: 'utf8',
          read() {
            if (sent) {
              this.destroy(Object.assign(new Error('EIO'), { code: 'EIO' }));
              return;
            }
            sent = true;
            this.push(`${line({ type: 'ai-title', aiTitle: 'Parcial' })}\n${line({ type: 'user', message: { content: 'prompt' } })}\n`);
          },
        });
      },
    });
    for (const { sidecar, opened } of [gone, halfway]) {
      expect(await sidecar.readAiTitle('s10', '/repo')).toBe('');
      expect(await sidecar.readRealCustomTitle('s10', '/repo')).toBe('');
      expect(await sidecar.readFirstPrompt('s10', '/repo')).toBe('');
      expect((await sidecar.read('s10', '/repo')).toolResults.size).toBe(0);
      expect(opened.every((stream) => stream.destroyed)).toBe(true);
    }
  });
});
