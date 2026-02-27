/**
 * Unit tests for SlackConnector.
 *
 * All Slack Web API calls are intercepted via vi.stubGlobal('fetch', ...).
 * No real HTTP requests are made.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { SlackConnector, encodeThreadId, decodeThreadId } from '../../../../../src/channels/connectors/slack/slack-connector.js';
import type { SlackConfig } from '../../../../../src/channels/connectors/slack/slack-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<SlackConfig>): SlackConfig {
  return {
    botToken: 'xoxb-test-token',
    signingSecret: 'test-signing-secret',
    ...overrides,
  };
}

/** Build a minimal Slack event envelope with a text message. */
function makeSlackEvent(overrides?: {
  channelId?: string;
  userId?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  bot_id?: string;
  event_id?: string;
  client_msg_id?: string;
}): object {
  const {
    channelId = 'C01234567',
    userId = 'U01234567',
    text = 'Hello bot!',
    ts = '1700000000.123456',
    thread_ts,
    bot_id,
    event_id = 'Ev01234567',
    client_msg_id,
  } = overrides ?? {};

  return {
    event_id,
    event_time: 1700000000,
    type: 'event_callback',
    event: {
      type: 'message',
      channel: channelId,
      user: userId,
      text,
      ts,
      ...(thread_ts ? { thread_ts } : {}),
      ...(bot_id ? { bot_id } : {}),
      ...(client_msg_id ? { client_msg_id } : {}),
    },
  };
}

/** Build a successful chat.postMessage response. */
function postMessageOkResponse(): object {
  return {
    ok: true,
    channel: 'C01234567',
    ts: '1700000001.000000',
    message: {
      type: 'message',
      text: 'Hello',
      ts: '1700000001.000000',
    },
  };
}

