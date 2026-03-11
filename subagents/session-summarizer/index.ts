import { generateObject } from 'ai';
import { z } from 'zod';
import { ok, err } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../src/subagents/subagent-types.js';
import { SubAgentError } from '../../src/core/errors/index.js';
import type { Result } from 'neverthrow';

const SummarySchema = z.object({
  keyFacts: z.array(z.string()).describe('Key facts and decisions from the conversation'),
  openThreads: z.array(z.string()).describe('Unresolved topics or pending items'),
  summary: z.string().describe('Concise narrative summary of the conversation'),
});

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const transcript = typeof input.transcript === 'string' ? input.transcript : '';

  if (!transcript.trim()) {
    return err(new SubAgentError('Cannot summarize empty transcript'));
  }

  try {
    const { object, usage } = await generateObject({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Summarize this conversation transcript:\n\n${transcript}`,
      schema: SummarySchema,
      maxOutputTokens: ctx.maxOutputTokens,
    });

    return ok({
      summary: object.summary || 'Session summarized successfully',
      data: object as unknown as Record<string, unknown>,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    return err(new SubAgentError(
      `Session summarization failed: ${error instanceof Error ? error.message : String(error)}`,
    ));
  }
}
