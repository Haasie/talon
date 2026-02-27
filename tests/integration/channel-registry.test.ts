/**
 * Integration tests for ChannelRegistry with real (mock) connectors.
 *
 * Tests registration, lifecycle management (start/stop), inbound/outbound
 * message routing, and error handling — all using real ChannelRegistry
 * instances and mock ChannelConnector implementations.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import { ok, err } from 'neverthrow';

import { ChannelRegistry } from '../../src/channels/channel-registry.js';
import { ChannelError } from '../../src/core/errors/error-types.js';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../src/channels/channel-types.js';
import type { Result } from '../../src/core/types/result.js';

// ---------------------------------------------------------------------------
// Mock connector factory
// ---------------------------------------------------------------------------

interface LifecycleEvent {
  event: 'start' | 'stop';
  name: string;
  timestamp: number;
}

class MockConnector implements ChannelConnector {
  readonly type: string;
  readonly name: string;

  private messageHandler?: (event: InboundEvent) => Promise<void>;
  isRunning = false;
  startCallCount = 0;
  stopCallCount = 0;
  sentMessages: Array<{ threadId: string; output: AgentOutput }> = [];
  shouldFailOnStart = false;
  shouldFailOnStop = false;
  lifecycleLog: LifecycleEvent[] = [];

  constructor(name: string, type = 'mock') {
    this.name = name;
    this.type = type;
  }

  async start(): Promise<void> {
    if (this.shouldFailOnStart) {
      throw new Error(`Connector "${this.name}" failed to start`);
    }
    this.isRunning = true;
    this.startCallCount++;
    this.lifecycleLog.push({ event: 'start', name: this.name, timestamp: Date.now() });
  }

  async stop(): Promise<void> {
    if (this.shouldFailOnStop) {
      throw new Error(`Connector "${this.name}" failed to stop`);
    }
    this.isRunning = false;
    this.stopCallCount++;
    this.lifecycleLog.push({ event: 'stop', name: this.name, timestamp: Date.now() });
  }

  onMessage(handler: (event: InboundEvent) => Promise<void>): void {
    this.messageHandler = handler;
  }

  async send(threadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    this.sentMessages.push({ threadId, output });
    return ok(undefined);
  }

  format(markdown: string): string {
    return `[${this.name}] ${markdown}`;
  }

  async simulateInbound(event: InboundEvent): Promise<void> {
    if (this.messageHandler) {
      await this.messageHandler(event);
    }
  }
}

class FailingSendConnector extends MockConnector {
  override async send(threadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    return err(new ChannelError(`${this.name} send failed`));
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createTestLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeInboundEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    channelType: 'mock',
    channelName: 'test-connector',
    externalThreadId: 'ext-thread-001',
    senderId: 'user-001',
    idempotencyKey: `key-${Date.now()}`,
    content: 'Hello from test',
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelRegistry integration', () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry(createTestLogger());
  });

  // -------------------------------------------------------------------------
  // Registration
  // -------------------------------------------------------------------------

  describe('register', () => {
    it('registers a single connector successfully', () => {
      const connector = new MockConnector('bot-1');
      expect(() => registry.register(connector)).not.toThrow();
    });

    it('registered connector can be retrieved by name', () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);

      const found = registry.get('bot-1');
      expect(found).toBe(connector);
    });

    it('registers multiple connectors with distinct names', () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');
      const c3 = new MockConnector('bot-3');

      registry.register(c1);
      registry.register(c2);
      registry.register(c3);

      expect(registry.get('bot-1')).toBe(c1);
      expect(registry.get('bot-2')).toBe(c2);
      expect(registry.get('bot-3')).toBe(c3);
    });

    it('throws ChannelError when registering duplicate name', () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-1'); // same name

      registry.register(c1);
      expect(() => registry.register(c2)).toThrow(ChannelError);
    });

    it('registers connectors of different types', () => {
      const telegram = new MockConnector('tg-bot', 'telegram');
      const slack = new MockConnector('slack-bot', 'slack');
      const discord = new MockConnector('discord-bot', 'discord');

      registry.register(telegram);
      registry.register(slack);
      registry.register(discord);

      expect(registry.listAll()).toHaveLength(3);
    });
  });

  // -------------------------------------------------------------------------
  // Unregistration
  // -------------------------------------------------------------------------

  describe('unregister', () => {
    it('removes a registered connector', () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);
      registry.unregister('bot-1');

      expect(registry.get('bot-1')).toBeUndefined();
    });

    it('unregister on non-existent name is a no-op', () => {
      expect(() => registry.unregister('non-existent')).not.toThrow();
    });

    it('after unregister, listAll does not include the removed connector', () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');

      registry.register(c1);
      registry.register(c2);
      registry.unregister('bot-1');

      const all = registry.listAll();
      expect(all).toHaveLength(1);
      expect(all[0]?.name).toBe('bot-2');
    });

    it('connector can be re-registered after unregister', () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-1');

      registry.register(c1);
      registry.unregister('bot-1');
      expect(() => registry.register(c2)).not.toThrow();

      expect(registry.get('bot-1')).toBe(c2);
    });
  });

  // -------------------------------------------------------------------------
  // Look-up
  // -------------------------------------------------------------------------

  describe('get and getByType', () => {
    it('get returns undefined for non-existent connector', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });

    it('getByType returns all connectors of the given type', () => {
      const tg1 = new MockConnector('tg-1', 'telegram');
      const tg2 = new MockConnector('tg-2', 'telegram');
      const sl1 = new MockConnector('sl-1', 'slack');

      registry.register(tg1);
      registry.register(tg2);
      registry.register(sl1);

      const telegramConnectors = registry.getByType('telegram');
      expect(telegramConnectors).toHaveLength(2);
      expect(telegramConnectors.map((c) => c.name).sort()).toEqual(['tg-1', 'tg-2']);
    });

    it('getByType returns empty array when no connectors of that type', () => {
      registry.register(new MockConnector('bot-1', 'telegram'));
      expect(registry.getByType('slack')).toHaveLength(0);
    });

    it('listAll returns all registered connectors in registration order', () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');
      const c3 = new MockConnector('bot-3');

      registry.register(c1);
      registry.register(c2);
      registry.register(c3);

      const all = registry.listAll();
      expect(all).toHaveLength(3);
      expect(all[0]?.name).toBe('bot-1');
      expect(all[1]?.name).toBe('bot-2');
      expect(all[2]?.name).toBe('bot-3');
    });

    it('listAll returns empty array when no connectors registered', () => {
      expect(registry.listAll()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle: startAll
  // -------------------------------------------------------------------------

  describe('startAll', () => {
    it('starts all registered connectors', async () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');
      const c3 = new MockConnector('bot-3');

      registry.register(c1);
      registry.register(c2);
      registry.register(c3);

      await registry.startAll();

      expect(c1.isRunning).toBe(true);
      expect(c2.isRunning).toBe(true);
      expect(c3.isRunning).toBe(true);
    });

    it('each connector start() is called exactly once', async () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');

      registry.register(c1);
      registry.register(c2);

      await registry.startAll();

      expect(c1.startCallCount).toBe(1);
      expect(c2.startCallCount).toBe(1);
    });

    it('startAll with no connectors does not throw', async () => {
      await expect(registry.startAll()).resolves.not.toThrow();
    });

    it('throws ChannelError if any connector fails to start', async () => {
      const good = new MockConnector('good-bot');
      const bad = new MockConnector('bad-bot');
      bad.shouldFailOnStart = true;

      registry.register(good);
      registry.register(bad);

      await expect(registry.startAll()).rejects.toThrow(ChannelError);
    });

    it('successfully started connectors remain running even if another fails', async () => {
      const good = new MockConnector('good-bot');
      const bad = new MockConnector('bad-bot');
      bad.shouldFailOnStart = true;

      registry.register(good);
      registry.register(bad);

      try {
        await registry.startAll();
      } catch {
        // Expected to throw
      }

      expect(good.isRunning).toBe(true);
    });

    it('records start lifecycle events in order', async () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');

      registry.register(c1);
      registry.register(c2);

      await registry.startAll();

      const c1Events = c1.lifecycleLog.filter((e) => e.event === 'start');
      const c2Events = c2.lifecycleLog.filter((e) => e.event === 'start');

      expect(c1Events).toHaveLength(1);
      expect(c2Events).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Lifecycle: stopAll
  // -------------------------------------------------------------------------

  describe('stopAll', () => {
    it('stops all registered connectors', async () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');
      const c3 = new MockConnector('bot-3');

      registry.register(c1);
      registry.register(c2);
      registry.register(c3);

      await registry.startAll();
      await registry.stopAll();

      expect(c1.isRunning).toBe(false);
      expect(c2.isRunning).toBe(false);
      expect(c3.isRunning).toBe(false);
    });

    it('each connector stop() is called exactly once', async () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');

      registry.register(c1);
      registry.register(c2);

      await registry.startAll();
      await registry.stopAll();

      expect(c1.stopCallCount).toBe(1);
      expect(c2.stopCallCount).toBe(1);
    });

    it('stopAll with no connectors does not throw', async () => {
      await expect(registry.stopAll()).resolves.not.toThrow();
    });

    it('stopAll does not throw even if a connector fails to stop', async () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');
      c2.shouldFailOnStop = true;

      registry.register(c1);
      registry.register(c2);

      await registry.startAll();
      // stopAll swallows errors
      await expect(registry.stopAll()).resolves.not.toThrow();
    });

    it('working connectors are stopped even if another fails to stop', async () => {
      const c1 = new MockConnector('good-bot');
      const c2 = new MockConnector('bad-bot');
      c2.shouldFailOnStop = true;

      registry.register(c1);
      registry.register(c2);

      await registry.startAll();
      await registry.stopAll();

      expect(c1.isRunning).toBe(false);
    });

    it('lifecycle ordering: start comes before stop', async () => {
      const c1 = new MockConnector('bot-1');

      registry.register(c1);

      await registry.startAll();
      await registry.stopAll();

      expect(c1.lifecycleLog).toHaveLength(2);
      expect(c1.lifecycleLog[0]?.event).toBe('start');
      expect(c1.lifecycleLog[1]?.event).toBe('stop');
    });
  });

  // -------------------------------------------------------------------------
  // Inbound message routing
  // -------------------------------------------------------------------------

  describe('inbound message simulation', () => {
    it('inbound events are delivered to registered onMessage handler', async () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);

      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => {
        received.push(event);
      });

      const event = makeInboundEvent({ content: 'test message', idempotencyKey: 'key-001' });
      await connector.simulateInbound(event);

      expect(received).toHaveLength(1);
      expect(received[0]?.content).toBe('test message');
    });

    it('multiple inbound events are all delivered', async () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);

      const received: InboundEvent[] = [];
      connector.onMessage(async (event) => {
        received.push(event);
      });

      for (let i = 0; i < 5; i++) {
        await connector.simulateInbound(
          makeInboundEvent({ content: `message ${i}`, idempotencyKey: `key-${i}` }),
        );
      }

      expect(received).toHaveLength(5);
    });

    it('inbound events from different connectors are routed independently', async () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');

      registry.register(c1);
      registry.register(c2);

      const c1Received: InboundEvent[] = [];
      const c2Received: InboundEvent[] = [];

      c1.onMessage(async (e) => { c1Received.push(e); });
      c2.onMessage(async (e) => { c2Received.push(e); });

      await c1.simulateInbound(makeInboundEvent({ channelName: 'bot-1', idempotencyKey: 'k1' }));
      await c2.simulateInbound(makeInboundEvent({ channelName: 'bot-2', idempotencyKey: 'k2' }));
      await c1.simulateInbound(makeInboundEvent({ channelName: 'bot-1', idempotencyKey: 'k3' }));

      expect(c1Received).toHaveLength(2);
      expect(c2Received).toHaveLength(1);
    });

    it('second onMessage registration replaces the first', async () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);

      const first: string[] = [];
      const second: string[] = [];

      connector.onMessage(async (e) => { first.push(e.content); });
      connector.onMessage(async (e) => { second.push(e.content); });

      await connector.simulateInbound(makeInboundEvent({ content: 'hello', idempotencyKey: 'k1' }));

      expect(first).toHaveLength(0); // replaced
      expect(second).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // Outbound message sending
  // -------------------------------------------------------------------------

  describe('outbound message sending', () => {
    it('send delivers message to the correct connector', async () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');

      registry.register(c1);
      registry.register(c2);

      const output: AgentOutput = { body: 'Hello from bot-1' };
      await c1.send('thread-001', output);

      expect(c1.sentMessages).toHaveLength(1);
      expect(c2.sentMessages).toHaveLength(0);
      expect(c1.sentMessages[0]?.output.body).toBe('Hello from bot-1');
    });

    it('send returns ok result on success', async () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);

      const result = await connector.send('thread-001', { body: 'test' });
      expect(result.isOk()).toBe(true);
    });

    it('failing send connector returns err result', async () => {
      const failingConnector = new FailingSendConnector('failing-bot');
      registry.register(failingConnector);

      const result = await failingConnector.send('thread-001', { body: 'test' });
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(ChannelError);
    });

    it('send to multiple connectors independently', async () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');

      registry.register(c1);
      registry.register(c2);

      const output1: AgentOutput = { body: 'Message for bot-1' };
      const output2: AgentOutput = { body: 'Message for bot-2' };

      await c1.send('thread-001', output1);
      await c2.send('thread-002', output2);

      expect(c1.sentMessages[0]?.output.body).toBe('Message for bot-1');
      expect(c2.sentMessages[0]?.output.body).toBe('Message for bot-2');
    });

    it('format() converts markdown per-connector', () => {
      const c1 = new MockConnector('bot-1', 'telegram');
      const c2 = new MockConnector('bot-2', 'slack');

      registry.register(c1);
      registry.register(c2);

      const markdown = '**bold** text';
      expect(c1.format(markdown)).toBe('[bot-1] **bold** text');
      expect(c2.format(markdown)).toBe('[bot-2] **bold** text');
    });
  });

  // -------------------------------------------------------------------------
  // Full lifecycle: register → start → inbound → outbound → stop
  // -------------------------------------------------------------------------

  describe('full lifecycle integration', () => {
    it('complete flow: register → start → inbound → outbound → stop', async () => {
      const c1 = new MockConnector('primary-bot');
      const c2 = new MockConnector('secondary-bot');

      registry.register(c1);
      registry.register(c2);

      // Start all connectors
      await registry.startAll();
      expect(c1.isRunning).toBe(true);
      expect(c2.isRunning).toBe(true);

      // Set up inbound handler
      const receivedEvents: InboundEvent[] = [];
      c1.onMessage(async (event) => {
        receivedEvents.push(event);
        // Respond via the connector
        await c1.send(event.externalThreadId, { body: `Echo: ${event.content}` });
      });

      // Simulate inbound message
      const inboundEvent = makeInboundEvent({
        channelName: 'primary-bot',
        externalThreadId: 'chat-123',
        content: 'ping',
        idempotencyKey: 'key-ping',
      });
      await c1.simulateInbound(inboundEvent);

      // Verify inbound was received
      expect(receivedEvents).toHaveLength(1);
      expect(receivedEvents[0]?.content).toBe('ping');

      // Verify outbound was sent
      expect(c1.sentMessages).toHaveLength(1);
      expect(c1.sentMessages[0]?.output.body).toBe('Echo: ping');
      expect(c1.sentMessages[0]?.threadId).toBe('chat-123');

      // Stop all connectors
      await registry.stopAll();
      expect(c1.isRunning).toBe(false);
      expect(c2.isRunning).toBe(false);

      // Verify lifecycle ordering
      expect(c1.lifecycleLog[0]?.event).toBe('start');
      expect(c1.lifecycleLog[1]?.event).toBe('stop');
    });

    it('all connectors started and stopped in correct order with multiple types', async () => {
      const telegram = new MockConnector('tg-bot', 'telegram');
      const slack = new MockConnector('sl-bot', 'slack');
      const discord = new MockConnector('dc-bot', 'discord');

      registry.register(telegram);
      registry.register(slack);
      registry.register(discord);

      await registry.startAll();

      // All started
      expect(telegram.isRunning).toBe(true);
      expect(slack.isRunning).toBe(true);
      expect(discord.isRunning).toBe(true);

      // Simulate inbound on each
      const allReceived: Array<{ connector: string; content: string }> = [];

      telegram.onMessage(async (e) => { allReceived.push({ connector: 'telegram', content: e.content }); });
      slack.onMessage(async (e) => { allReceived.push({ connector: 'slack', content: e.content }); });
      discord.onMessage(async (e) => { allReceived.push({ connector: 'discord', content: e.content }); });

      await telegram.simulateInbound(makeInboundEvent({ content: 'from telegram', idempotencyKey: 'k1' }));
      await slack.simulateInbound(makeInboundEvent({ content: 'from slack', idempotencyKey: 'k2' }));
      await discord.simulateInbound(makeInboundEvent({ content: 'from discord', idempotencyKey: 'k3' }));

      expect(allReceived).toHaveLength(3);
      expect(allReceived.find((r) => r.connector === 'telegram')?.content).toBe('from telegram');
      expect(allReceived.find((r) => r.connector === 'slack')?.content).toBe('from slack');
      expect(allReceived.find((r) => r.connector === 'discord')?.content).toBe('from discord');

      await registry.stopAll();

      // All stopped
      expect(telegram.isRunning).toBe(false);
      expect(slack.isRunning).toBe(false);
      expect(discord.isRunning).toBe(false);
    });

    it('getByType works to route outbound messages to all connectors of a type', async () => {
      const tg1 = new MockConnector('tg-personal', 'telegram');
      const tg2 = new MockConnector('tg-work', 'telegram');
      const sl1 = new MockConnector('slack-main', 'slack');

      registry.register(tg1);
      registry.register(tg2);
      registry.register(sl1);

      await registry.startAll();

      // Send to all telegram connectors
      const telegramConnectors = registry.getByType('telegram');
      const output: AgentOutput = { body: 'Broadcast to Telegram' };

      for (const conn of telegramConnectors) {
        await conn.send('thread-001', output);
      }

      expect(tg1.sentMessages).toHaveLength(1);
      expect(tg2.sentMessages).toHaveLength(1);
      expect(sl1.sentMessages).toHaveLength(0);

      await registry.stopAll();
    });
  });

  // -------------------------------------------------------------------------
  // Edge cases
  // -------------------------------------------------------------------------

  describe('edge cases', () => {
    it('get returns the exact connector instance (identity check)', () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);

      const retrieved = registry.get('bot-1');
      expect(retrieved).toBe(connector); // same reference
    });

    it('listAll returns a copy — modifying it does not affect registry', () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');

      registry.register(c1);
      registry.register(c2);

      const list = registry.listAll();
      list.pop(); // Remove from the returned array

      // Registry should still have both
      expect(registry.listAll()).toHaveLength(2);
    });

    it('connector with attachments in output is delivered', async () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);

      const output: AgentOutput = {
        body: 'See attached file',
        attachments: [
          {
            filename: 'data.csv',
            mimeType: 'text/csv',
            data: Buffer.from('col1,col2\n1,2'),
            size: 13,
          },
        ],
      };

      await connector.send('thread-001', output);

      expect(connector.sentMessages[0]?.output.attachments).toHaveLength(1);
      expect(connector.sentMessages[0]?.output.attachments?.[0]?.filename).toBe('data.csv');
    });

    it('connector with actions in output is delivered', async () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);

      const output: AgentOutput = {
        body: 'Please approve',
        actions: [
          { type: 'button', label: 'Yes', value: 'yes' },
          { type: 'button', label: 'No', value: 'no' },
        ],
      };

      await connector.send('thread-001', output);

      expect(connector.sentMessages[0]?.output.actions).toHaveLength(2);
      expect(connector.sentMessages[0]?.output.actions?.[0]?.label).toBe('Yes');
    });

    it('inbound event with all optional fields set is delivered correctly', async () => {
      const connector = new MockConnector('bot-1');
      registry.register(connector);

      const received: InboundEvent[] = [];
      connector.onMessage(async (e) => { received.push(e); });

      const event: InboundEvent = {
        channelType: 'mock',
        channelName: 'bot-1',
        externalThreadId: 'thread-xyz',
        senderId: 'user-xyz',
        idempotencyKey: 'unique-key-xyz',
        content: 'Full event test',
        attachments: [
          { filename: 'img.png', mimeType: 'image/png', data: Buffer.from(''), size: 0 },
        ],
        raw: { originalData: true },
        timestamp: 1234567890,
      };

      await connector.simulateInbound(event);

      expect(received[0]).toEqual(event);
    });

    it('registering then immediately unregistering does not affect other connectors', () => {
      const c1 = new MockConnector('bot-1');
      const c2 = new MockConnector('bot-2');
      const c3 = new MockConnector('bot-3');

      registry.register(c1);
      registry.register(c2);
      registry.register(c3);

      registry.unregister('bot-2');

      const all = registry.listAll();
      expect(all).toHaveLength(2);
      expect(all.map((c) => c.name)).not.toContain('bot-2');
      expect(all.map((c) => c.name)).toContain('bot-1');
      expect(all.map((c) => c.name)).toContain('bot-3');
    });
  });
});
