import { describe, it, expect, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: JSON.stringify({
      decisions: ['Use Haiku for summarization'],
      openThreads: ['Vector store integration pending'],
      facts: ['User prefers short responses'],
      actionItems: ['Deploy to VM after merge'],
      emotionalContext: 'Focused and productive',
      oneSentenceSummary: 'Discussed sub-agent architecture and token optimization.',
    }),
    usage: { inputTokens: 500, outputTokens: 200 },
  }),
}));

import { run } from '../../../subagents/session-summarizer/index.js';

const makeCtx = () => ({
  threadId: 'thread-1',
  personaId: 'persona-1',
  systemPrompt: 'You are a session summarizer.',
  model: {} as any,
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
    expect(value.data!.decisions).toContain('Use Haiku for summarization');
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

  it('handles non-JSON response from model gracefully', async () => {
    const { generateText } = await import('ai');
    (generateText as any).mockResolvedValueOnce({
      text: 'This is a plain text summary.',
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const result = await run(makeCtx(), { transcript: 'User: test\nAssistant: response' });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().data).toEqual({ rawSummary: 'This is a plain text summary.' });
  });
});
