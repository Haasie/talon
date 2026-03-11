import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({
  generateObject: vi.fn().mockResolvedValue({
    object: {
      keyFacts: ['Use Haiku for summarization', 'User prefers short responses'],
      openThreads: ['Vector store integration pending'],
      summary: 'Discussed sub-agent architecture and token optimization.',
    },
    usage: { inputTokens: 500, outputTokens: 200 },
  }),
}));

import { run } from '../../../subagents/session-summarizer/index.js';

const makeCtx = () => ({
  threadId: 'thread-1',
  personaId: 'persona-1',
  systemPrompt: 'You are a session summarizer.',
  model: {} as any,
  maxOutputTokens: 8192,
  services: {
    memory: {} as any,
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

describe('session-summarizer', () => {
  it('returns structured summary from transcript', async () => {
    const result = await run(makeCtx(), {
      transcript: 'User: Hi\nAssistant: Hello!\nUser: Let us use Haiku.\nAssistant: Good idea.',
    });
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.data).toBeDefined();
    expect((value.data as any).keyFacts).toContain('Use Haiku for summarization');
    expect(value.usage).toBeDefined();
    expect(value.usage!.inputTokens).toBe(500);
    expect(value.summary).toBe('Discussed sub-agent architecture and token optimization.');
  });

  it('returns error for empty transcript', async () => {
    const result = await run(makeCtx(), { transcript: '' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('empty');
  });

  it('returns error for whitespace-only transcript', async () => {
    const result = await run(makeCtx(), { transcript: '   ' });
    expect(result.isErr()).toBe(true);
  });

  it('returns error when transcript is not provided', async () => {
    const result = await run(makeCtx(), {});
    expect(result.isErr()).toBe(true);
  });

  it('returns error when generateObject throws', async () => {
    const { generateObject } = await import('ai');
    (generateObject as any).mockRejectedValueOnce(new Error('Schema validation failed'));

    const result = await run(makeCtx(), { transcript: 'User: test\nAssistant: response' });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Session summarization failed');
  });
});
