import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';

import { ContextRoller, type ContextRollerDeps } from '../../../src/daemon/context-roller.js';

const mockSummarizerRun = vi.fn();

const makeDeps = (overrides: Partial<ContextRollerDeps> = {}): ContextRollerDeps => ({
  messageRepo: {
    findByThread: vi.fn().mockReturnValue(ok([])),
  } as any,
  memoryRepo: {
    insert: vi.fn().mockReturnValue(ok({})),
  } as any,
  sessionTracker: {
    clearSession: vi.fn(),
  } as any,
  summarizerRun: mockSummarizerRun,
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any,
  thresholdTokens: 80_000,
  recentMessageCount: 10,
  ...overrides,
});

describe('ContextRoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when cacheReadTokens is below threshold', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 50_000);

    expect(deps.messageRepo.findByThread).not.toHaveBeenCalled();
    expect(mockSummarizerRun).not.toHaveBeenCalled();
  });

  it('triggers rotation when cacheReadTokens exceeds threshold', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
      { direction: 'outbound', content: JSON.stringify({ body: 'hi there' }), created_at: 2000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'User said hello',
      data: {
        keyFacts: ['User greeted'],
        openThreads: [],
        summary: 'User said hello',
      },
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 },
    }));

    const deps = makeDeps({
      messageRepo: {
        findByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 90_000);

    expect(deps.messageRepo.findByThread).toHaveBeenCalledWith('thread-1', 10000, 0);
    expect(mockSummarizerRun).toHaveBeenCalled();
    expect(deps.memoryRepo.insert).toHaveBeenCalled();
    expect(deps.sessionTracker.clearSession).toHaveBeenCalledWith('thread-1');
  });

  it('stores summary as memory item with type summary', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Greeting exchange',
      data: {
        keyFacts: ['User name is Ivo'],
        openThreads: ['Deployment pending'],
        summary: 'Brief greeting',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 100_000);

    const insertCalls = (deps.memoryRepo.insert as any).mock.calls;
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);

    const summaryInsert = insertCalls[0][0];
    expect(summaryInsert.thread_id).toBe('thread-1');
    expect(summaryInsert.type).toBe('summary');
    expect(summaryInsert.content).toContain('Brief greeting');
    expect(summaryInsert.content).toContain('User name is Ivo');
    expect(summaryInsert.content).toContain('Deployment pending');
  });

  it('does not clear session if summarizer fails', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(
      err(new Error('API rate limit')),
    );

    const deps = makeDeps({
      messageRepo: {
        findByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 100_000);

    expect(deps.sessionTracker.clearSession).not.toHaveBeenCalled();
  });

  it('handles empty message history gracefully', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 100_000);

    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.clearSession).not.toHaveBeenCalled();
  });

  it('does not clear session if memory insert fails', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
      memoryRepo: {
        insert: vi.fn().mockReturnValue(err(new Error('DB full'))),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 100_000);

    expect(deps.sessionTracker.clearSession).not.toHaveBeenCalled();
  });

  it('handles non-JSON message content gracefully', async () => {
    const messages = [
      { direction: 'inbound', content: 'plain text message', created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 100_000);

    // Should have called summarizer with the plain text content
    const callArgs = mockSummarizerRun.mock.calls[0][1];
    expect(callArgs.transcript).toContain('User: plain text message');
  });
});
