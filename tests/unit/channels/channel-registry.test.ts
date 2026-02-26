import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../../src/channels/channel-types.js';
import { ChannelError } from '../../../src/core/errors/error-types.js';
import { ok } from '../../../src/core/types/result.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a silent pino logger for tests. */
function testLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

/** Build a mock connector with controllable start/stop. */
function makeConnector(
  name: string,
  type = 'telegram',
  opts: { startFails?: boolean; stopFails?: boolean } = {},
): ChannelConnector {
  return {
    type,
    name,
    start: vi.fn().mockImplementation(async () => {
      if (opts.startFails) throw new Error(`start failed for ${name}`);
    }),
    stop: vi.fn().mockImplementation(async () => {
      if (opts.stopFails) throw new Error(`stop failed for ${name}`);
    }),
    onMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(ok(undefined)),
    format: vi.fn((md: string) => md),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ChannelRegistry', () => {
  let registry: ChannelRegistry;

  beforeEach(() => {
    registry = new ChannelRegistry(testLogger());
  });

  // -------------------------------------------------------------------------
  // register / unregister
  // -------------------------------------------------------------------------

  describe('register', () => {
    it('registers a connector and makes it available via get()', () => {
      const c = makeConnector('bot-1');
      registry.register(c);
      expect(registry.get('bot-1')).toBe(c);
    });

    it('throws ChannelError when registering a duplicate name', () => {
      registry.register(makeConnector('bot-1'));
      expect(() => registry.register(makeConnector('bot-1'))).toThrow(ChannelError);
    });

    it('allows multiple connectors with different names', () => {
      registry.register(makeConnector('bot-1'));
      registry.register(makeConnector('bot-2'));
      expect(registry.listAll()).toHaveLength(2);
    });
  });

  describe('unregister', () => {
    it('removes a registered connector', () => {
      registry.register(makeConnector('bot-1'));
      registry.unregister('bot-1');
      expect(registry.get('bot-1')).toBeUndefined();
    });

    it('is a no-op when the connector does not exist', () => {
      expect(() => registry.unregister('nonexistent')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // get / getByType / listAll
  // -------------------------------------------------------------------------

  describe('get', () => {
    it('returns undefined for an unknown name', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });
  });

  describe('getByType', () => {
    it('returns only connectors of the requested type', () => {
      registry.register(makeConnector('tg-1', 'telegram'));
      registry.register(makeConnector('tg-2', 'telegram'));
      registry.register(makeConnector('sl-1', 'slack'));

      const telegramConnectors = registry.getByType('telegram');
      expect(telegramConnectors).toHaveLength(2);
      expect(telegramConnectors.every((c) => c.type === 'telegram')).toBe(true);
    });

    it('returns empty array when no connectors of that type exist', () => {
      registry.register(makeConnector('tg-1', 'telegram'));
      expect(registry.getByType('slack')).toHaveLength(0);
    });
  });

  describe('listAll', () => {
    it('returns all connectors', () => {
      registry.register(makeConnector('a'));
      registry.register(makeConnector('b'));
      registry.register(makeConnector('c'));
      expect(registry.listAll()).toHaveLength(3);
    });

    it('returns empty array when nothing is registered', () => {
      expect(registry.listAll()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // startAll
  // -------------------------------------------------------------------------

  describe('startAll', () => {
    it('calls start() on all registered connectors', async () => {
      const c1 = makeConnector('c1');
      const c2 = makeConnector('c2');
      registry.register(c1);
      registry.register(c2);

      await registry.startAll();

      expect(c1.start).toHaveBeenCalledOnce();
      expect(c2.start).toHaveBeenCalledOnce();
    });

    it('is a no-op when no connectors are registered', async () => {
      await expect(registry.startAll()).resolves.toBeUndefined();
    });

    it('throws ChannelError when any connector fails to start', async () => {
      registry.register(makeConnector('good'));
      registry.register(makeConnector('bad', 'telegram', { startFails: true }));

      await expect(registry.startAll()).rejects.toThrow(ChannelError);
    });

    it('reports the count of failed connectors in the error message', async () => {
      registry.register(makeConnector('bad1', 'telegram', { startFails: true }));
      registry.register(makeConnector('bad2', 'slack', { startFails: true }));

      try {
        await registry.startAll();
        expect.fail('should have thrown');
      } catch (e) {
        expect(e).toBeInstanceOf(ChannelError);
        expect((e as ChannelError).message).toContain('2 channel connector');
      }
    });
  });

  // -------------------------------------------------------------------------
  // stopAll
  // -------------------------------------------------------------------------

  describe('stopAll', () => {
    it('calls stop() on all registered connectors', async () => {
      const c1 = makeConnector('c1');
      const c2 = makeConnector('c2');
      registry.register(c1);
      registry.register(c2);

      await registry.stopAll();

      expect(c1.stop).toHaveBeenCalledOnce();
      expect(c2.stop).toHaveBeenCalledOnce();
    });

    it('does not throw when a connector stop() fails', async () => {
      registry.register(makeConnector('bad', 'telegram', { stopFails: true }));
      await expect(registry.stopAll()).resolves.toBeUndefined();
    });

    it('stops all connectors even when some fail', async () => {
      const good = makeConnector('good');
      registry.register(makeConnector('bad', 'telegram', { stopFails: true }));
      registry.register(good);

      await registry.stopAll();

      expect(good.stop).toHaveBeenCalledOnce();
    });

    it('is a no-op when no connectors are registered', async () => {
      await expect(registry.stopAll()).resolves.toBeUndefined();
    });
  });
});
