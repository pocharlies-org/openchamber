import { describe, expect, test } from 'bun:test';

import { isTodoTool, latestTodos, todoProgress, todosFromWrite } from './claudeTodos';

const write = (todos: unknown[]) => ({ type: 'tool', tool: 'todowrite', state: { status: 'completed', input: { todos } } });
const create = (id: string, subject: string) => ({
  type: 'tool', tool: 'TaskCreate', state: { status: 'completed', input: { subject, activeForm: `${subject}ing` }, metadata: { task: { id, subject } } },
});
const update = (taskId: string, patch: Record<string, unknown>) => ({ type: 'tool', tool: 'TaskUpdate', state: { status: 'completed', input: { taskId, ...patch } } });

describe('claude to-dos', () => {
  test('a TodoWrite list reads as the checklist', () => {
    expect(todosFromWrite({ todos: [
      { content: 'Read', status: 'completed', activeForm: 'Reading' },
      { content: 'Edit', status: 'in_progress', activeForm: 'Editing' },
      { content: 'Test', status: 'weird' },
      { content: '' },
      'nope',
    ] })).toEqual([
      { id: '0', content: 'Read', status: 'completed', activeForm: 'Reading' },
      { id: '1', content: 'Edit', status: 'in_progress', activeForm: 'Editing' },
      { id: '2', content: 'Test', status: 'pending' },
    ]);
    expect(todosFromWrite(null)).toEqual([]);
  });

  test('the latest TodoWrite replaces the list; task tools edit it', () => {
    expect(latestTodos([])).toBeNull();
    const items = latestTodos([
      write([{ content: 'old', status: 'pending' }]),
      write([{ content: 'A', status: 'completed' }]),
      create('7', 'B'),
      create('8', 'C'),
      update('7', { status: 'in_progress' }),
      update('8', { status: 'deleted' }),
      update('99', { status: 'completed' }),
      { type: 'text' },
    ]);
    expect(items).toEqual([
      { id: '0', content: 'A', status: 'completed' },
      { id: '7', content: 'B', status: 'in_progress', activeForm: 'Bing' },
    ]);
    expect(todoProgress(items ?? [])).toEqual({ done: 1, total: 2, current: items?.[1] ?? null });
  });

  test('a TaskCreate without the id Claude Code gave it is skipped', () => {
    expect(latestTodos([{ type: 'tool', tool: 'TaskCreate', state: { input: { subject: 'x' } } }])).toBeNull();
  });

  test('knows the tools that write the list', () => {
    expect(isTodoTool('todowrite')).toBe(true);
    expect(isTodoTool('TaskUpdate')).toBe(true);
    expect(isTodoTool('shell')).toBe(false);
    expect(isTodoTool(undefined)).toBe(false);
  });
});
