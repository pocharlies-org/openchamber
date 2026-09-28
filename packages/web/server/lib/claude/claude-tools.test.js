import { describe, expect, it } from 'vitest';

import { isSubagentTool, patchFromStrings, patchFromStructured, toV2Tool } from './claude-tools.js';

describe('toV2Tool', () => {
  it('maps Bash to shell with its command and description', () => {
    const v2 = toV2Tool('Bash', { command: 'npm test', description: 'Run the tests', timeout: 1000 });
    expect(v2.tool).toBe('shell');
    expect(v2.input).toEqual({ command: 'npm test', description: 'Run the tests', timeout: 1000 });
    expect(v2.metadata).toBeUndefined();
  });

  it('diffs an Edit from its exact structured hunks when the result is known', () => {
    const v2 = toV2Tool('Edit', { file_path: '/repo/a.js', old_string: 'x', new_string: 'y' }, {
      result: {
        structuredPatch: [{ oldStart: 10, oldLines: 3, newStart: 10, newLines: 3, lines: [' a', '-x', '+y', ' b'] }],
      },
    });
    expect(v2.tool).toBe('edit');
    expect(v2.input).toMatchObject({ filePath: '/repo/a.js', oldString: 'x', newString: 'y', file_path: '/repo/a.js' });
    expect(v2.metadata.files).toEqual([{
      file: '/repo/a.js',
      patch: '--- a//repo/a.js\n+++ b//repo/a.js\n@@ -10,3 +10,3 @@\n a\n-x\n+y\n b',
      additions: 1,
      deletions: 1,
    }]);
    expect(v2.metadata.filediff.patch).toBe(v2.metadata.files[0].patch);
  });

  it('diffs a running Edit from its own strings', () => {
    const v2 = toV2Tool('Edit', { file_path: '/repo/a.js', old_string: 'one\ntwo', new_string: 'three' });
    expect(v2.metadata.files[0]).toMatchObject({ file: '/repo/a.js', additions: 1, deletions: 2 });
    expect(v2.metadata.files[0].patch).toContain('@@ -1,2 +1,1 @@\n-one\n-two\n+three');
  });

  it('joins the edits of a MultiEdit into one diff', () => {
    const v2 = toV2Tool('MultiEdit', {
      file_path: '/repo/a.js',
      edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c', new_string: 'd' }],
    });
    expect(v2.tool).toBe('edit');
    const [file] = v2.metadata.files;
    expect(file).toMatchObject({ additions: 2, deletions: 2 });
    expect(file.patch.match(/^--- a/gm)).toHaveLength(1);
    expect(file.patch.match(/^@@/gm)).toHaveLength(2);
  });

  it('names the file of Write and Read as filePath', () => {
    expect(toV2Tool('Write', { file_path: '/x', content: 'hi' }).input).toMatchObject({ filePath: '/x', content: 'hi' });
    expect(toV2Tool('Read', { file_path: '/y' })).toMatchObject({ tool: 'read', input: { filePath: '/y' } });
  });

  it('turns a subagent call into a subagent part linked to its child session', () => {
    const v2 = toV2Tool('Agent', { subagent_type: 'Explore', description: 'Find it', prompt: 'look' }, {
      childSessionId: 'ses_cccparent~agent1',
    });
    expect(v2.tool).toBe('subagent');
    expect(v2.input).toMatchObject({ agent: 'Explore', description: 'Find it', prompt: 'look' });
    expect(v2.metadata).toEqual({ sessionID: 'ses_cccparent~agent1' });
    expect(toV2Tool('Task', {}).input.agent).toBe('general-purpose');
  });

  it('maps AskUserQuestion to the question tool with `multiple`', () => {
    const v2 = toV2Tool('AskUserQuestion', {
      questions: [{ question: 'Which?', header: 'Pick', multiSelect: true, options: [{ label: 'A', description: 'first', preview: 'x' }] }],
    });
    expect(v2.tool).toBe('question');
    expect(v2.input.questions[0]).toMatchObject({ question: 'Which?', header: 'Pick', multiple: true });
    expect(v2.input.questions[0].options).toEqual([{ label: 'A', description: 'first' }]);
  });

  it('passes unknown and MCP tools through under their own name', () => {
    expect(toV2Tool('mcp__brain__search', { q: 1 })).toEqual({ tool: 'mcp__brain__search', input: { q: 1 }, metadata: undefined });
    expect(toV2Tool('ExitPlanMode', { plan: '# P' })).toMatchObject({ tool: 'plan_exit', input: { plan: '# P' } });
    expect(toV2Tool(undefined, null).tool).toBe('tool');
  });

  it('knows which calls start a subagent', () => {
    expect(isSubagentTool('Agent')).toBe(true);
    expect(isSubagentTool('task')).toBe(true);
    expect(isSubagentTool('Bash')).toBe(false);
  });
});

describe('patch helpers', () => {
  it('return null when there is nothing to diff', () => {
    expect(patchFromStructured('/a', [])).toBeNull();
    expect(patchFromStructured('/a', [{ nope: true }])).toBeNull();
    expect(patchFromStrings('/a', '', '')).toBeNull();
  });
});
