/**
 * Unit tests for ChannelSendHandler.
 *
 * Tests cover:
 *   - Successful message send
 *   - Missing/invalid channelId
 *   - Missing/invalid content
 *   - Channel not found in registry
 *   - Connector send failure
 *   - Optional replyTo field
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import { ChannelSendHandler } from '../../../../src/tools/host-tools/channel-send.js';
import type { ChannelSendArgs, ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import { ChannelError } from '../../../../src/core/errors/error-types.js';
import type { ChannelRegistry } from '../../../../src/channels/channel-registry.js';
import type { ChannelConnector } from '../../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeThreadRepo() {
  return {
    findById: vi.fn().mockReturnValue(ok({ id: 'thread-001', external_id: 'ext-001', channel_id: 'chan-001' })),
  } as any;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeArgs(overrides: Partial<ChannelSendArgs> = {}): ChannelSendArgs {
  return {
    channelId: 'my-telegram',
    content: 'Hello from persona!',
    ...overrides,
  };
}

function makeConnector(sendResult: ReturnType<typeof ok | typeof err> = ok(undefined)): ChannelConnector {
  return {
    type: 'telegram',
    name: 'my-telegram',
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(sendResult),
    format: vi.fn((s: string) => s),
  };
}

function makeRegistry(connector?: ChannelConnector): ChannelRegistry {
  return {
    get: vi.fn().mockReturnValue(connector),
    register: vi.fn(),
    unregister: vi.fn(),
    getByType: vi.fn(),
    listAll: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ChannelRegistry;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(ChannelSendHandler.manifest.name).toBe('channel.send');
  });

  it('has executionLocation set to host', () => {
    expect(ChannelSendHandler.manifest.executionLocation).toBe('host');
  });

  it('declares channel.send:* capability', () => {
    expect(ChannelSendHandler.manifest.capabilities).toContain('channel.send:*');
  });
});

// ---------------------------------------------------------------------------
// Successful execution
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — success', () => {
  it('sends a message and returns success result', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('success');
    expect(result.tool).toBe('channel.send');
    expect(result.requestId).toBe('req-001');
    expect(result.result).toEqual({ channelId: 'my-telegram', sent: true });
  });

  it('calls connector.send with thread-scoped externalThreadId', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    await handler.execute(makeArgs(), makeContext({ threadId: 'thread-xyz' }));

    expect(connector.send).toHaveBeenCalledWith('ext-001', expect.objectContaining({ body: 'Hello from persona!' }));
  });

  it('passes replyTo in the output metadata', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    await handler.execute(makeArgs({ replyTo: 'msg-123' }), makeContext());

    expect(connector.send).toHaveBeenCalledWith(
      'ext-001',
      expect.objectContaining({ metadata: { replyTo: 'msg-123' } }),
    );
  });

  it('uses unknown as requestId when context.requestId is not provided', async () => {
    const connector = makeConnector(ok(undefined));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const context = makeContext();
    delete (context as Partial<ToolExecutionContext>).requestId;
    const result = await handler.execute(makeArgs(), context);

    expect(result.requestId).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// Arg validation failures
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — arg validation', () => {
  it('returns error when channelId is missing', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ channelId: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/channelId is required/);
  });

  it('returns error when channelId is whitespace', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ channelId: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/channelId is required/);
  });

  it('returns error when content is missing', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ content: '' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/content is required/);
  });

  it('returns error when content is whitespace', async () => {
    const registry = makeRegistry();
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ content: '   ' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/content is required/);
  });
});

// ---------------------------------------------------------------------------
// Channel not found
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — channel not found', () => {
  it('returns error when channel is not in registry', async () => {
    const registry = makeRegistry(undefined);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs({ channelId: 'unknown-channel' }), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/not found in registry/);
  });
});

// ---------------------------------------------------------------------------
// Connector send failure
// ---------------------------------------------------------------------------

describe('ChannelSendHandler — connector send failure', () => {
  it('returns error when connector.send returns an Err result', async () => {
    const channelErr = new ChannelError('Telegram API timeout');
    const connector = makeConnector(err(channelErr));
    const registry = makeRegistry(connector);
    const handler = new ChannelSendHandler({ channelRegistry: registry, threadRepository: makeThreadRepo(), logger: makeLogger() });

    const result = await handler.execute(makeArgs(), makeContext());

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/failed to send message/);
    expect(result.error).toMatch(/Telegram API timeout/);
  });
});
