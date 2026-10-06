/**
 * Claude Code's to-do list, as the VS Code extension keeps it visible.
 *
 * Claude Code writes it two ways: `TodoWrite` replaces the whole list each
 * call (`input.todos`), and the newer task tools build it one entry at a time
 * (`TaskCreate` adds — its id is in the result, `metadata.task` here —
 * `TaskUpdate` changes one by `taskId`). The latest list is what the session's
 * calls add up to. Inputs are the model's free-form JSON: each is parsed here,
 * and a malformed entry is dropped rather than failing the list.
 */

import { z } from 'zod';

export type TodoStatus = 'pending' | 'in_progress' | 'completed';

export type TodoItem = {
  id: string;
  content: string;
  status: TodoStatus;
  /** What the item reads as while in progress ("Running the tests"). */
  activeForm?: string;
};

const text = z.string().catch('');
const status = z.enum(['pending', 'in_progress', 'completed']);
const idText = z.union([z.string(), z.number().transform(String)]).catch('');

const todoWriteSchema = z.object({
  todos: z.array(z.object({
    id: idText.optional(),
    content: text,
    status: status.catch('pending'),
    activeForm: text.optional(),
  }).nullable().catch(null)).catch([]),
}).catch({ todos: [] });

const taskCreateSchema = z.object({ subject: text, activeForm: text.optional() }).catch({ subject: '' });
const taskMetadataSchema = z.object({ task: z.object({ id: idText, subject: text.optional() }).nullable().catch(null) }).catch({ task: null });
const taskUpdateSchema = z.object({
  taskId: idText,
  status: z.union([status, z.literal('deleted')]).optional().catch(undefined),
  subject: text.optional(),
  activeForm: text.optional(),
}).catch({ taskId: '' });

/** The part of a tool call this module reads. */
type TodoToolCall = {
  type?: string;
  tool?: string;
  state?: { input?: unknown; metadata?: unknown };
};

const toolName = (part: TodoToolCall): string => (part.tool ?? '').trim().toLowerCase();

/** Whether a tool call writes the to-do list. */
export const isTodoTool = (name: string | undefined): boolean => {
  const tool = (name ?? '').trim().toLowerCase();
  return tool === 'todowrite' || tool === 'taskcreate' || tool === 'taskupdate';
};

const withActiveForm = (item: TodoItem, activeForm: string | undefined): TodoItem => {
  if (!activeForm) return item;
  return { ...item, activeForm };
};

/** A `TodoWrite` call's list. */
export const todosFromWrite = (input: NonNullable<TodoToolCall['state']>['input']): TodoItem[] => {
  const items: TodoItem[] = [];
  todoWriteSchema.parse(input ?? {}).todos.forEach((todo, index) => {
    if (!todo || !todo.content) return;
    items.push(withActiveForm({ id: todo.id || String(index), content: todo.content, status: todo.status }, todo.activeForm));
  });
  return items;
};

/**
 * The list the session's calls add up to, oldest call first; null when the
 * session never wrote one. A `TodoWrite` resets it; task tools edit it.
 */
export const latestTodos = (parts: readonly TodoToolCall[]): TodoItem[] | null => {
  let items: TodoItem[] | null = null;
  for (const part of parts) {
    if (part.type !== 'tool' || !part.state) continue;
    const name = toolName(part);
    if (name === 'todowrite') {
      items = todosFromWrite(part.state.input);
      continue;
    }
    if (name === 'taskcreate') {
      const task = taskMetadataSchema.parse(part.state.metadata ?? {}).task;
      if (!task?.id) continue;
      const input = taskCreateSchema.parse(part.state.input ?? {});
      const created = withActiveForm({ id: task.id, content: input.subject || task.subject || '', status: 'pending' }, input.activeForm);
      items = [...(items ?? []).filter((item) => item.id !== task.id), created];
      continue;
    }
    if (name === 'taskupdate' && items) {
      const update = taskUpdateSchema.parse(part.state.input ?? {});
      if (!update.taskId) continue;
      if (update.status === 'deleted') {
        items = items.filter((item) => item.id !== update.taskId);
        continue;
      }
      const nextStatus: TodoStatus | undefined = update.status;
      items = items.map((item) => {
        if (item.id !== update.taskId) return item;
        const next: TodoItem = { ...item, content: update.subject || item.content };
        if (nextStatus) next.status = nextStatus;
        return withActiveForm(next, update.activeForm);
      });
    }
  }
  return items;
};

/** `done` of `total`, and the item in progress. */
export const todoProgress = (items: readonly TodoItem[]) => ({
  done: items.filter((item) => item.status === 'completed').length,
  total: items.length,
  current: items.find((item) => item.status === 'in_progress') ?? null,
});
