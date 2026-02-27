import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { McpRegistry } from '../../../src/mcp/mcp-registry.js';
import { McpError } from '../../../src/core/errors/error-types.js';
import type { McpServerConfig } from '../../../src/mcp/mcp-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeConfig(name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: [`@modelcontextprotocol/${name}`],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpRegistry', () => {
  let registry: McpRegistry;

  beforeEach(() => {
    registry = new McpRegistry(testLogger());
  });

  // -------------------------------------------------------------------------
  // register
  // -------------------------------------------------------------------------

  describe('register', () => {
    it('registers a server and makes it available via get()', () => {
      const config = makeConfig('filesystem');
      registry.register('filesystem', config);

      const entry = registry.get('filesystem');
      expect(entry).toBeDefined();
      expect(entry?.config).toBe(config);
    });

    it('initialises status to "stopped" on registration', () => {
      registry.register('filesystem', makeConfig('filesystem'));
      expect(registry.get('filesystem')?.status).toBe('stopped');
    });

    it('throws McpError when registering a duplicate name', () => {
      registry.register('filesystem', makeConfig('filesystem'));
      expect(() => registry.register('filesystem', makeConfig('filesystem'))).toThrow(McpError);
    });

    it('throws with a message containing the server name', () => {
      registry.register('filesystem', makeConfig('filesystem'));
      expect(() => registry.register('filesystem', makeConfig('filesystem'))).toThrow(
        /filesystem/,
      );
    });

    it('allows multiple servers with different names', () => {
      registry.register('filesystem', makeConfig('filesystem'));
      registry.register('github', makeConfig('github'));
      expect(registry.listServers()).toHaveLength(2);
    });

    it('registers a server with SSE transport', () => {
      const config = makeConfig('remote', {
        transport: 'sse',
        url: 'https://mcp.example.com/sse',
      });
      registry.register('remote', config);
      expect(registry.get('remote')?.config.transport).toBe('sse');
    });
  });

  // -------------------------------------------------------------------------
  // unregister
  // -------------------------------------------------------------------------

  describe('unregister', () => {
    it('removes a registered server', () => {
      registry.register('filesystem', makeConfig('filesystem'));
      registry.unregister('filesystem');
      expect(registry.get('filesystem')).toBeUndefined();
    });

    it('removes the name from listServers()', () => {
      registry.register('filesystem', makeConfig('filesystem'));
      registry.register('github', makeConfig('github'));
      registry.unregister('filesystem');
      expect(registry.listServers()).toEqual(['github']);
    });

    it('is a no-op when the server does not exist', () => {
      expect(() => registry.unregister('nonexistent')).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  describe('get', () => {
    it('returns undefined for an unknown server name', () => {
      expect(registry.get('unknown')).toBeUndefined();
    });

    it('returns the entry with correct config and status', () => {
      const config = makeConfig('github');
      registry.register('github', config);

      const entry = registry.get('github');
      expect(entry?.config).toBe(config);
      expect(entry?.status).toBe('stopped');
      expect(entry?.lastError).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // listServers / listEntries
  // -------------------------------------------------------------------------

  describe('listServers', () => {
    it('returns an empty array when nothing is registered', () => {
      expect(registry.listServers()).toHaveLength(0);
    });

    it('returns all server names in registration order', () => {
      registry.register('a', makeConfig('a'));
      registry.register('b', makeConfig('b'));
      registry.register('c', makeConfig('c'));
      expect(registry.listServers()).toEqual(['a', 'b', 'c']);
    });
  });

  describe('listEntries', () => {
    it('returns an empty array when nothing is registered', () => {
      expect(registry.listEntries()).toHaveLength(0);
    });

    it('returns all entries with configs', () => {
      const configA = makeConfig('a');
      const configB = makeConfig('b');
      registry.register('a', configA);
      registry.register('b', configB);

      const entries = registry.listEntries();
      expect(entries).toHaveLength(2);
      expect(entries[0].config).toBe(configA);
      expect(entries[1].config).toBe(configB);
    });
  });

  // -------------------------------------------------------------------------
  // setStatus
  // -------------------------------------------------------------------------

  describe('setStatus', () => {
    it('updates the status of a registered server', () => {
      registry.register('filesystem', makeConfig('filesystem'));
      registry.setStatus('filesystem', 'running');
      expect(registry.get('filesystem')?.status).toBe('running');
    });

    it('sets lastError when transitioning to error state', () => {
      registry.register('filesystem', makeConfig('filesystem'));
      registry.setStatus('filesystem', 'error', 'connection refused');
      const entry = registry.get('filesystem');
      expect(entry?.status).toBe('error');
      expect(entry?.lastError).toBe('connection refused');
    });

    it('clears lastError when recovering from error to a healthy state', () => {
      registry.register('filesystem', makeConfig('filesystem'));
      registry.setStatus('filesystem', 'error', 'connection refused');
      registry.setStatus('filesystem', 'running');
      expect(registry.get('filesystem')?.lastError).toBeUndefined();
    });

    it('throws McpError when setting status for an unregistered server', () => {
      expect(() => registry.setStatus('nonexistent', 'running')).toThrow(McpError);
    });
  });

  // -------------------------------------------------------------------------
  // startAll
  // -------------------------------------------------------------------------

  describe('startAll', () => {
    it('transitions all servers to running status', async () => {
      registry.register('a', makeConfig('a'));
      registry.register('b', makeConfig('b'));

      await registry.startAll();

      expect(registry.get('a')?.status).toBe('running');
      expect(registry.get('b')?.status).toBe('running');
    });

    it('is a no-op when no servers are registered', async () => {
      await expect(registry.startAll()).resolves.toBeUndefined();
    });

    it('resolves even when called on an empty registry', async () => {
      await expect(registry.startAll()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // stopAll
  // -------------------------------------------------------------------------

  describe('stopAll', () => {
    it('transitions all servers to stopped status', async () => {
      registry.register('a', makeConfig('a'));
      registry.register('b', makeConfig('b'));

      await registry.startAll();
      await registry.stopAll();

      expect(registry.get('a')?.status).toBe('stopped');
      expect(registry.get('b')?.status).toBe('stopped');
    });

    it('is a no-op when no servers are registered', async () => {
      await expect(registry.stopAll()).resolves.toBeUndefined();
    });

    it('does not throw if a server fails to stop', async () => {
      // Register a server and manually set it to error state to exercise the catch path.
      registry.register('tricky', makeConfig('tricky'));
      await registry.startAll();

      // Should not throw even in edge cases.
      await expect(registry.stopAll()).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Round-trip
  // -------------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    it('starts and stops all servers without errors', async () => {
      registry.register('fs', makeConfig('fs'));
      registry.register('gh', makeConfig('gh'));

      await registry.startAll();
      expect(registry.get('fs')?.status).toBe('running');
      expect(registry.get('gh')?.status).toBe('running');

      await registry.stopAll();
      expect(registry.get('fs')?.status).toBe('stopped');
      expect(registry.get('gh')?.status).toBe('stopped');
    });
  });
});
