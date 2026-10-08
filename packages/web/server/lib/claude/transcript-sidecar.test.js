import fs from 'fs';
import os from 'os';
import { Readable } from 'stream';
import { describe, expect, it } from 'vitest';
import path from 'path';

import { createTranscriptSidecar, projectSlug } from './transcript-sidecar.js';

const CONFIG = '/home/test/.claude';
const PROJECTS = `${CONFIG}/projects`;
const CHUNK = 64 * 1024;

/**
 * An in-memory `fs.promises`. `open()` hands back a lazy read stream of 64 KiB
 * byte chunks, as a real file does, so a chunk can cut a line or a multibyte
 * character in two; every stream it opens is kept in `streams` (what was
 * pushed, whether it was destroyed). `forbidTranscriptReadFile` makes
 * `readFile` throw on a `.jsonl`, so a reader that loads the whole transcript
 * fails the test; `failAfter` (file → bytes) breaks that file's stream midway.
 */
const makeFs = (files, { forbidTranscriptReadFile = false, failAfter = {} } = {}) => {
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const has = (target) => Object.prototype.hasOwnProperty.call(files, target);
  const streams = [];
  return {
    streams,
    access: async (target) => {
      if (!has(target)) throw missing();
    },
    readFile: async (target) => {
      if (!has(target)) throw missing();
      if (forbidTranscriptReadFile && target.endsWith('.jsonl')) throw new Error(`readFile on a transcript: ${target}`);
      return files[target];
    },
    open: async (target) => {
      if (!has(target)) throw missing();
      const bytes = Buffer.from(files[target]);
      const record = { file: target, pushed: 0, stream: null };
      record.stream = new Readable({
        read() {
          if (failAfter[target] !== undefined && record.pushed >= failAfter[target]) {
            this.destroy(Object.assign(new Error('EIO'), { code: 'EIO' }));
          } else if (record.pushed >= bytes.length) {
            this.push(null);
          } else {
            const chunk = bytes.subarray(record.pushed, record.pushed + CHUNK);
            record.pushed += chunk.length;
            this.push(chunk);
          }
        },
      });
      streams.push(record);
      return { createReadStream: () => record.stream, close: async () => {} };
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

describe('transcript sidecar reads by lines', () => {
  const DIR = `${PROJECTS}/-repo`;
  const FILE = `${DIR}/big.jsonl`;
  const user = (content, extra = {}) => line({ type: 'user', message: { role: 'user', content }, ...extra });
  const aiTitle = (aiTitle) => line({ type: 'ai-title', aiTitle, sessionId: 'big' });
  const customTitle = (customTitle) => line({ type: 'custom-title', customTitle, sessionId: 'big' });
  const toolResult = (id, result) => line({ type: 'user', toolUseResult: result, message: { content: [{ type: 'tool_result', tool_use_id: id }] } });
  const FILLER = line({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(180) }] } });
  const filler = (count) => Array.from({ length: count }, () => FILLER);
  // A transcript a few MB long, as the ones that took the server down are.
  const BIG_LINES = 50_000;
  const MB = 1024 * 1024;

  const over = (content, options) => {
    const fsPromises = makeFs({ [FILE]: content }, options);
    return { fsPromises, sidecar: createTranscriptSidecar({ fsPromises, path, configDir: CONFIG }) };
  };

  it('stops at the first real prompt instead of reading the file', async () => {
    const content = [
      line({ type: 'bridge-session', sessionId: 'big' }),
      user('meta', { isMeta: true }),
      user('el primer prompt de verdad'),
      ...filler(BIG_LINES),
    ].join('\n');
    expect(Buffer.byteLength(content)).toBeGreaterThan(10 * MB);
    const { fsPromises, sidecar } = over(content, { forbidTranscriptReadFile: true });

    expect(await sidecar.readFirstPrompt('big', '/repo')).toBe('el primer prompt de verdad');
    expect(fsPromises.streams).toHaveLength(1);
    const [opened] = fsPromises.streams;
    expect(opened.pushed).toBeLessThan(MB);
    expect(opened.stream.destroyed).toBe(true);
  });

  it('reads the last ai-title, the real custom title and the tool results past 50,000 lines', async () => {
    const content = [
      aiTitle('Primero'),
      customTitle('Titulo real'),
      toolResult('toolu_first', { stdout: 'a' }),
      ...filler(BIG_LINES),
      aiTitle('Ultimo'),
      customTitle('ubuntu-bright-duckling'),
      toolResult('toolu_last', { stdout: 'b' }),
    ].join('\n');
    expect(Buffer.byteLength(content)).toBeGreaterThan(10 * MB);
    const { fsPromises, sidecar } = over(content, { forbidTranscriptReadFile: true });

    expect(await sidecar.readAiTitle('big', '/repo')).toBe('Ultimo');
    expect(await sidecar.readRealCustomTitle('big', '/repo')).toBe('Titulo real');
    const { toolResults } = await sidecar.read('big', '/repo');
    expect([...toolResults.keys()]).toEqual(['toolu_first', 'toolu_last']);
    // Each reader went through the file once, and let go of it.
    expect(fsPromises.streams).toHaveLength(3);
    for (const opened of fsPromises.streams) {
      expect(opened.stream.destroyed).toBe(true);
    }
  });

  it('reads a last line with no trailing newline', async () => {
    const { sidecar } = over([aiTitle('Primero'), user('hola'), aiTitle('Sin salto final')].join('\n'));
    expect(await sidecar.readAiTitle('big', '/repo')).toBe('Sin salto final');

    const prompt = over([line({ type: 'bridge-session' }), user('prompt sin salto final')].join('\n'));
    expect(await prompt.sidecar.readFirstPrompt('big', '/repo')).toBe('prompt sin salto final');

    const results = over([user('hi'), toolResult('toolu_end', { stdout: 'z' })].join('\n'));
    expect([...(await results.sidecar.read('big', '/repo')).toolResults.keys()]).toEqual(['toolu_end']);
  });

  it('ignores a broken line that mentions the key it looks for', async () => {
    const { sidecar } = over([
      '{not json "toolUseResult"',
      toolResult('toolu_ok', { stdout: 'ok' }),
      '{broken "ai-title"',
      aiTitle('Valido'),
      '{broken "custom-title"',
      '{broken "type":"user"',
    ].join('\n'));
    expect([...(await sidecar.read('big', '/repo')).toolResults.keys()]).toEqual(['toolu_ok']);
    expect(await sidecar.readAiTitle('big', '/repo')).toBe('Valido');
    expect(await sidecar.readRealCustomTitle('big', '/repo')).toBe('');
    expect(await sidecar.readFirstPrompt('big', '/repo')).toBe('');
  });

  it('answers empty when the file is gone by the time it is opened', async () => {
    const files = { [FILE]: aiTitle('x') };
    const vanished = {
      ...makeFs(files),
      open: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
    };
    const sidecar = createTranscriptSidecar({ fsPromises: vanished, path, configDir: CONFIG });
    expect(await sidecar.readAiTitle('big', '/repo')).toBe('');
    expect(await sidecar.readRealCustomTitle('big', '/repo')).toBe('');
    expect(await sidecar.readFirstPrompt('big', '/repo')).toBe('');
    expect((await sidecar.read('big', '/repo')).toolResults.size).toBe(0);
  });

  it('reads past a line of several MB (a pasted image) to the first prompt', async () => {
    const content = [
      user([{ type: 'image', source: { type: 'base64', data: 'A'.repeat(5 * MB) } }], { isMeta: true }),
      user([
        { type: 'image', source: { type: 'base64', data: 'B'.repeat(5 * MB) } },
        { type: 'text', text: 'que pasa con esta imagen?' },
      ]),
      aiTitle('Imagen'),
    ].join('\n');
    const { fsPromises, sidecar } = over(content, { forbidTranscriptReadFile: true });
    expect(await sidecar.readFirstPrompt('big', '/repo')).toBe('que pasa con esta imagen?');
    expect(await sidecar.readAiTitle('big', '/repo')).toBe('Imagen');
    expect(fsPromises.streams.every((opened) => opened.stream.destroyed)).toBe(true);
  });

  it('puts a line and a multibyte character back together across chunks', async () => {
    // The first line's length decides where the 64 KiB boundary falls: with
    // one byte more or less, at least one of the two files has a multibyte
    // character cut between its first and second chunk.
    const boundaries = [];
    for (const padding of ['', 'x']) {
      const text = 'ñ😀'.repeat(40_000);
      const content = [line({ type: 'bridge-session', note: padding }), user(text), aiTitle('ñandú 😀')].join('\n');
      boundaries.push((Buffer.from(content)[CHUNK] & 0xc0) === 0x80 ? 'cut' : 'whole');
      const { sidecar } = over(content);
      expect(await sidecar.readFirstPrompt('big', '/repo')).toBe(text);
      expect(await sidecar.readAiTitle('big', '/repo')).toBe('ñandú 😀');
    }
    expect(boundaries).toContain('cut');
  });

  it('reads CRLF files and an empty file', async () => {
    const { sidecar } = over([user('hola'), aiTitle('Con CRLF'), toolResult('toolu_crlf', { stdout: 'c' })].join('\r\n') + '\r\n');
    expect(await sidecar.readFirstPrompt('big', '/repo')).toBe('hola');
    expect(await sidecar.readAiTitle('big', '/repo')).toBe('Con CRLF');
    expect([...(await sidecar.read('big', '/repo')).toolResults.keys()]).toEqual(['toolu_crlf']);

    const empty = over('');
    expect(await empty.sidecar.readFirstPrompt('big', '/repo')).toBe('');
    expect(await empty.sidecar.readAiTitle('big', '/repo')).toBe('');
    expect(await empty.sidecar.readRealCustomTitle('big', '/repo')).toBe('');
    expect((await empty.sidecar.read('big', '/repo')).toolResults.size).toBe(0);
  });

  it('answers empty, and does not hang, when the stream fails midway', async () => {
    const content = [
      toolResult('toolu_early', { stdout: 'e' }),
      ...filler(2_000),
      aiTitle('Tarde'),
      user('prompt tarde'),
    ].join('\n');
    expect(Buffer.byteLength(content)).toBeGreaterThan(3 * CHUNK);
    const { fsPromises, sidecar } = over(content, { failAfter: { [FILE]: 2 * CHUNK } });

    expect(await sidecar.readAiTitle('big', '/repo')).toBe('');
    expect(await sidecar.readRealCustomTitle('big', '/repo')).toBe('');
    expect(await sidecar.readFirstPrompt('big', '/repo')).toBe('');
    expect((await sidecar.read('big', '/repo')).toolResults.size).toBe(0);
    expect(fsPromises.streams.every((opened) => opened.stream.destroyed)).toBe(true);
  });

  it('reads a real file by lines and leaves no descriptor open', async () => {
    const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-sidecar-'));
    try {
      const dir = path.join(configDir, 'projects', projectSlug('/repo'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'real.jsonl'), [user('hola real'), aiTitle('Titulo real'), ...filler(3_000)].join('\n'));
      const sidecar = createTranscriptSidecar({ configDir });
      const openDescriptors = () => (fs.existsSync('/proc/self/fd') ? fs.readdirSync('/proc/self/fd').length : 0);
      const before = openDescriptors();

      expect(await sidecar.readFirstPrompt('real', '/repo')).toBe('hola real');
      expect(await sidecar.readAiTitle('real', '/repo')).toBe('Titulo real');
      for (let i = 0; i < 50 && openDescriptors() !== before; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(openDescriptors()).toBe(before);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});
