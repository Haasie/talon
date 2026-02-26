/**
 * Unit tests for ToolRegistry.
 *
 * Tests cover: register, unregister, get, listAll, listByCapability,
 * listByLocation, and edge cases (empty registry, duplicate registration,
 * unregister of non-existent tool).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../../src/tools/tool-registry.js';
import type { ToolManifest } from '../../../src/tools/tool-types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<ToolManifest> = {}): ToolManifest {
  return {
    name: 'test.tool:default',
    description: 'A test tool',
    capabilities: ['fs.read:workspace'],
    executionLocation: 'host',
    ...overrides,
  };
}

const channelSendManifest: ToolManifest = {
  name: 'channel.send',
  description: 'Send a message to a channel',
  capabilities: ['channel.send:telegram'],
  executionLocation: 'host',
};

const httpProxyManifest: ToolManifest = {
  name: 'net.http',
  description: 'Proxy outbound HTTP requests',
  capabilities: ['net.http:egress'],
  executionLocation: 'host',
};

const memoryReadManifest: ToolManifest = {
  name: 'memory.read',
  description: 'Read from memory store',
  capabilities: ['memory.read:thread', 'fs.read:workspace'],
  executionLocation: 'host',
};

const sandboxTool: ToolManifest = {
  name: 'sandbox.exec',
  description: 'Execute a command in the sandbox',
  capabilities: ['exec.run:sandbox'],
  executionLocation: 'sandbox',
};

const mcpTool: ToolManifest = {
  name: 'mcp.search',
  description: 'Web search via MCP',
  capabilities: ['net.http:egress'],
  executionLocation: 'mcp',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRegistry(...manifests: ToolManifest[]): ToolRegistry {
  const registry = new ToolRegistry();
  for (const m of manifests) {
    registry.register(m);
  }
  return registry;
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('ToolRegistry — initial state', () => {
  it('listAll() returns empty array on a new registry', () => {
    const registry = new ToolRegistry();
    expect(registry.listAll()).toEqual([]);
  });

  it('get() returns undefined for any name on a new registry', () => {
    const registry = new ToolRegistry();
    expect(registry.get('channel.send')).toBeUndefined();
  });

  it('listByCapability() returns empty array on a new registry', () => {
    const registry = new ToolRegistry();
    expect(registry.listByCapability('fs.read:workspace')).toEqual([]);
  });

  it('listByLocation() returns empty array on a new registry', () => {
    const registry = new ToolRegistry();
    expect(registry.listByLocation('host')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// register()
// ---------------------------------------------------------------------------

describe('ToolRegistry.register()', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  it('makes the tool retrievable via get()', () => {
    registry.register(channelSendManifest);
    expect(registry.get('channel.send')).toEqual(channelSendManifest);
  });

  it('makes the tool appear in listAll()', () => {
    registry.register(channelSendManifest);
    expect(registry.listAll()).toContain(channelSendManifest);
  });

  it('increments listAll() length', () => {
    registry.register(channelSendManifest);
    registry.register(httpProxyManifest);
    expect(registry.listAll()).toHaveLength(2);
  });

  it('replaces existing manifest on duplicate name', () => {
    const original = makeManifest({ name: 'tool.a', description: 'Original' });
    const replacement = makeManifest({ name: 'tool.a', description: 'Replaced' });

    registry.register(original);
    registry.register(replacement);

    expect(registry.get('tool.a')?.description).toBe('Replaced');
    expect(registry.listAll()).toHaveLength(1);
  });

  it('stores parameterSchema when provided', () => {
    const schema = { type: 'object', properties: { url: { type: 'string' } } };
    const manifest = makeManifest({ name: 'tool.x', parameterSchema: schema });
    registry.register(manifest);
    expect(registry.get('tool.x')?.parameterSchema).toEqual(schema);
  });

  it('stores multiple tools independently', () => {
    registry.register(channelSendManifest);
    registry.register(httpProxyManifest);
    registry.register(memoryReadManifest);

    expect(registry.get('channel.send')).toEqual(channelSendManifest);
    expect(registry.get('net.http')).toEqual(httpProxyManifest);
    expect(registry.get('memory.read')).toEqual(memoryReadManifest);
  });
});

// ---------------------------------------------------------------------------
// unregister()
// ---------------------------------------------------------------------------

describe('ToolRegistry.unregister()', () => {
  it('removes a registered tool', () => {
    const registry = makeRegistry(channelSendManifest);
    registry.unregister('channel.send');
    expect(registry.get('channel.send')).toBeUndefined();
  });

  it('decrements listAll() length', () => {
    const registry = makeRegistry(channelSendManifest, httpProxyManifest);
    registry.unregister('channel.send');
    expect(registry.listAll()).toHaveLength(1);
  });

  it('does not affect other tools', () => {
    const registry = makeRegistry(channelSendManifest, httpProxyManifest);
    registry.unregister('channel.send');
    expect(registry.get('net.http')).toEqual(httpProxyManifest);
  });

  it('is a no-op for a tool that was never registered', () => {
    const registry = makeRegistry(channelSendManifest);
    expect(() => registry.unregister('no.such.tool')).not.toThrow();
    expect(registry.listAll()).toHaveLength(1);
  });

  it('is a no-op on an empty registry', () => {
    const registry = new ToolRegistry();
    expect(() => registry.unregister('ghost')).not.toThrow();
    expect(registry.listAll()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe('ToolRegistry.get()', () => {
  it('returns the correct manifest by name', () => {
    const registry = makeRegistry(channelSendManifest, httpProxyManifest);
    expect(registry.get('net.http')).toEqual(httpProxyManifest);
  });

  it('returns undefined for a name that was never registered', () => {
    const registry = makeRegistry(channelSendManifest);
    expect(registry.get('not.registered')).toBeUndefined();
  });

  it('returns undefined after the tool is unregistered', () => {
    const registry = makeRegistry(channelSendManifest);
    registry.unregister('channel.send');
    expect(registry.get('channel.send')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// listAll()
// ---------------------------------------------------------------------------

describe('ToolRegistry.listAll()', () => {
  it('returns all registered manifests', () => {
    const registry = makeRegistry(channelSendManifest, httpProxyManifest, memoryReadManifest);
    const all = registry.listAll();
    expect(all).toHaveLength(3);
    expect(all).toContain(channelSendManifest);
    expect(all).toContain(httpProxyManifest);
    expect(all).toContain(memoryReadManifest);
  });

  it('returns a snapshot — adding after call does not mutate earlier result', () => {
    const registry = makeRegistry(channelSendManifest);
    const snapshot = registry.listAll();
    registry.register(httpProxyManifest);
    // snapshot was taken before the second register
    expect(snapshot).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// listByCapability()
// ---------------------------------------------------------------------------

describe('ToolRegistry.listByCapability()', () => {
  it('returns tools that include the specified capability', () => {
    const registry = makeRegistry(channelSendManifest, httpProxyManifest, memoryReadManifest);
    const result = registry.listByCapability('memory.read:thread');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(memoryReadManifest);
  });

  it('returns multiple tools when they share a capability', () => {
    const registry = makeRegistry(httpProxyManifest, mcpTool);
    // Both require 'net.http:egress'
    const result = registry.listByCapability('net.http:egress');
    expect(result).toHaveLength(2);
    expect(result).toContain(httpProxyManifest);
    expect(result).toContain(mcpTool);
  });

  it('returns empty array when no tools have the capability', () => {
    const registry = makeRegistry(channelSendManifest);
    expect(registry.listByCapability('db.read:own')).toEqual([]);
  });

  it('returns empty array on an empty registry', () => {
    const registry = new ToolRegistry();
    expect(registry.listByCapability('fs.read:workspace')).toEqual([]);
  });

  it('matches a capability that is not the first in the capabilities array', () => {
    // memoryReadManifest.capabilities = ['memory.read:thread', 'fs.read:workspace']
    const registry = makeRegistry(memoryReadManifest);
    const result = registry.listByCapability('fs.read:workspace');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(memoryReadManifest);
  });

  it('does not match partial capability strings', () => {
    const registry = makeRegistry(channelSendManifest);
    // 'channel.send' is not a full label — should not match 'channel.send:telegram'
    expect(registry.listByCapability('channel.send')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// listByLocation()
// ---------------------------------------------------------------------------

describe('ToolRegistry.listByLocation()', () => {
  it('returns only host tools when filtering by "host"', () => {
    const registry = makeRegistry(channelSendManifest, httpProxyManifest, sandboxTool, mcpTool);
    const result = registry.listByLocation('host');
    expect(result).toHaveLength(2);
    expect(result).toContain(channelSendManifest);
    expect(result).toContain(httpProxyManifest);
  });

  it('returns only sandbox tools when filtering by "sandbox"', () => {
    const registry = makeRegistry(channelSendManifest, sandboxTool, mcpTool);
    const result = registry.listByLocation('sandbox');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(sandboxTool);
  });

  it('returns only mcp tools when filtering by "mcp"', () => {
    const registry = makeRegistry(channelSendManifest, sandboxTool, mcpTool);
    const result = registry.listByLocation('mcp');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(mcpTool);
  });

  it('returns empty array when no tools match the location', () => {
    const registry = makeRegistry(channelSendManifest, httpProxyManifest);
    expect(registry.listByLocation('mcp')).toEqual([]);
  });

  it('returns empty array on an empty registry', () => {
    const registry = new ToolRegistry();
    expect(registry.listByLocation('host')).toEqual([]);
  });

  it('returns all tools when all have the same location', () => {
    const registry = makeRegistry(channelSendManifest, httpProxyManifest, memoryReadManifest);
    expect(registry.listByLocation('host')).toHaveLength(3);
  });
});
