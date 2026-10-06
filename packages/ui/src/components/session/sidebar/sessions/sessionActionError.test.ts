import { describe, expect, test } from 'bun:test';
import { OpencodeApiError } from '@/lib/opencode/client';
import { describeSessionActionError } from './sessionActionError';

const t = ((key: string, params?: Record<string, string | number>) => (
  `${key}${params ? ' ' + Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ') : ''}`
)) as unknown as Parameters<typeof describeSessionActionError>[1];

describe('describeSessionActionError', () => {
  test('quotes the OpenCode status, error class and log ref when the server sent one', () => {
    const error = new OpencodeApiError('session.update', 'Unexpected server error. Check server logs for details.', {
      status: 500,
      tag: 'UnknownError',
      ref: 'err_07817ddc',
    });

    expect(describeSessionActionError(error, t)).toBe(
      'sessions.sidebar.session.action.upstreamErrorWithRef status=500 name=UnknownError ref=err_07817ddc',
    );
  });

  test('falls back to the upstream message without a ref, and to the plain error otherwise', () => {
    const noRef = new OpencodeApiError('session.update', 'Session not found', { status: 404, tag: 'SessionNotFoundError' });
    expect(describeSessionActionError(noRef, t)).toBe('sessions.sidebar.session.action.upstreamError engine=OpenCode status=404 message=Session not found');
    expect(describeSessionActionError(new Error('offline'), t)).toBe('offline');
  });

  test('names the engine that owns the session: a Claude session never reads "OpenCode answered"', () => {
    const failure = new OpencodeApiError('session.update', 'Failed to update', { status: 500, tag: 'UnknownError' });
    expect(describeSessionActionError(failure, t, 'claude')).toBe('sessions.sidebar.session.action.upstreamError engine=Claude Code status=500 message=Failed to update');
  });

  test('says an operation the engine does not have is not available, naming the engine that refused', () => {
    const refused = new OpencodeApiError('session.fork', 'Claude Code sessions do not support revert', {
      status: 400,
      tag: 'UnsupportedOperationError',
      unsupported: { engine: 'claude', operation: 'revert' },
    });
    expect(describeSessionActionError(refused, t)).toBe('sessions.sidebar.session.action.unsupported engine=Claude Code');
  });
});
