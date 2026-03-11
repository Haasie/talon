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
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../subagents/subagent-types.js';
import type { SubAgentError } from '../core/errors/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SummarizerRunFn = (
  ctx: SubAgentContext,
  input: SubAgentInput,
) => Promise<Result<SubAgentResult, SubAgentError>>;

export interface ContextRollerDeps {
  messageRepo: Pick<MessageRepository, 'findLatestByThread'>;
  memoryRepo: Pick<MemoryRepository, 'insert'>;
  sessionTracker: Pick<SessionTracker, 'rotateSession'>;
  /** The session-summarizer's run function, called directly (no runner validation). */
  summarizerRun: SummarizerRunFn;
  logger: pino.Logger;
  /** Token count threshold for triggering rotation. Default: 80_000. */
  thresholdTokens: number;
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
   * Call this after every successful agent run with the cacheReadTokens
   * from the run result.
   */
  async checkAndRotate(
    threadId: string,
    personaId: string,
    cacheReadTokens: number,
  ): Promise<void> {
    if (cacheReadTokens < this.deps.thresholdTokens) {
      return;
    }

    this.deps.logger.info(
      { threadId, cacheReadTokens, threshold: this.deps.thresholdTokens },
      'context-roller: threshold exceeded, rotating session',
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

    const transcript = this.buildTranscript(messages);

    // 2. Call session-summarizer directly (bypass runner validation).
    const summaryResult = await this.deps.summarizerRun(
      {
        threadId,
        personaId,
        systemPrompt: 'You are a conversation summarizer. Extract key facts, open threads, and a concise summary.',
        model: {} as any, // Model is resolved by the caller when wiring deps
        maxOutputTokens: 4096,
        rootPaths: [],
        services: {
          memory: this.deps.memoryRepo as any,
          messages: this.deps.messageRepo as any,
          logger: this.deps.logger,
          schedules: {} as any,
          personas: {} as any,
          channels: {} as any,
          threads: {} as any,
          runs: {} as any,
          queue: {} as any,
        },
      },
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
        cacheReadTokens,
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
   * Reconstruct a human-readable transcript from stored messages.
   */
  private buildTranscript(messages: MessageRow[]): string {
    return messages
      .map((msg) => {
        const role = msg.direction === 'inbound' ? 'User' : 'Assistant';
        let body: string;
        try {
          const parsed = JSON.parse(msg.content);
          body = typeof parsed.body === 'string' ? parsed.body : msg.content;
        } catch {
          body = msg.content;
        }
        return `${role}: ${body}`;
      })
      .join('\n');
  }
}
