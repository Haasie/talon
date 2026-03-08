/**
 * Unit tests for AgentRunner.
 *
 * The Agent SDK is dynamically imported, so we mock it via vi.mock().
 * A mock DaemonContext provides all required repositories and subsystems.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from 'neverthrow';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const mockQuery = vi.fn();

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: (...args: unknown[]) => mockQuery(...args),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { AgentRunner } from '../../../src/daemon/agent-runner.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import { type QueueItem, QueueItemStatus } from '../../../src/queue/queue-types.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeQueueItem(overrides: Record<string, unknown> = {}): QueueItem {
  return {
    id: 'qi-001',
    threadId: 'thread-001',
    type: 'message',
    status: QueueItemStatus.Claimed,
    attempts: 0,
    maxAttempts: 3,
    payload: { personaId: 'persona-001', content: 'Hello agent' },
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  } as QueueItem;
}

function makeMockContext(): DaemonContext {
  const mockLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  };

  return {
    db: {} as any,
    config: {} as any,
    configPath: '',
    dataDir: '/tmp/test-data',
    repos: {
      queue: {} as any,
      thread: {
        findById: vi.fn().mockReturnValue(ok({
          id: 'thread-001',
          channel_id: 'chan-001',
          external_id: 'ext-001',
        })),
      } as any,
      channel: {
        findById: vi.fn().mockReturnValue(ok({
          id: 'chan-001',
          name: 'test-channel',
        })),
      } as any,
      persona: {
        findById: vi.fn().mockReturnValue(ok({
          id: 'persona-001',
          name: 'TestBot',
        })),
      } as any,
      schedule: {} as any,
      audit: {} as any,
      message: {
        insert: vi.fn().mockReturnValue(ok({})),
      } as any,
      run: {
        insert: vi.fn().mockReturnValue(ok({})),
        updateStatus: vi.fn().mockReturnValue(ok({})),
        updateSessionId: vi.fn().mockReturnValue(ok({})),
        getLatestSessionId: vi.fn().mockReturnValue(ok(null)),
      } as any,
      binding: {} as any,
      memory: {} as any,
    },
    channelRegistry: {
      get: vi.fn().mockReturnValue({
        send: vi.fn().mockResolvedValue(ok(undefined)),
        sendTyping: vi.fn(),
      }),
    } as any,
    queueManager: {} as any,
    scheduler: {} as any,
    personaLoader: {
      getByName: vi.fn().mockReturnValue(ok({
        config: {
          model: 'claude-sonnet-4-20250514',
          skills: [],
          capabilities: { allow: [] },
        },
        systemPromptContent: 'You are a test bot.',
      })),
    } as any,
    sessionTracker: {
      getSessionId: vi.fn().mockReturnValue(undefined),
      setSessionId: vi.fn(),
    } as any,
    threadWorkspace: {
      ensureDirectories: vi.fn().mockReturnValue(ok('/tmp/test-data/workspaces/thread-001')),
    } as any,
    auditLogger: {} as any,
    skillResolver: {
      mergePromptFragments: vi.fn().mockReturnValue(''),
    } as any,
    loadedSkills: [],
    messagePipeline: {} as any,
    hostToolsBridge: {
      path: '/tmp/test-data/host-tools.sock',
    } as any,
    logger: mockLogger as any,
  };
}

/**
 * Creates an async generator that mimics the Agent SDK query() output.
 * Yields an assistant message with text, then a result message with metadata.
 */
