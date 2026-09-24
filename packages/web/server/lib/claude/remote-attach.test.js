import { describe, expect, it, vi } from 'vitest';

import { createRemoteAttachments } from './remote-attach.js';

/** A browser SDK whose worker acknowledges every message it is sent. */
const makeBrowserSdk = ({ acknowledge = true } = {}) => {
  const calls = [];
  const query = vi.fn((options) => {
    calls.push(options);
    return (async function* stream() {
      for await (const message of options.prompt) {
        if (acknowledge) options.sse.onDeliveryUpdate({ event_id: message.uuid, status: 'DELIVERY_STATUS_RECEIVED' });
      }
    })();
  });
  return { sdk: { query }, calls };
};

describe('remote attachments', () => {
  it('sends through the session bridge as a desktop client and reuses the connection', async () => {
    const { sdk, calls } = makeBrowserSdk();
    let n = 0;
    const attach = createRemoteAttachments({
      loadBrowserSdk: async () => sdk,
      readAccessToken: async () => 'tok',
      randomUUID: () => `u-${++n}`,
    });

    await attach.send('session_01ABC', [{ type: 'text', text: 'uno' }]);
    await attach.send('cse_01ABC', [{ type: 'text', text: 'dos' }]);

    expect(sdk.query).toHaveBeenCalledTimes(1);
    const { sse } = calls[0];
    expect(sse.sessionId).toBe('cse_01ABC');
    expect(sse.streamUrl).toBe('https://api.anthropic.com/v1/code/sessions/cse_01ABC/events/stream');
    expect(sse.sendUrl).toBe('https://api.anthropic.com/v1/code/sessions/cse_01ABC/events');
    expect(sse.headers).toMatchObject({ Authorization: 'Bearer tok', 'anthropic-client-platform': 'desktop_app' });
    attach.closeAll();
  });

  it('fails when the live session never acknowledges the message', async () => {
    const { sdk } = makeBrowserSdk({ acknowledge: false });
    const attach = createRemoteAttachments({
      loadBrowserSdk: async () => sdk,
      readAccessToken: async () => 'tok',
      deliveryTimeoutMs: 10,
    });
    await expect(attach.send('session_01X', [{ type: 'text', text: 'x' }]))
      .rejects.toMatchObject({ code: 'CLAUDE_REMOTE_ATTACH_FAILED' });
    attach.closeAll();
  });

  it('fails without claude.ai credentials', async () => {
    const { sdk } = makeBrowserSdk();
    const attach = createRemoteAttachments({ loadBrowserSdk: async () => sdk, readAccessToken: async () => '' });
    await expect(attach.send('session_01X', [{ type: 'text', text: 'x' }]))
      .rejects.toMatchObject({ code: 'CLAUDE_REMOTE_ATTACH_FAILED' });
    expect(sdk.query).not.toHaveBeenCalled();
  });
});
