/**
 * Unit tests for DiscordConnector.
 *
 * All Discord REST API calls are intercepted via vi.stubGlobal('fetch', ...).
 * No real HTTP requests are made. Gateway events are fed via feedEvent().
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import pino from 'pino';
import { DiscordConnector, encodeThreadId, decodeThreadId } from '../../../../../src/channels/connectors/discord/discord-connector.js';
import type { DiscordConfig, DiscordGatewayEvent, DiscordMessage } from '../../../../../src/channels/connectors/discord/discord-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<DiscordConfig>): DiscordConfig {
  return {
    botToken: 'test-bot-token',
    applicationId: '1234567890',
    ...overrides,
  };
}

/**
 * Build a fake Discord message object.
 */
function makeMessage(
  opts: Partial<DiscordMessage> & { id?: string; channelId?: string; content?: string } = {},
): DiscordMessage {
  return {
    id: opts.id ?? '1000000000000000001',
    channel_id: opts.channel_id ?? opts.channelId ?? '9999999999999999991',
    author: opts.author ?? {
      id: '2000000000000000001',
      username: 'testuser',
      bot: false,
    },
    content: opts.content ?? 'Hello from Discord!',
    timestamp: opts.timestamp ?? '2026-02-27T10:00:00.000Z',
    guild_id: opts.guild_id,
    message_reference: opts.message_reference,
    member: opts.member,
  };
}

/**
 * Build a MESSAGE_CREATE gateway event.
 */
function makeMessageEvent(message: DiscordMessage): DiscordGatewayEvent {
  return {
    op: 0,
    t: 'MESSAGE_CREATE',
    s: 1,
    d: message,
  };
}

/**
 * Build a successful send response.
 */
function sendOkResponse(channelId = '9999999999999999991', messageId = '3000000000000000001'): object {
  return {
    id: messageId,
    channel_id: channelId,
    content: 'sent message',
    timestamp: '2026-02-27T10:00:00.000Z',
  };
}

/**
 * Build a Discord API error response.
 */
function sendErrorResponse(code: number, message: string): object {
  return { code, message };
}

/**
 * Create a mock fetch that returns a successful send response.
 */
function mockFetchOk(responseBody: object = sendOkResponse()): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: () => Promise.resolve(responseBody),
  } as unknown as Response);
}

/**
 * Create a mock fetch that returns an error response.
 */
function mockFetchError(status: number, body: object): ReturnType<typeof vi.fn> {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    headers: new Headers(),
    json: () => Promise.resolve(body),
  } as unknown as Response);
}

/**
 * Create a mock fetch that throws a network error.
 */
