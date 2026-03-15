import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';

import { ContextRoller, type ContextRollerDeps } from '../../../src/daemon/context-roller.js';

const mockSummarizerRun = vi.fn();

const makeDeps = (overrides: Partial<ContextRollerDeps> = {}): ContextRollerDeps => ({
  messageRepo: {
    findLatestByThread: vi.fn().mockReturnValue(ok([])),
  } as any,
  memoryRepo: {
    insert: vi.fn().mockReturnValue(ok({})),
  } as any,
  sessionTracker: {
    rotateSession: vi.fn(),
  } as any,
  summarizerRun: mockSummarizerRun,
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any,
  thresholdRatio: 0.4,
  ...overrides,
});

describe('ContextRoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when context usage is below threshold', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.25,
      inputTokens: 50_000,
      rawMetric: 50_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).not.toHaveBeenCalled();
    expect(mockSummarizerRun).not.toHaveBeenCalled();
  });

  it('triggers rotation when context usage exceeds threshold', async () => {
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
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.45,
      inputTokens: 90_000,
      rawMetric: 90_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).toHaveBeenCalledWith('thread-1', 10000);
    expect(mockSummarizerRun).toHaveBeenCalled();
    expect(deps.memoryRepo.insert).toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
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
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

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
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('handles empty message history gracefully', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
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
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
      memoryRepo: {
        insert: vi.fn().mockReturnValue(err(new Error('DB full'))),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
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
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    // Should have called summarizer with the plain text content
    // New signature: summarizerRun(threadId, personaId, input)
    const callArgs = mockSummarizerRun.mock.calls[0][2];
    expect(callArgs.transcript).toContain('User: plain text message');
  });

  // ---------------------------------------------------------------------------
  // Threshold boundary conditions
  // ---------------------------------------------------------------------------

  it('does nothing when ratio is exactly zero', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0,
      inputTokens: 0,
      rawMetric: 0,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).not.toHaveBeenCalled();
    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('does nothing when ratio is just below threshold (0.399 vs 0.4)', async () => {
    const deps = makeDeps(); // thresholdRatio: 0.4
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.399,
      inputTokens: 79_800,
      rawMetric: 79_800,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).not.toHaveBeenCalled();
    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
  });

  it('triggers rotation when ratio is exactly at threshold (0.4 === 0.4)', async () => {
    // The guard is `ratio < thresholdRatio`, so equal means it DOES trigger.
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'at threshold' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'At-threshold summary',
      data: { keyFacts: [], openThreads: [], summary: 'At-threshold summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.4,
      inputTokens: 80_000,
      rawMetric: 80_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.messageRepo.findLatestByThread).toHaveBeenCalled();
    expect(mockSummarizerRun).toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });

  it('triggers rotation when ratio is 1.0 (fully exhausted context)', async () => {
    const messages = [
      { direction: 'outbound', content: JSON.stringify({ body: 'big response' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Exhausted context summary',
      data: { keyFacts: ['context full'], openThreads: [], summary: 'Exhausted context summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 1.0,
      inputTokens: 200_000,
      rawMetric: 200_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });

  // ---------------------------------------------------------------------------
  // contextUsage edge cases
  // ---------------------------------------------------------------------------

  it('skips cacheReadTokens metadata when rawMetricName is not cache_read_input_tokens', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'total_tokens', // not cache_read_input_tokens
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    const meta = JSON.parse(insertCall.metadata);
    expect(meta).not.toHaveProperty('cacheReadTokens');
    expect(meta.contextUsage.rawMetricName).toBe('total_tokens');
  });

  it('includes cacheReadTokens in metadata when rawMetricName is cache_read_input_tokens', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 75_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    const meta = JSON.parse(insertCall.metadata);
    expect(meta.cacheReadTokens).toBe(75_000);
  });

  it('falls back to summary.summary when data.summary is absent', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      // data is present but has no summary field
      summary: 'Top-level fallback summary',
      data: { keyFacts: ['fact one'], openThreads: ['thread one'] },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    expect(insertCall.content).toContain('Top-level fallback summary');
    expect(insertCall.content).toContain('fact one');
    expect(insertCall.content).toContain('thread one');
  });

  it('falls back gracefully when data is undefined on the summary result', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Bare summary',
      // data is intentionally absent
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    expect(insertCall.content).toContain('Bare summary');
    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });

  it('contextUsage with zero rawMetric still stores correct metadata', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'test' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Summary',
      data: { keyFacts: [], openThreads: [], summary: 'Summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 0,           // zero rawMetric
      rawMetricName: 'cache_read_input_tokens',
    });

    const insertCall = (deps.memoryRepo.insert as any).mock.calls[0][0];
    const meta = JSON.parse(insertCall.metadata);
    // cacheReadTokens is included but is 0 — the branch fires regardless of value
    expect(meta.cacheReadTokens).toBe(0);
    expect(meta.source).toBe('context-roller');
  });

  // ---------------------------------------------------------------------------
  // messageRepo error path
  // ---------------------------------------------------------------------------

  it('does not rotate when messageRepo returns an error', async () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(err(new Error('DB read failed'))),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 100_000,
      rawMetric: 100_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.rotateSession).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread-1' }),
      expect.stringContaining('failed to read messages'),
    );
  });

  // ---------------------------------------------------------------------------
  // buildTranscript: budget truncation
  // ---------------------------------------------------------------------------

  it('truncates transcript when messages exceed the character budget', async () => {
    // Create enough messages to overflow MAX_TRANSCRIPT_CHARS (100_000)
    // Each message body is ~1_000 chars; 120 messages = ~120_000 chars
    const longBody = 'x'.repeat(1_000);
    const messages = Array.from({ length: 120 }, (_, i) => ({
      direction: i % 2 === 0 ? 'inbound' : 'outbound',
      content: JSON.stringify({ body: longBody }),
      created_at: i * 1_000,
    }));

    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Truncated summary',
      data: { keyFacts: [], openThreads: [], summary: 'Truncated summary' },
    }));

    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', {
      ratio: 0.5,
      inputTokens: 200_000,
      rawMetric: 200_000,
      rawMetricName: 'cache_read_input_tokens',
    });

    expect(mockSummarizerRun).toHaveBeenCalled();
    const transcript: string = mockSummarizerRun.mock.calls[0][2].transcript;
    expect(transcript.length).toBeLessThanOrEqual(100_000);
    // Rotation still completes
    expect(deps.sessionTracker.rotateSession).toHaveBeenCalledWith('thread-1');
  });
});
