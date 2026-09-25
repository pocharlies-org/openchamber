import { describe, expect, test } from 'bun:test';
import type { Session } from '@/lib/opencode/model';
import { getClaudeLiveState } from './claudeSessionMetadata';

const session = (metadata: Record<string, object>): Session => ({
  id: 'ses_ccc1',
  slug: 'claude-1',
  projectID: 'p',
  directory: '/repo',
  title: 't',
  version: '1',
  time: { created: 1, updated: 1 },
  metadata,
} as unknown as Session);

describe('getClaudeLiveState', () => {
  test('reads a session open in VS Code and working', () => {
    const state = getClaudeLiveState(session({
      liveElsewhere: { entrypoint: 'claude-vscode', name: 'k8s-93', status: 'busy', pid: 1, attachable: true },
      remoteControl: { url: 'https://claude.ai/code/session_01' },
    }));
    expect(state).toEqual({
      liveElsewhere: { kind: 'vscode', name: 'k8s-93', busy: true, attachable: true },
      remoteControlUrl: 'https://claude.ai/code/session_01',
    });
  });

  test('an unknown launcher is "another app", not a guess', () => {
    const state = getClaudeLiveState(session({ liveElsewhere: { entrypoint: 'sdk-cli', status: 'idle' } }));
    expect(state.liveElsewhere).toEqual({ kind: 'other', name: '', busy: false, attachable: false });
  });

  test('never renders a link that is not claude.ai', () => {
    const state = getClaudeLiveState(session({ remoteControl: { url: 'https://evil.example/code' } }));
    expect(state.remoteControlUrl).toBeNull();
  });

  test('a session without live metadata is free and unlinked', () => {
    expect(getClaudeLiveState(session({}))).toEqual({ liveElsewhere: null, remoteControlUrl: null });
    expect(getClaudeLiveState(null)).toEqual({ liveElsewhere: null, remoteControlUrl: null });
  });
});