function mockFetchNetworkError(message = 'network failure'): ReturnType<typeof vi.fn> {
  return vi.fn().mockRejectedValue(new Error(message));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DiscordConnector', () => {
  let connector: DiscordConnector;

  beforeEach(() => {
    connector = new DiscordConnector(defaultConfig(), 'test-discord', silentLogger());
  });

  afterEach(async () => {
    await connector.stop();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Constructor / metadata
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('exposes type = "discord"', () => {
      expect(connector.type).toBe('discord');
    });

    it('exposes the channel name', () => {
      expect(connector.name).toBe('test-discord');
    });

    it('assigns channel name from constructor arg', () => {
      const c = new DiscordConnector(defaultConfig(), 'my-discord-server', silentLogger());
      expect(c.name).toBe('my-discord-server');
    });
  });

  // -------------------------------------------------------------------------
  // Start / stop lifecycle
  // -------------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    it('starts without error', async () => {
      await expect(connector.start()).resolves.toBeUndefined();
    });

    it('stops without error', async () => {
      await connector.start();
      await expect(connector.stop()).resolves.toBeUndefined();
    });

    it('start() is idempotent — calling it twice does not throw', async () => {
      await connector.start();
      await expect(connector.start()).resolves.toBeUndefined();
      await connector.stop();
    });

    it('stop() is idempotent when not running', async () => {
      await expect(connector.stop()).resolves.toBeUndefined();
      await expect(connector.stop()).resolves.toBeUndefined();
    });

    it('start() then stop() then start() works', async () => {
      await connector.start();
      await connector.stop();
      await connector.start();
      await connector.stop();
    });
  });

  // -------------------------------------------------------------------------
  // feedEvent — inbound message handling
  // -------------------------------------------------------------------------

  describe('feedEvent()', () => {
    it('calls handler with a correctly normalised InboundEvent', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      const msg = makeMessage({ id: '1111', channel_id: '2222', content: 'Hello Discord!' });
      await connector.feedEvent(makeMessageEvent(msg));

      expect(received).toHaveLength(1);
      const event = received[0];
      expect(event.channelType).toBe('discord');
      expect(event.channelName).toBe('test-discord');
      expect(event.externalThreadId).toBe('2222');
      expect(event.senderId).toBe(msg.author.id);
      expect(event.idempotencyKey).toBe('1111');
      expect(event.content).toBe('Hello Discord!');
      expect(event.timestamp).toBe(new Date('2026-02-27T10:00:00.000Z').getTime());
      expect(event.raw).toEqual(msg);
    });

    it('ignores non-DISPATCH events (op != 0)', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      await connector.feedEvent({ op: 10, d: { heartbeat_interval: 41250 } });
      await connector.feedEvent({ op: 11 });

      expect(received).toHaveLength(0);
    });

    it('ignores DISPATCH events that are not MESSAGE_CREATE', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      await connector.feedEvent({ op: 0, t: 'READY', d: {} });
      await connector.feedEvent({ op: 0, t: 'GUILD_CREATE', d: {} });
      await connector.feedEvent({ op: 0, t: 'MESSAGE_UPDATE', d: makeMessage() });

      expect(received).toHaveLength(0);
    });

    it('drops messages from bots', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      const botMsg = makeMessage({
        author: { id: 'bot123', username: 'some-bot', bot: true },
      });
      await connector.feedEvent(makeMessageEvent(botMsg));

      expect(received).toHaveLength(0);
    });

    it('drops messages from self (bot = true)', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      const selfMsg = makeMessage({
        author: { id: 'self', username: 'mybot', bot: true },
      });
      await connector.feedEvent(makeMessageEvent(selfMsg));

      expect(received).toHaveLength(0);
    });

    it('allows messages from non-bot users (bot = false)', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      const humanMsg = makeMessage({
        author: { id: 'human123', username: 'human', bot: false },
      });
      await connector.feedEvent(makeMessageEvent(humanMsg));

      expect(received).toHaveLength(1);
    });

    it('allows messages from users with no bot field', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      const msg = makeMessage({
        author: { id: 'user999', username: 'user999' },
      });
      await connector.feedEvent(makeMessageEvent(msg));

      expect(received).toHaveLength(1);
    });

    it('drops messages with empty content', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      const emptyMsg = makeMessage({ content: '' });
      await connector.feedEvent(makeMessageEvent(emptyMsg));

      expect(received).toHaveLength(0);
    });

    it('logs a warning when message received with no handler registered', async () => {
      // No handler registered.
      await connector.start();

      const msg = makeMessage();
      // Should not throw.
      await expect(connector.feedEvent(makeMessageEvent(msg))).resolves.toBeUndefined();
    });

    it('continues after handler throws an error', async () => {
      const received: InboundEvent[] = [];
      let callCount = 0;

      connector.onMessage(async (event) => {
        callCount++;
        if (callCount === 1) throw new Error('handler error');
        received.push(event);
      });
      await connector.start();

      const msg1 = makeMessage({ id: 'aaa1', content: 'first' });
      const msg2 = makeMessage({ id: 'aaa2', content: 'second' });

      await connector.feedEvent(makeMessageEvent(msg1));
      await connector.feedEvent(makeMessageEvent(msg2));

      expect(received).toHaveLength(1);
      expect(received[0].content).toBe('second');
    });

    it('uses message.id as idempotency key (snowflake)', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      const snowflake = '1234567890123456789';
      const msg = makeMessage({ id: snowflake });
      await connector.feedEvent(makeMessageEvent(msg));

      expect(received[0].idempotencyKey).toBe(snowflake);
    });

    it('encodes channel_id as externalThreadId without message reference', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      const msg = makeMessage({ channel_id: 'ch-abc-123' });
      await connector.feedEvent(makeMessageEvent(msg));

      expect(received[0].externalThreadId).toBe('ch-abc-123');
    });
  });

  // -------------------------------------------------------------------------
  // guildId filtering
  // -------------------------------------------------------------------------

  describe('guildId filtering', () => {
    it('drops messages from disallowed guilds', async () => {
      const received: InboundEvent[] = [];

      const restrictedConnector = new DiscordConnector(
        defaultConfig({ guildId: 'allowed-guild' }),
        'restricted',
        silentLogger(),
      );
      restrictedConnector.onMessage(async (event) => { received.push(event); });
      await restrictedConnector.start();

      const blockedMsg = makeMessage({ guild_id: 'other-guild' });
      await restrictedConnector.feedEvent(makeMessageEvent(blockedMsg));

      expect(received).toHaveLength(0);
      await restrictedConnector.stop();
    });

    it('allows messages from the configured guild', async () => {
      const received: InboundEvent[] = [];

      const restrictedConnector = new DiscordConnector(
        defaultConfig({ guildId: 'allowed-guild' }),
        'restricted',
        silentLogger(),
      );
      restrictedConnector.onMessage(async (event) => { received.push(event); });
      await restrictedConnector.start();

      const allowedMsg = makeMessage({ guild_id: 'allowed-guild' });
      await restrictedConnector.feedEvent(makeMessageEvent(allowedMsg));

      expect(received).toHaveLength(1);
      await restrictedConnector.stop();
    });

    it('allows all guilds when guildId is not configured', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      await connector.feedEvent(makeMessageEvent(makeMessage({ guild_id: 'guild-a' })));
      await connector.feedEvent(makeMessageEvent(makeMessage({ id: '2', channel_id: '2', guild_id: 'guild-b' })));

      expect(received).toHaveLength(2);
    });

    it('allows messages with no guild_id when guildId is configured', async () => {
      // DM messages may have no guild_id; the guildId restriction only applies
      // when the message has a guild_id.
      const received: InboundEvent[] = [];

      const restrictedConnector = new DiscordConnector(
        defaultConfig({ guildId: 'my-guild' }),
        'restricted',
        silentLogger(),
      );
      restrictedConnector.onMessage(async (event) => { received.push(event); });
      await restrictedConnector.start();

      // Message with no guild_id (DM) should pass through.
      const dmMsg = makeMessage({ guild_id: undefined });
      await restrictedConnector.feedEvent(makeMessageEvent(dmMsg));

      expect(received).toHaveLength(1);
      await restrictedConnector.stop();
    });
  });

  // -------------------------------------------------------------------------
  // allowedChannelIds filtering
  // -------------------------------------------------------------------------

  describe('allowedChannelIds filtering', () => {
    it('drops messages from disallowed channels', async () => {
      const received: InboundEvent[] = [];

      const restrictedConnector = new DiscordConnector(
        defaultConfig({ allowedChannelIds: ['allowed-ch'] }),
        'restricted',
        silentLogger(),
      );
      restrictedConnector.onMessage(async (event) => { received.push(event); });
      await restrictedConnector.start();

      const blockedMsg = makeMessage({ channel_id: 'blocked-ch' });
      await restrictedConnector.feedEvent(makeMessageEvent(blockedMsg));

      expect(received).toHaveLength(0);
      await restrictedConnector.stop();
    });

    it('allows messages from allowed channels', async () => {
      const received: InboundEvent[] = [];

      const restrictedConnector = new DiscordConnector(
        defaultConfig({ allowedChannelIds: ['allowed-ch-1', 'allowed-ch-2'] }),
        'restricted',
        silentLogger(),
      );
      restrictedConnector.onMessage(async (event) => { received.push(event); });
      await restrictedConnector.start();

      const msg1 = makeMessage({ id: 'm1', channel_id: 'allowed-ch-1' });
      const msg2 = makeMessage({ id: 'm2', channel_id: 'allowed-ch-2' });
      await restrictedConnector.feedEvent(makeMessageEvent(msg1));
      await restrictedConnector.feedEvent(makeMessageEvent(msg2));

      expect(received).toHaveLength(2);
      await restrictedConnector.stop();
    });

    it('allows all channels when allowedChannelIds is not set', async () => {
      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => { received.push(event); });
      await connector.start();

      await connector.feedEvent(makeMessageEvent(makeMessage({ id: 'x1', channel_id: 'ch-a' })));
      await connector.feedEvent(makeMessageEvent(makeMessage({ id: 'x2', channel_id: 'ch-b' })));

      expect(received).toHaveLength(2);
    });

    it('allows all channels when allowedChannelIds is an empty array', async () => {
      const received: InboundEvent[] = [];

      const openConnector = new DiscordConnector(
        defaultConfig({ allowedChannelIds: [] }),
        'open',
        silentLogger(),
      );
      openConnector.onMessage(async (event) => { received.push(event); });
      await openConnector.start();

      await openConnector.feedEvent(makeMessageEvent(makeMessage()));

      expect(received).toHaveLength(1);
      await openConnector.stop();
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('returns Ok on a successful send', async () => {
      vi.stubGlobal('fetch', mockFetchOk());

      const result = await connector.send('9999999999999999991', { body: 'Hello Discord!' });

      expect(result.isOk()).toBe(true);
    });

    it('calls the Discord messages endpoint with the correct URL', async () => {
      const mockFetch = mockFetchOk();
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('ch123', { body: 'test' });

      const calledUrl = mockFetch.mock.calls[0][0] as string;
      expect(calledUrl).toContain('discord.com/api/v10');
      expect(calledUrl).toContain('/channels/ch123/messages');
    });

    it('sends a POST request with correct Authorization header', async () => {
      const mockFetch = mockFetchOk();
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('ch123', { body: 'test' });

      const opts = mockFetch.mock.calls[0][1] as RequestInit;
      expect(opts.method).toBe('POST');
      expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bot test-bot-token');
    });

    it('sends content as JSON body', async () => {
      const mockFetch = mockFetchOk();
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('ch123', { body: 'Hello **world**' });

      const opts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(typeof body.content).toBe('string');
      expect(body.content).toBe('Hello **world**'); // Discord passes bold through unchanged
    });

    it('sends message_reference when externalThreadId contains a messageId', async () => {
      const mockFetch = mockFetchOk();
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('ch123:msg456', { body: 'reply!' });

      const opts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body.message_reference).toEqual({ message_id: 'msg456' });
    });

    it('does not send message_reference when externalThreadId is just channelId', async () => {
      const mockFetch = mockFetchOk();
      vi.stubGlobal('fetch', mockFetch);

      await connector.send('ch123', { body: 'not a reply' });

      const opts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      expect(body.message_reference).toBeUndefined();
    });

    it('formats the body using markdownToDiscord before sending', async () => {
      const mockFetch = mockFetchOk();
      vi.stubGlobal('fetch', mockFetch);

      // Images get converted; everything else passes through
      await connector.send('ch123', { body: '![screenshot](https://example.com/img.png)' });

      const opts = mockFetch.mock.calls[0][1] as RequestInit;
      const body = JSON.parse(opts.body as string) as Record<string, unknown>;
      // Image should be converted to alt text + URL
      expect(body.content).toBe('screenshot (https://example.com/img.png)');
    });

    it('returns Err(ChannelError) when API returns a non-OK status', async () => {
      vi.stubGlobal('fetch', mockFetchError(403, sendErrorResponse(50013, 'Missing Permissions')));

      const result = await connector.send('ch123', { body: 'test' });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.message).toContain('50013');
      expect(error.message).toContain('Missing Permissions');
    });

    it('returns Err(ChannelError) on a network error', async () => {
      vi.stubGlobal('fetch', mockFetchNetworkError('connection refused'));

      const result = await connector.send('ch123', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('connection refused');
    });

    it('returns Err(ChannelError) with CHANNEL_ERROR code', async () => {
      vi.stubGlobal('fetch', mockFetchNetworkError());

      const result = await connector.send('ch123', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().code).toBe('CHANNEL_ERROR');
    });
  });

  // -------------------------------------------------------------------------
  // Rate limiting
  // -------------------------------------------------------------------------

  describe('rate limiting', () => {
    it('retries after 429 rate limit response using Retry-After header', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            headers: new Headers({ 'Retry-After': '0.01' }), // 10ms wait
            json: () => Promise.resolve({ message: 'You are being rate limited.' }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve(sendOkResponse()),
        } as unknown as Response);
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('ch123', { body: 'test' });

      expect(result.isOk()).toBe(true);
      expect(callCount).toBe(2);
    });

    it('retries after 429 using X-RateLimit-Reset-After header when no Retry-After', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            headers: new Headers({ 'X-RateLimit-Reset-After': '0.01' }),
            json: () => Promise.resolve({ message: 'rate limited' }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve(sendOkResponse()),
        } as unknown as Response);
      });
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('ch123', { body: 'test' });

      expect(result.isOk()).toBe(true);
      expect(callCount).toBe(2);
    });

    it('returns Err after exceeding MAX_RATE_LIMIT_RETRIES', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 429,
        headers: new Headers({ 'Retry-After': '0.001' }),
        json: () => Promise.resolve({ message: 'rate limited' }),
      } as unknown as Response);
      vi.stubGlobal('fetch', mockFetch);

      const result = await connector.send('ch123', { body: 'test' });

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('rate limited');
    }, 10000);

    it('uses 1 second default when no rate limit headers are present', async () => {
      // We test that when headers are absent the parseRetryAfter fallback returns
      // a valid number. This is tested indirectly: the connector should succeed
      // after a retry with very short sleep (we stub sleep by mocking timers).
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 429,
            headers: new Headers(), // no Retry-After or X-RateLimit-Reset-After
            json: () => Promise.resolve({ message: 'rate limited' }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers(),
          json: () => Promise.resolve(sendOkResponse()),
        } as unknown as Response);
      });
      vi.stubGlobal('fetch', mockFetch);

      // Use fake timers to avoid actually sleeping 1 second.
      vi.useFakeTimers();
      const sendPromise = connector.send('ch123', { body: 'test' });
      // Advance timers by 2 seconds to cover the default 1s sleep.
      await vi.runAllTimersAsync();
      const result = await sendPromise;
      vi.useRealTimers();

      expect(result.isOk()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // format()
  // -------------------------------------------------------------------------

  describe('format()', () => {
    it('delegates to markdownToDiscord', () => {
      // Bold passes through in Discord.
      expect(connector.format('**bold**')).toBe('**bold**');
    });

    it('converts images to alt text + URL', () => {
      expect(connector.format('![alt](https://example.com/img.png)')).toBe(
        'alt (https://example.com/img.png)',
      );
    });

    it('passes code blocks through unchanged', () => {
      const code = '```js\nconst x = 1;\n```';
      expect(connector.format(code)).toBe(code);
    });
  });

  // -------------------------------------------------------------------------
  // onMessage
  // -------------------------------------------------------------------------

  describe('onMessage()', () => {
    it('replaces previous handler when called a second time', async () => {
      const firstReceived: InboundEvent[] = [];
      const secondReceived: InboundEvent[] = [];

      connector.onMessage(async (event) => { firstReceived.push(event); });
      connector.onMessage(async (event) => { secondReceived.push(event); });

      await connector.start();
      const msg = makeMessage();
      await connector.feedEvent(makeMessageEvent(msg));

      expect(firstReceived).toHaveLength(0);
      expect(secondReceived).toHaveLength(1);
    });
  });
});

