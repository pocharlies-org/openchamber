import { describe, expect, test } from 'bun:test';
import type { Message } from '@/lib/opencode/model';
import { MESSAGE_ACTIVITY_STALE_MS } from '@/sync/streaming';
import { isIncompleteAssistantWorking } from './useSessionActivity';

const NOW = 200_000;

const assistant = ({
  created = NOW,
  streamed,
  completed,
  error,
}: {
  created?: number;
  streamed?: number;
  completed?: number;
  error?: { type: string; message: string };
} = {}): Message => ({
  id: 'msg_assistant',
  sessionID: 'ses_1',
  role: 'assistant',
  time: {
    created,
    ...(streamed === undefined ? {} : { streamed }),
    ...(completed === undefined ? {} : { completed }),
  },
  ...(error === undefined ? {} : { error }),
} as Message);

describe('isIncompleteAssistantWorking', () => {
  test('treats an incomplete assistant with an error as settled', () => {
    expect(isIncompleteAssistantWorking(assistant({ error: { type: 'APIError', message: 'Interrupted' } }), NOW)).toBe(false);
  });

  test('keeps a recent incomplete assistant active', () => {
    expect(isIncompleteAssistantWorking(assistant({ created: NOW - 10_000 }), NOW)).toBe(true);
  });

  test('settles an orphaned incomplete assistant after 90 seconds without events', () => {
    expect(isIncompleteAssistantWorking(assistant({ created: NOW - MESSAGE_ACTIVITY_STALE_MS - 1 }), NOW)).toBe(false);
  });

  test('uses a recent event for the message over the original message time', () => {
    expect(isIncompleteAssistantWorking(
      assistant({ created: NOW - MESSAGE_ACTIVITY_STALE_MS - 1 }),
      NOW,
      NOW - 1_000,
    )).toBe(true);
  });

  test('counts the first streamed token as activity', () => {
    expect(isIncompleteAssistantWorking(
      assistant({ created: NOW - MESSAGE_ACTIVITY_STALE_MS - 50_000, streamed: NOW - 5_000 }),
      NOW,
    )).toBe(true);
  });

  test('does not classify completed or user messages as active fallback work', () => {
    expect(isIncompleteAssistantWorking(assistant({ completed: NOW - 1 }), NOW)).toBe(false);
    expect(isIncompleteAssistantWorking({ id: 'u', sessionID: 's', role: 'user', time: { created: NOW } } as Message, NOW)).toBe(false);
    expect(isIncompleteAssistantWorking(undefined, NOW)).toBe(false);
  });
});