/** Build a failed chat.postMessage response. */
function postMessageErrorResponse(error: string): object {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SlackConnector', () => {
  let connector: SlackConnector;

  beforeEach(() => {
    connector = new SlackConnector(defaultConfig(), 'test-slack', silentLogger());
  });

  afterEach(async () => {
    await connector.stop();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor / metadata
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('exposes type = "slack"', () => {
      expect(connector.type).toBe('slack');
    });

    it('exposes the channel name', () => {
      expect(connector.name).toBe('test-slack');
    });
  });

  // -------------------------------------------------------------------------
  // Start / stop lifecycle
  // -------------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    it('starts and stops without error', async () => {
      await connector.start();
      await connector.stop();
    });

    it('start() is idempotent — calling it twice is a no-op', async () => {
      await connector.start();
      await connector.start(); // second call should be a no-op
      await connector.stop();
    });

    it('stop() is idempotent when not running', async () => {
      await connector.stop(); // should not throw
    });

    it('stop() after start() transitions to stopped state', async () => {
      await connector.start();
      await connector.stop();
      // Calling stop again should be a no-op.
      await connector.stop();
    });
  });

  // -------------------------------------------------------------------------
  // feedEvent — inbound message handling
  // -------------------------------------------------------------------------

  describe('feedEvent() — inbound message handling', () => {
    it('calls handler with a correctly normalised InboundEvent', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        channelId: 'C01234567',
        userId: 'U09876543',
        text: 'Hello bot!',
        ts: '1700000000.123456',
        event_id: 'Ev01234567',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.channelType).toBe('slack');
      expect(event.channelName).toBe('test-slack');
      expect(event.externalThreadId).toBe('C01234567');
      expect(event.senderId).toBe('U09876543');
      expect(event.idempotencyKey).toBe('Ev01234567');
      expect(event.content).toBe('Hello bot!');
      expect(event.timestamp).toBe(1700000000123);
      expect(event.raw).toBeDefined();
    });

    it('uses channel:thread_ts as externalThreadId for threaded messages', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        channelId: 'C01234567',
        ts: '1700000001.000000',
        thread_ts: '1700000000.000000',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(1);
      expect(received[0].externalThreadId).toBe('C01234567:1700000000.000000');
    });

    it('uses channel alone as externalThreadId for non-threaded messages', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        channelId: 'C01234567',
        ts: '1700000000.000000',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(1);
      expect(received[0].externalThreadId).toBe('C01234567');
    });

    it('prefers event_id as idempotency key', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        event_id: 'Ev_unique_123',
        client_msg_id: 'client-id-456',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received[0].idempotencyKey).toBe('Ev_unique_123');
    });

    it('falls back to client_msg_id when event_id is absent', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      const event = makeSlackEvent({
        client_msg_id: 'client-id-456',
      }) as Record<string, unknown>;
      delete event['event_id'];

      await connector.feedEvent(event as Parameters<typeof connector.feedEvent>[0]);

      expect(received[0].idempotencyKey).toBe('client-id-456');
    });

    it('falls back to channel:ts when neither event_id nor client_msg_id is present', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      const slackEvent = makeSlackEvent({
        channelId: 'C01234567',
        ts: '1700000000.123456',
      }) as Record<string, unknown>;
      delete slackEvent['event_id'];

      await connector.feedEvent(slackEvent as Parameters<typeof connector.feedEvent>[0]);

      expect(received[0].idempotencyKey).toBe('C01234567:1700000000.123456');
    });

    it('drops bot messages (messages with bot_id set)', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        bot_id: 'B01234567',
        text: 'I am a bot',
      }) as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(0);
    });

    it('drops events with no inner event object', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent({} as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(0);
    });

    it('drops events with no text', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      const event = makeSlackEvent({ text: 'hello' }) as Record<string, unknown>;
      const innerEvent = event['event'] as Record<string, unknown>;
      delete innerEvent['text'];

      await connector.feedEvent(event as Parameters<typeof connector.feedEvent>[0]);

      expect(received).toHaveLength(0);
    });

    it('uses channel as senderId when user is absent', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      const slackEvent = makeSlackEvent({ channelId: 'C01234567' }) as Record<string, unknown>;
      const innerEvent = slackEvent['event'] as Record<string, unknown>;
      delete innerEvent['user'];

      await connector.feedEvent(slackEvent as Parameters<typeof connector.feedEvent>[0]);

      expect(received[0].senderId).toBe('C01234567');
    });

    it('logs a warning when no handler is registered', async () => {
      // No handler registered — should not throw.
      await connector.feedEvent(makeSlackEvent() as Parameters<typeof connector.feedEvent>[0]);
    });

    it('continues processing after handler throws', async () => {
      let callCount = 0;

      connector.onMessage(async () => {
        callCount++;
        throw new Error('handler blew up');
      });

      // Should not throw even if handler throws.
      await connector.feedEvent(makeSlackEvent() as Parameters<typeof connector.feedEvent>[0]);

      expect(callCount).toBe(1);
    });

    it('parses Slack timestamp correctly to milliseconds', async () => {
      const received: InboundEvent[] = [];

      connector.onMessage(async (event) => {
        received.push(event);
      });

      await connector.feedEvent(makeSlackEvent({
        ts: '1700000000.500000',
      }) as Parameters<typeof connector.feedEvent>[0]);

      // 1700000000.5 seconds = 1700000000500 ms
      expect(received[0].timestamp).toBe(1700000000500);
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('returns Ok on a successful chat.postMessage call', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('C01234567', { body: 'Hello **world**' });

      expect(result.isOk()).toBe(true);
    });

    it('calls the Slack chat.postMessage endpoint', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: 'Hello' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('slack.com/api/chat.postMessage');
    });

    it('sends Authorization Bearer token header', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: 'Hello' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const headers = callOpts.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('Bearer xoxb-test-token');
    });

    it('sends JSON with channel and text fields', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: 'plain text' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
      expect(body.channel).toBe('C01234567');
      expect(typeof body.text).toBe('string');
    });

    it('sends thread_ts when externalThreadId encodes a thread', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567:1700000000.000000', { body: 'Reply in thread' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
      expect(body.channel).toBe('C01234567');
      expect(body.thread_ts).toBe('1700000000.000000');
    });

    it('does not send thread_ts when externalThreadId is just a channel', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: 'Top-level message' });

      const callOpts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(callOpts.body as string) as Record<string, unknown>;
      expect(body.thread_ts).toBeUndefined();
    });

    it('returns Err(ChannelError) when the API returns ok=false', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageErrorResponse('channel_not_found')),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('C_INVALID', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('channel_not_found');
    });

    it('returns Err(ChannelError) on a network error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('network failure'));
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('C01234567', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('network failure');
    });

    it('returns Err(ChannelError) when response JSON cannot be parsed', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error('invalid json')),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('C01234567', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('could not parse response');
    });

    it('converts the Markdown body to Slack mrkdwn before sending', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(postMessageOkResponse()),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('C01234567', { body: '**bold**' });

      const body = JSON.parse(
        (mockFetch.mock.calls[0][1] as RequestInit).body as string,
      ) as Record<string, unknown>;
      // **bold** should be converted to *bold* (Slack mrkdwn bold)
      expect(body.text).toBe('*bold*');
    });
  });

  // -------------------------------------------------------------------------
  // format()
  // -------------------------------------------------------------------------

  describe('format()', () => {
    it('delegates to markdownToSlackMrkdwn', () => {
      expect(connector.format('**hello**')).toBe('*hello*');
    });

    it('converts italic markdown to Slack mrkdwn', () => {
      expect(connector.format('*italic*')).toBe('_italic_');
    });

    it('converts links to Slack <url|label> format', () => {
      expect(connector.format('[click](https://example.com)')).toBe('<https://example.com|click>');
    });
  });
});

// ---------------------------------------------------------------------------
// encodeThreadId / decodeThreadId utilities
// ---------------------------------------------------------------------------

describe('encodeThreadId', () => {
  it('returns just the channelId when no threadTs is provided', () => {
    expect(encodeThreadId('C01234567')).toBe('C01234567');
  });

  it('encodes channelId and threadTs separated by colon', () => {
    expect(encodeThreadId('C01234567', '1700000000.000000')).toBe(
      'C01234567:1700000000.000000',
    );
  });
});

describe('decodeThreadId', () => {
  it('returns channelId and undefined threadTs when no colon is present', () => {
    const result = decodeThreadId('C01234567');
    expect(result.channelId).toBe('C01234567');
    expect(result.threadTs).toBeUndefined();
  });

  it('splits on the first colon to extract channelId and threadTs', () => {
    const result = decodeThreadId('C01234567:1700000000.123456');
    expect(result.channelId).toBe('C01234567');
    expect(result.threadTs).toBe('1700000000.123456');
  });

  it('round-trips with encodeThreadId', () => {
    const channelId = 'C01234567';
    const threadTs = '1700000000.000000';
    const encoded = encodeThreadId(channelId, threadTs);
    const decoded = decodeThreadId(encoded);
    expect(decoded.channelId).toBe(channelId);
    expect(decoded.threadTs).toBe(threadTs);
  });
});