// ---------------------------------------------------------------------------
// encodeThreadId / decodeThreadId
// ---------------------------------------------------------------------------

describe('encodeThreadId', () => {
  it('encodes channelId only', () => {
    expect(encodeThreadId('ch123')).toBe('ch123');
  });

  it('encodes channelId + messageId with colon separator', () => {
    expect(encodeThreadId('ch123', 'msg456')).toBe('ch123:msg456');
  });

  it('returns channelId only when messageId is undefined', () => {
    expect(encodeThreadId('ch123', undefined)).toBe('ch123');
  });
});

describe('decodeThreadId', () => {
  it('decodes a channelId-only string', () => {
    const decoded = decodeThreadId('ch123');
    expect(decoded.channelId).toBe('ch123');
    expect(decoded.messageId).toBeUndefined();
  });

  it('decodes a channelId:messageId string', () => {
    const decoded = decodeThreadId('ch123:msg456');
    expect(decoded.channelId).toBe('ch123');
    expect(decoded.messageId).toBe('msg456');
  });

  it('handles snowflake IDs correctly', () => {
    const channelId = '1234567890123456789';
    const messageId = '9876543210987654321';
    const decoded = decodeThreadId(`${channelId}:${messageId}`);
    expect(decoded.channelId).toBe(channelId);
    expect(decoded.messageId).toBe(messageId);
  });

  it('round-trips through encode and decode', () => {
    const channelId = 'ch-abc';
    const messageId = 'msg-xyz';
    const encoded = encodeThreadId(channelId, messageId);
    const decoded = decodeThreadId(encoded);
    expect(decoded.channelId).toBe(channelId);
    expect(decoded.messageId).toBe(messageId);
  });

  it('round-trips channelId only', () => {
    const channelId = 'solo-channel';
    const encoded = encodeThreadId(channelId);
    const decoded = decodeThreadId(encoded);
    expect(decoded.channelId).toBe(channelId);
    expect(decoded.messageId).toBeUndefined();
  });
});