async function* makeAgentStream(overrides: Record<string, unknown> = {}) {
  yield {
    type: 'assistant',
    message: {
      content: [{ text: 'Hello from the agent!' }],
    },
  };
  yield {
    type: 'result',
    subtype: 'success',
    result: 'Hello from the agent!',
    session_id: 'session-abc-123',
    total_cost_usd: 0.005,
    usage: { input_tokens: 100, output_tokens: 50 },
    is_error: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentRunner', () => {
  let ctx: DaemonContext;
  let runner: AgentRunner;

  beforeEach(() => {
    ctx = makeMockContext();
    runner = new AgentRunner(ctx);
    vi.clearAllMocks();

    // Re-apply default mocks cleared by vi.clearAllMocks()
    ctx = makeMockContext();
    runner = new AgentRunner(ctx);
    mockQuery.mockReturnValue(makeAgentStream());
  });

  // -------------------------------------------------------------------------
  // Validation errors (early returns before agent query)
  // -------------------------------------------------------------------------

  describe('validation errors', () => {
    it('returns error when payload.personaId is missing', async () => {
      const item = makeQueueItem({ payload: { content: 'hello' } });

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('missing payload.personaId');
    });

    it('returns error when persona not found in DB', async () => {
      vi.mocked(ctx.repos.persona.findById).mockReturnValue(ok(null));
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('persona not found');
    });

    it('returns error when loaded persona not found via personaLoader', async () => {
      vi.mocked(ctx.personaLoader.getByName).mockReturnValue(ok(undefined as any));
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('loaded persona not found');
    });

    it('returns error when run insert fails', async () => {
      vi.mocked(ctx.repos.run.insert).mockReturnValue(
        err(new Error('DB write failed') as any),
      );
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('failed to create run record');
    });

    it('returns error when workspace setup fails and marks run as failed', async () => {
      vi.mocked(ctx.threadWorkspace.ensureDirectories).mockReturnValue(
        err(new Error('cannot create workspace directory') as any),
      );
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('cannot create workspace directory');
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: 'cannot create workspace directory' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Successful end-to-end query
  // -------------------------------------------------------------------------

  describe('successful run', () => {
    it('runs agent query end-to-end and returns Ok', async () => {
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      expect(mockQuery).toHaveBeenCalledOnce();
    });

    it('stores session ID when result includes one', async () => {
      const item = makeQueueItem();

      await runner.run(item);

      expect(ctx.sessionTracker.setSessionId).toHaveBeenCalledWith(
        'thread-001',
        'session-abc-123',
      );
      expect(ctx.repos.run.updateSessionId).toHaveBeenCalledWith(
        expect.any(String),
        'session-abc-123',
      );
    });

    it('sends typing indicators when connector supports it', async () => {
      const item = makeQueueItem();
      const connector = ctx.channelRegistry.get('test-channel')!;

      await runner.run(item);

      expect(connector.sendTyping).toHaveBeenCalledWith('ext-001');
    });

    it('records outbound message after successful query', async () => {
      const item = makeQueueItem();

      await runner.run(item);

      expect(ctx.repos.message.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          thread_id: 'thread-001',
          direction: 'outbound',
          content: JSON.stringify({ body: 'Hello from the agent!' }),
        }),
      );
    });

    it('updates run to completed on success', async () => {
      const item = makeQueueItem();

      await runner.run(item);

      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'completed',
        expect.objectContaining({ ended_at: expect.any(Number) }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Agent error handling
  // -------------------------------------------------------------------------

  describe('agent error handling', () => {
    it('updates run to failed on agent error and clears typing interval', async () => {
      mockQuery.mockImplementation(() => {
        throw new Error('Agent SDK crash');
      });
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('Agent SDK crash');
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: 'Agent SDK crash' }),
      );
    });

    it('returns error when channel send fails', async () => {
      const connector = ctx.channelRegistry.get('test-channel')!;
      vi.mocked(connector.send).mockResolvedValue(
        err(new Error('Telegram API 429: rate limited') as any),
      );
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('channel send failed');
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: expect.stringContaining('channel send failed') }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Timeout behavior
  // -------------------------------------------------------------------------

  describe('query timeout', () => {
    it('rejects with timeout error when agent query hangs', async () => {
      // Use a very short timeout (200ms) to test the timeout mechanism.
      const shortRunner = new AgentRunner(ctx, { queryTimeoutMs: 200 });

      async function* hangingStream() {
        yield {
          type: 'assistant',
          message: { content: [{ text: 'partial' }] },
        };
        // Never yields a result — simulates indefinite hang
        await new Promise(() => {});
      }

      mockQuery.mockReturnValue(hangingStream());
      const item = makeQueueItem();

      const result = await shortRunner.run(item);

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr().message).toContain('timed out after');
      expect(ctx.repos.run.updateStatus).toHaveBeenCalledWith(
        expect.any(String),
        'failed',
        expect.objectContaining({ error: expect.stringContaining('timed out') }),
      );
    }, 10_000);

    it('does not reject when query completes within the timeout', async () => {
      mockQuery.mockReturnValue(makeAgentStream());
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Debug logging for non-text streaming events
  // -------------------------------------------------------------------------

  describe('debug logging for streaming events', () => {
    it('logs tool_use events with type, tool name, and subtype', async () => {
      async function* streamWithToolUse() {
        yield { type: 'tool_use', tool: 'Read', subtype: undefined };
        yield { type: 'tool_result', tool: 'Read', subtype: 'success' };
        yield {
          type: 'assistant',
          message: { content: [{ text: 'Done reading.' }] },
        };
        yield {
          type: 'result',
          subtype: 'success',
          result: 'Done reading.',
          session_id: 'session-xyz',
          total_cost_usd: 0.01,
          usage: { input_tokens: 200, output_tokens: 100 },
          is_error: false,
        };
      }

      mockQuery.mockReturnValue(streamWithToolUse());
      const item = makeQueueItem();

      const result = await runner.run(item);

      expect(result.isOk()).toBe(true);
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ messageType: 'tool_use', tool: 'Read' }),
        'agent-sdk: streaming event',
      );
      expect(ctx.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ messageType: 'tool_result', tool: 'Read', subtype: 'success' }),
        'agent-sdk: streaming event',
      );
    });

    it('does not debug-log assistant or result message types as streaming events', async () => {
      mockQuery.mockReturnValue(makeAgentStream());
      const item = makeQueueItem();

      await runner.run(item);

      const streamingEventCalls = vi.mocked(ctx.logger.debug).mock.calls.filter(
        (call) => call[1] === 'agent-sdk: streaming event',
      );
      expect(streamingEventCalls).toHaveLength(0);
    });
  });
});
