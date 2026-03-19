/**
 * ContextRoller — manages automatic session rotation when context usage
 * approaches the threshold.
 *
 * After each agent run, the caller passes the cacheReadTokens count.
 * If it exceeds the configured threshold, the roller:
 *   1. Reconstructs the transcript from the messages table
 *   2. Calls the session-summarizer sub-agent directly
 *   3. Stores the summary as memory items (type: 'summary')
 *   4. Clears the session so the next run starts fresh
 *
 * The fresh session then picks up the summary via ContextAssembler.
 */

import { randomUUID } from 'node:crypto';
import type { Result } from 'neverthrow';
import type pino from 'pino';
import type { MessageRepository, MessageRow } from '../core/database/repositories/message-repository.js';
import type { MemoryRepository } from '../core/database/repositories/memory-repository.js';
import type { SessionTracker } from '../sandbox/session-tracker.js';
import type { SubAgentResult } from '../subagents/subagent-types.js';
import type { SubAgentError } from '../core/errors/index.js';
import type { ResolvedContextUsage } from '../providers/provider-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum character budget for the transcript sent to the summarizer.
 * ~100K chars ≈ ~25K tokens — well within most model context windows.
 * We take the newest messages first, so recent context is always preserved.
 */
const MAX_TRANSCRIPT_CHARS = 100_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Simplified summarizer function signature for the context roller.
 *
 * The caller (bootstrap) pre-binds the model, system prompt, and services
 * so the roller only needs to provide threadId, personaId, and the transcript.
 */
export type SummarizerRunFn = (
  threadId: string,
  personaId: string,
  input: { transcript: string },
) => Promise<Result<SubAgentResult, SubAgentError>>;

export interface ContextRollerDeps {
  messageRepo: Pick<MessageRepository, 'findLatestByThread'>;
  memoryRepo: Pick<MemoryRepository, 'insert'>;
  sessionTracker: Pick<SessionTracker, 'rotateSession'>;
  /** Pre-bound summarizer function. Model, prompt, and services are captured at bootstrap. */
  summarizerRun: SummarizerRunFn;
  /** Optional resolver for provider-selected summarizer names. */
  resolveSummarizerRun?: (name: string) => SummarizerRunFn | null;
  logger: pino.Logger;
  /** Optional fallback context ratio threshold. */
  thresholdRatio?: number;
}

// ---------------------------------------------------------------------------
// ContextRoller
// ---------------------------------------------------------------------------

export class ContextRoller {
  private readonly deps: ContextRollerDeps;

  constructor(deps: ContextRollerDeps) {
    this.deps = deps;
  }

  /**
   * Check if context usage exceeds the threshold and rotate if needed.
   *
   * Call this after every successful agent run with provider-normalized
   * context usage metrics from the run result.
   */
  async checkAndRotate(
    threadId: string,
    personaId: string,
    contextUsage: ResolvedContextUsage,
    overrideThreshold?: number,
    summarizerName: string = 'session-summarizer',
  ): Promise<void> {
    const threshold = overrideThreshold ?? this.deps.thresholdRatio ?? 0.4;
    if (contextUsage.ratio < threshold) {
      return;
    }

    this.deps.logger.info(
      { threadId, contextUsage, thresholdRatio: threshold },
      'context-roller: threshold exceeded, rotating session based on provider usage',
    );

    // 1. Reconstruct transcript from the most recent messages.
    const messagesResult = this.deps.messageRepo.findLatestByThread(threadId, 10_000);
    if (messagesResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: messagesResult.error.message },
        'context-roller: failed to read messages, skipping rotation',
      );
      return;
    }

    const messages = messagesResult.value;
    if (messages.length === 0) {
      this.deps.logger.warn({ threadId }, 'context-roller: no messages found, skipping rotation');
      return;
    }

    const transcript = this.buildTranscript(messages, MAX_TRANSCRIPT_CHARS);
    const summarizerRun = this.deps.resolveSummarizerRun?.(summarizerName) ?? this.deps.summarizerRun;
    if (!summarizerRun) {
      this.deps.logger.error(
        { threadId, summarizer: summarizerName },
        'context-roller: summarizer not available, keeping current session',
      );
      return;
    }

    // 2. Call pre-bound summarizer (model, prompt, and services captured at bootstrap).
    const summaryResult = await summarizerRun(
      threadId,
      personaId,
      { transcript },
    );

    if (summaryResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: summaryResult.error.message },
        'context-roller: summarization failed, keeping current session',
      );
      return;
    }

    const summary = summaryResult.value;
    const data = summary.data as {
      keyFacts?: string[];
      openThreads?: string[];
      summary?: string;
    } | undefined;

    // 3. Store summary as memory items.
    const summaryContent = [
      data?.summary ?? summary.summary,
      '',
      'Key facts:',
      ...(data?.keyFacts ?? []).map((f) => `- ${f}`),
      '',
      'Open threads:',
      ...(data?.openThreads ?? []).map((t) => `- ${t}`),
    ].join('\n');

    const insertResult = this.deps.memoryRepo.insert({
      id: randomUUID(),
      thread_id: threadId,
      type: 'summary',
      content: summaryContent,
      embedding_ref: null,
      metadata: JSON.stringify({
        source: 'context-roller',
        messageCount: messages.length,
        contextUsage,
        ...(contextUsage.rawMetricName === 'cache_read_input_tokens'
          ? { cacheReadTokens: contextUsage.rawMetric }
          : {}),
        createdAt: new Date().toISOString(),
      }),
    });

    if (insertResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: insertResult.error.message },
        'context-roller: failed to store summary, keeping current session',
      );
      return;
    }

    // 4. Clear session — next run starts fresh.
    this.deps.sessionTracker.rotateSession(threadId);

    this.deps.logger.info(
      { threadId, messageCount: messages.length, summaryLength: summaryContent.length },
      'context-roller: session rotated successfully',
    );
  }

  /**
   * Reconstruct a human-readable transcript from stored messages,
   * capped at `maxChars` characters. Takes the newest messages first
   * so recent context is always preserved.
   */
  private buildTranscript(messages: MessageRow[], maxChars: number): string {
    // Build lines from newest to oldest, stop when budget is exhausted.
    const lines: string[] = [];
    let totalChars = 0;

    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      const role = msg.direction === 'inbound' ? 'User' : 'Assistant';
      let body: string;
      try {
        const parsed = JSON.parse(msg.content);
        body = typeof parsed.body === 'string' ? parsed.body : msg.content;
      } catch {
        body = msg.content;
      }
      const line = `${role}: ${body}`;

      if (totalChars + line.length > maxChars && lines.length > 0) {
        break;
      }
      lines.push(line);
      totalChars += line.length + 1; // +1 for newline
    }

    // Reverse back to chronological order.
    return lines.reverse().join('\n');
  }
}
