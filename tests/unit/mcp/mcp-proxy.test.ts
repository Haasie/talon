import { describe, it, expect, beforeEach } from 'vitest';
import pino from 'pino';
import { McpProxy } from '../../../src/mcp/mcp-proxy.js';
import { McpRegistry } from '../../../src/mcp/mcp-registry.js';
import { McpError } from '../../../src/core/errors/error-types.js';
import type { McpToolCall, McpServerConfig } from '../../../src/mcp/mcp-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function testLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeCall(overrides: Partial<McpToolCall> = {}): McpToolCall {
  return {
    requestId: 'req-1',
    serverName: 'filesystem',
    toolName: 'read_file',
    args: { path: '/workspace/hello.txt' },
    ...overrides,
  };
}

function makeConfig(name: string, overrides: Partial<McpServerConfig> = {}): McpServerConfig {
  return {
    name,
    transport: 'stdio',
    command: 'npx',
    args: [`@mcp/${name}`],
    ...overrides,
  };
}

/** Set up a registry with a named server already running. */
async function makeRegistryWithServer(
  name: string,
  configOverrides: Partial<McpServerConfig> = {},
): Promise<McpRegistry> {
  const registry = new McpRegistry(testLogger());
  registry.register(name, makeConfig(name, configOverrides));
  await registry.startAll();
  return registry;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('McpProxy', () => {
  let registry: McpRegistry;
  let proxy: McpProxy;

  beforeEach(async () => {
    registry = await makeRegistryWithServer('filesystem');
    proxy = new McpProxy(registry, testLogger());
  });

  // -------------------------------------------------------------------------
  // handleToolCall — happy path
  // -------------------------------------------------------------------------

  describe('handleToolCall — success', () => {
    it('returns Ok(McpToolResult) for a valid call', async () => {
      const call = makeCall();
      const result = await proxy.handleToolCall(call, ['mcp.filesystem']);

      expect(result.isOk()).toBe(true);
      const toolResult = result._unsafeUnwrap();
      expect(toolResult.requestId).toBe('req-1');
      expect(toolResult.serverName).toBe('filesystem');
      expect(toolResult.toolName).toBe('read_file');
    });

    it('includes durationMs in the result', async () => {
      const result = await proxy.handleToolCall(makeCall(), ['mcp.filesystem']);
      expect(result._unsafeUnwrap().durationMs).toBeGreaterThanOrEqual(0);
    });

    it('echoes the call content in the mock result', async () => {
      const call = makeCall({ args: { path: '/foo/bar.txt' } });
      const result = await proxy.handleToolCall(call, ['mcp.filesystem']);
      const content = result._unsafeUnwrap().content as Record<string, unknown>;
      expect((content.args as Record<string, unknown>).path).toBe('/foo/bar.txt');
    });
  });

  // -------------------------------------------------------------------------
  // handleToolCall — server not registered
  // -------------------------------------------------------------------------

  describe('handleToolCall — server not found', () => {
    it('returns Err(McpError) when the server is not registered', async () => {
      const call = makeCall({ serverName: 'nonexistent' });
      const result = await proxy.handleToolCall(call, ['mcp.nonexistent']);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(McpError);
    });

    it('includes the server name in the error message', async () => {
      const call = makeCall({ serverName: 'nonexistent' });
      const result = await proxy.handleToolCall(call, ['mcp.nonexistent']);
      expect(result._unsafeUnwrapErr().message).toContain('nonexistent');
    });
  });

  // -------------------------------------------------------------------------
  // handleToolCall — server not running
  // -------------------------------------------------------------------------

  describe('handleToolCall — server not running', () => {
    it('returns Err(McpError) when the server is stopped', async () => {
      // Register a server but do not start it.
      const reg = new McpRegistry(testLogger());
      reg.register('stopped-server', makeConfig('stopped-server'));
      const p = new McpProxy(reg, testLogger());

      const result = await p.handleToolCall(
        makeCall({ serverName: 'stopped-server' }),
        ['mcp.stopped-server'],
      );

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('not running');
    });

    it('includes the status in the error message', async () => {
      const reg = new McpRegistry(testLogger());
      reg.register('srv', makeConfig('srv'));
      reg.setStatus('srv', 'error', 'crashed');
      const p = new McpProxy(reg, testLogger());

      const result = await p.handleToolCall(makeCall({ serverName: 'srv' }), ['mcp.srv']);
      expect(result._unsafeUnwrapErr().message).toContain('error');
    });
  });

  // -------------------------------------------------------------------------
  // handleToolCall — capability check
  // -------------------------------------------------------------------------

  describe('handleToolCall — capability check', () => {
    it('returns Err(McpError) when the persona lacks the required capability', async () => {
      const result = await proxy.handleToolCall(makeCall(), []); // no capabilities
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(McpError);
    });

    it('includes the required capability label in the error', async () => {
      const result = await proxy.handleToolCall(makeCall(), []);
      expect(result._unsafeUnwrapErr().message).toContain('mcp.filesystem');
    });

    it('allows call when the persona has the exact required capability', async () => {
      const result = await proxy.handleToolCall(makeCall(), ['mcp.filesystem']);
      expect(result.isOk()).toBe(true);
    });

    it('allows call when the persona has the required capability among others', async () => {
      const result = await proxy.handleToolCall(makeCall(), [
        'fs.read:workspace',
        'mcp.filesystem',
        'net.http:egress',
      ]);
      expect(result.isOk()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // handleToolCall — tool allowlist
  // -------------------------------------------------------------------------

  describe('handleToolCall — tool allowlist', () => {
    it('allows all tools when allowedTools is not configured', async () => {
      const result = await proxy.handleToolCall(
        makeCall({ toolName: 'any_tool' }),
        ['mcp.filesystem'],
      );
      expect(result.isOk()).toBe(true);
    });

    it('allows a tool that exactly matches an allowedTools entry', async () => {
      const reg = await makeRegistryWithServer('fs', {
        allowedTools: ['read_file', 'write_file'],
      });
      const p = new McpProxy(reg, testLogger());

      const result = await p.handleToolCall(
        makeCall({ serverName: 'fs', toolName: 'read_file' }),
        ['mcp.fs'],
      );
      expect(result.isOk()).toBe(true);
    });

    it('allows a tool matching a glob pattern', async () => {
      const reg = await makeRegistryWithServer('fs', {
        allowedTools: ['read_*'],
      });
      const p = new McpProxy(reg, testLogger());

      const result = await p.handleToolCall(
        makeCall({ serverName: 'fs', toolName: 'read_metadata' }),
        ['mcp.fs'],
      );
      expect(result.isOk()).toBe(true);
    });

    it('denies a tool not matching any allowedTools pattern', async () => {
      const reg = await makeRegistryWithServer('fs', {
        allowedTools: ['read_file', 'write_file'],
      });
      const p = new McpProxy(reg, testLogger());

      const result = await p.handleToolCall(
        makeCall({ serverName: 'fs', toolName: 'delete_file' }),
        ['mcp.fs'],
      );
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(McpError);
    });

    it('includes the tool name in the denial error message', async () => {
      const reg = await makeRegistryWithServer('fs', {
        allowedTools: ['read_file'],
      });
      const p = new McpProxy(reg, testLogger());

      const result = await p.handleToolCall(
        makeCall({ serverName: 'fs', toolName: 'dangerous_op' }),
        ['mcp.fs'],
      );
      expect(result._unsafeUnwrapErr().message).toContain('dangerous_op');
    });

    it('allows all tools when allowedTools is an empty array', async () => {
      const reg = await makeRegistryWithServer('fs', { allowedTools: [] });
      const p = new McpProxy(reg, testLogger());

      const result = await p.handleToolCall(
        makeCall({ serverName: 'fs', toolName: 'any_tool' }),
        ['mcp.fs'],
      );
      expect(result.isOk()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // handleToolCall — rate limiting
  // -------------------------------------------------------------------------

  describe('handleToolCall — rate limiting', () => {
    it('allows calls within the rate limit', async () => {
      const reg = await makeRegistryWithServer('limited', {
        rateLimit: { callsPerMinute: 5 },
      });
      const p = new McpProxy(reg, testLogger());
      const call = makeCall({ serverName: 'limited' });

      for (let i = 0; i < 5; i++) {
        const result = await p.handleToolCall(call, ['mcp.limited']);
        expect(result.isOk()).toBe(true);
      }
    });

    it('denies calls that exceed the rate limit', async () => {
      const reg = await makeRegistryWithServer('limited', {
        rateLimit: { callsPerMinute: 2 },
      });
      const p = new McpProxy(reg, testLogger());
      const call = makeCall({ serverName: 'limited' });

      // Use up all tokens.
      await p.handleToolCall(call, ['mcp.limited']);
      await p.handleToolCall(call, ['mcp.limited']);

      // This should be rate-limited.
      const result = await p.handleToolCall(call, ['mcp.limited']);
      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(McpError);
      expect(result._unsafeUnwrapErr().message).toContain('Rate limit');
    });

    it('rate limit error includes the server name', async () => {
      const reg = await makeRegistryWithServer('throttled', {
        rateLimit: { callsPerMinute: 1 },
      });
      const p = new McpProxy(reg, testLogger());
      const call = makeCall({ serverName: 'throttled' });

      await p.handleToolCall(call, ['mcp.throttled']); // consume token
      const result = await p.handleToolCall(call, ['mcp.throttled']);
      expect(result._unsafeUnwrapErr().message).toContain('throttled');
    });

    it('uses a default rate limit when none is configured', async () => {
      // Server with no rateLimit — default is 60/min, so first call should succeed.
      const result = await proxy.handleToolCall(makeCall(), ['mcp.filesystem']);
      expect(result.isOk()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // buildAllowedServers
  // -------------------------------------------------------------------------

  describe('buildAllowedServers', () => {
    const configs: McpServerConfig[] = [
      makeConfig('filesystem'),
      makeConfig('github'),
      makeConfig('slack'),
    ];

    it('returns only servers for which the persona has capabilities', () => {
      const result = proxy.buildAllowedServers(
        ['mcp.filesystem', 'mcp.github'],
        configs,
      );
      expect(result).toHaveLength(2);
      expect(result.map((s) => s.name)).toContain('filesystem');
      expect(result.map((s) => s.name)).toContain('github');
    });

    it('returns an empty array when the persona has no MCP capabilities', () => {
      const result = proxy.buildAllowedServers([], configs);
      expect(result).toHaveLength(0);
    });

    it('returns all servers when the persona has all required capabilities', () => {
      const result = proxy.buildAllowedServers(
        ['mcp.filesystem', 'mcp.github', 'mcp.slack'],
        configs,
      );
      expect(result).toHaveLength(3);
    });

    it('returns an empty array when the server list is empty', () => {
      const result = proxy.buildAllowedServers(['mcp.filesystem'], []);
      expect(result).toHaveLength(0);
    });

    it('ignores non-MCP capabilities', () => {
      const result = proxy.buildAllowedServers(
        ['fs.read:workspace', 'net.http:egress', 'mcp.github'],
        configs,
      );
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('github');
    });
  });

  // -------------------------------------------------------------------------
  // Error handling — McpError code
  // -------------------------------------------------------------------------

  describe('error code', () => {
    it('all errors carry the MCP_ERROR code', async () => {
      const result = await proxy.handleToolCall(
        makeCall({ serverName: 'missing' }),
        ['mcp.missing'],
      );
      expect(result._unsafeUnwrapErr().code).toBe('MCP_ERROR');
    });
  });
});
