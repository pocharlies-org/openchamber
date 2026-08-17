import { describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { MESSAGE_ACTIVITY_STALE_MS } from '@/sync/streaming';
import { isIncompleteAssistantWorking } from './useSessionActivity';

const NOW = 200_000;

const assistant = ({
  created = NOW,
  completed,
  error,
}: {
  created?: number;
  completed?: number;
  error?: { name: 'MessageAbortedError'; data: { message: string } };
} = {}): Message => ({
  id: 'msg_assistant',
  sessionID: 'ses_1',
  role: 'assistant',
  time: { created, ...(completed === undefined ? {} : { completed }) },
  ...(error === undefined ? {} : { error }),
} as Message);

describe('isIncompleteAssistantWorking', () => {
  test('treats an incomplete assistant with an error as settled', () => {
    expect(isIncompleteAssistantWorking(assistant({
      error: { name: 'MessageAbortedError', data: { message: 'Interrupted' } },
    }), NOW)).toBe(false);
  });

  test('keeps a recent incomplete assistant active', () => {
    expect(isIncompleteAssistantWorking(assistant({ created: NOW - 10_000 }), NOW)).toBe(true);
  });

  test('settles an incomplete assistant after 90 seconds without updates', () => {
    expect(isIncompleteAssistantWorking(
      assistant({ created: NOW - MESSAGE_ACTIVITY_STALE_MS - 1 }),
      NOW,
    )).toBe(false);
  });

  test('uses a recent streaming heartbeat over the original message time', () => {
    expect(isIncompleteAssistantWorking(
      assistant({ created: NOW - MESSAGE_ACTIVITY_STALE_MS - 1 }),
      NOW,
      NOW - 1_000,
    )).toBe(true);
  });

  test('does not classify completed or user messages as active fallback work', () => {
    expect(isIncompleteAssistantWorking(assistant({ completed: NOW - 1 }), NOW)).toBe(false);
    expect(isIncompleteAssistantWorking({ role: 'user' } as Message, NOW)).toBe(false);
  });
});
