import { generateText } from 'ai';
import { ok, err } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../src/subagents/subagent-types.js';
import { SubAgentError } from '../../src/core/errors/index.js';
import type { Result } from 'neverthrow';

export async function run(
  ctx: SubAgentContext,
  input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const transcript = typeof input.transcript === 'string' ? input.transcript : '';

  if (!transcript.trim()) {
    return err(new SubAgentError('Cannot summarize empty transcript'));
  }

  try {
    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt: `Summarize this conversation transcript:\n\n${transcript}`,
      maxOutputTokens: 4096,
    });

    // Parse the structured response, guarding against non-object JSON values.
    let data: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        data = parsed as Record<string, unknown>;
      } else {
        data = { rawSummary: text };
      }
    } catch {
      data = { rawSummary: text };
    }

    return ok({
      summary: typeof data.oneSentenceSummary === 'string'
        ? data.oneSentenceSummary
        : 'Session summarized successfully',
      data,
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
