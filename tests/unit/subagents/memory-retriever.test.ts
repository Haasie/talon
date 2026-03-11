import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: JSON.stringify({
      ranked: [
        { id: 'mem-2', relevance: 0.95, reason: 'Directly about deployment' },
        { id: 'mem-1', relevance: 0.7, reason: 'Mentions deployment context' },
      ],
    }),
    usage: { inputTokens: 400, outputTokens: 150 },
  }),
}));

import { run } from '../../../subagents/memory-retriever/index.js';

const makeMemoryItem = (id: string, content: string, type = 'fact' as const) => ({
  id,
  thread_id: 'thread-1',
  type,
  content,
  embedding_ref: null,
  metadata: '{}',
  created_at: Date.now(),
  updated_at: Date.now(),
});

const makeCtx = (memories: ReturnType<typeof makeMemoryItem>[] = []) => ({
  threadId: 'thread-1',
  personaId: 'persona-1',
  systemPrompt: 'You are a memory relevance ranking agent.',
  model: {} as any,
  services: {
    memory: {
      findByThread: vi.fn().mockReturnValue({ isErr: () => false, isOk: () => true, value: memories }),
    } as any,
    schedules: {} as any,
    personas: {} as any,
    channels: {} as any,
    threads: {} as any,
    messages: {} as any,
    runs: {} as any,
    queue: {} as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
  },
});

describe('memory-retriever', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns error for empty query', async () => {
    const result = await run(makeCtx(), { query: '' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('empty');
  });

  it('returns error when query is not provided', async () => {
    const result = await run(makeCtx(), {});
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('empty');
  });

  it('returns empty when thread has no memories', async () => {
    const result = await run(makeCtx([]), { query: 'deployment' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('No memories found');
    expect((value.data as any).results).toHaveLength(0);
  });

  it('returns empty when no memories match keywords', async () => {
    const ctx = makeCtx([
      makeMemoryItem('mem-1', 'User prefers dark mode'),
      makeMemoryItem('mem-2', 'Talon runs on VM 10.0.1.95'),
    ]);
    const result = await run(ctx, { query: 'deployment' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('No memories matched');
  });

  it('returns keyword matches directly when count is within threshold', async () => {
    const ctx = makeCtx([
      makeMemoryItem('mem-1', 'Deployed to VM after merge'),
      makeMemoryItem('mem-2', 'User prefers dark mode'),
      makeMemoryItem('mem-3', 'Deployment uses npm run build'),
    ]);
    const result = await run(ctx, { query: 'deploy' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect((value.data as any).results).toHaveLength(2);
    expect((value.data as any).results[0].id).toBe('mem-1');
    expect((value.data as any).results[1].id).toBe('mem-3');
    // No LLM used
    expect(value.usage).toBeUndefined();
  });

  it('uses LLM ranking when candidates exceed threshold', async () => {
    // Create > 5 memories that all match the keyword
    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemoryItem(`mem-${i + 1}`, `Memory entry ${i + 1} about deployment topic`),
    );
    const ctx = makeCtx(memories);
    const result = await run(ctx, { query: 'deployment' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('ranked');
    expect(value.usage).toBeDefined();
    expect(value.usage!.inputTokens).toBe(400);
    // The mock returns mem-2 and mem-1 as ranked results
    expect((value.data as any).results).toHaveLength(2);
    expect((value.data as any).results[0].id).toBe('mem-2');
    expect((value.data as any).results[0].relevance).toBe(0.95);
  });

  it('falls back to keyword results when LLM returns invalid JSON', async () => {
    const { generateText } = await import('ai');
    (generateText as any).mockResolvedValueOnce({
      text: 'Sorry, I cannot rank these memories.',
      usage: { inputTokens: 200, outputTokens: 50 },
    });

    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemoryItem(`mem-${i + 1}`, `Memory about deployment step ${i + 1}`),
    );
    const ctx = makeCtx(memories);
    const result = await run(ctx, { query: 'deployment' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('keyword only');
    expect(value.usage).toBeDefined();
  });

  it('returns error when memory repository fails', async () => {
    const ctx = makeCtx();
    (ctx.services.memory.findByThread as any).mockReturnValue({
      isErr: () => true,
      error: { message: 'DB read failed' },
    });
    const result = await run(ctx, { query: 'test' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Failed to read memory items');
  });

  it('respects topK parameter on keyword path', async () => {
    const memories = Array.from({ length: 3 }, (_, i) =>
      makeMemoryItem(`mem-${i + 1}`, `Something about testing item ${i + 1}`),
    );
    const ctx = makeCtx(memories);
    const result = await run(ctx, { query: 'testing', topK: 2 });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect((value.data as any).results).toHaveLength(2);
  });

  it('falls back when all LLM-ranked IDs are hallucinated', async () => {
    const { generateText } = await import('ai');
    (generateText as any).mockResolvedValueOnce({
      text: JSON.stringify({
        ranked: [
          { id: 'fake-1', relevance: 0.9, reason: 'Does not exist' },
          { id: 'fake-2', relevance: 0.8, reason: 'Also fake' },
        ],
      }),
      usage: { inputTokens: 300, outputTokens: 100 },
    });

    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemoryItem(`mem-${i + 1}`, `Deploy note number ${i + 1}`),
    );
    const ctx = makeCtx(memories);
    const result = await run(ctx, { query: 'deploy' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toContain('keyword only');
    expect((value.data as any).results.length).toBeGreaterThan(0);
    expect(value.usage).toBeDefined();
  });

  it('returns error when generateText throws', async () => {
    const { generateText } = await import('ai');
    (generateText as any).mockRejectedValueOnce(new Error('Network timeout'));

    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemoryItem(`mem-${i + 1}`, `Deploy note number ${i + 1}`),
    );
    const ctx = makeCtx(memories);
    const result = await run(ctx, { query: 'deploy' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Memory retrieval failed');
  });

  it('filters out hallucinated IDs from LLM response', async () => {
    const { generateText } = await import('ai');
    (generateText as any).mockResolvedValueOnce({
      text: JSON.stringify({
        ranked: [
          { id: 'mem-1', relevance: 0.9, reason: 'Relevant' },
          { id: 'hallucinated-id', relevance: 0.8, reason: 'Does not exist' },
          { id: 'mem-3', relevance: 0.7, reason: 'Also relevant' },
        ],
      }),
      usage: { inputTokens: 300, outputTokens: 100 },
    });

    const memories = Array.from({ length: 8 }, (_, i) =>
      makeMemoryItem(`mem-${i + 1}`, `Deploy note number ${i + 1}`),
    );
    const ctx = makeCtx(memories);
    const result = await run(ctx, { query: 'deploy' });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    const resultIds = (value.data as any).results.map((r: any) => r.id);
    expect(resultIds).toContain('mem-1');
    expect(resultIds).toContain('mem-3');
    expect(resultIds).not.toContain('hallucinated-id');
  });
});
