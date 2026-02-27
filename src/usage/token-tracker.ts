/**
 * Token usage tracking service.
 *
 * Records per-run token consumption and provides aggregation queries and
 * optional budget-limit checks. All database operations are synchronous
 * (better-sqlite3) and wrapped in neverthrow Result types.
 */

import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { DbError } from '../core/errors/index.js';
import type { RunRepository } from '../core/database/repositories/run-repository.js';
import type { TokenUsage, TokenUsageSummary, BudgetConfig, BudgetStatus } from './usage-types.js';

/** Default warning threshold (80 %). */
const DEFAULT_WARN_THRESHOLD_PERCENT = 80;

/**
 * Tracks token usage per run and exposes aggregation and budget-check helpers.
 */
export class TokenTracker {
  constructor(
    private readonly deps: {
      runRepo: RunRepository;
      logger: pino.Logger;
    },
  ) {}

  // ---------------------------------------------------------------------------
  // Write path
  // ---------------------------------------------------------------------------

  /**
   * Records token usage for a completed run.
   *
   * Updates the run's token fields in the database. On success returns Ok(void);
   * on database failure returns Err(DbError).
   *
   * @param runId - Primary key of the run to update.
   * @param usage - Token counts and cost to persist.
   */
  recordUsage(runId: string, usage: TokenUsage): Result<void, DbError> {
    const result = this.deps.runRepo.updateTokens(runId, {
      input_tokens: usage.inputTokens,
      output_tokens: usage.outputTokens,
      cache_read_tokens: usage.cacheReadTokens,
      cache_write_tokens: usage.cacheWriteTokens,
      cost_usd: usage.costUsd,
    });

    if (result.isErr()) {
      this.deps.logger.error({ runId, err: result.error }, 'token-tracker: failed to record usage');
      return err(result.error);
    }

    this.deps.logger.debug(
      { runId, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.costUsd },
      'token-tracker: recorded usage',
    );
    return ok(undefined);
  }

  // ---------------------------------------------------------------------------
  // Read / aggregation path
  // ---------------------------------------------------------------------------

  /**
   * Returns aggregate token usage for all completed runs belonging to a persona
   * within an optional time range.
   *
   * @param personaId - Persona primary key.
   * @param since - Optional lower bound (Unix epoch ms, inclusive).
   * @param until - Optional upper bound (Unix epoch ms, inclusive).
   */
  getUsageByPersona(personaId: string, since?: number, until?: number): Result<TokenUsageSummary, DbError> {
    const result = this.deps.runRepo.aggregateByPersona(personaId, since, until);
    if (result.isErr()) {
      this.deps.logger.error({ personaId, err: result.error }, 'token-tracker: aggregateByPersona failed');
      return err(result.error);
    }
    return ok(this._toSummary(result.value));
  }

  /**
   * Returns aggregate token usage for all completed runs in a thread within an
   * optional time range.
   *
   * @param threadId - Thread primary key.
   * @param since - Optional lower bound (Unix epoch ms, inclusive).
   * @param until - Optional upper bound (Unix epoch ms, inclusive).
   */
  getUsageByThread(threadId: string, since?: number, until?: number): Result<TokenUsageSummary, DbError> {
    const result = this.deps.runRepo.aggregateByThread(threadId, since, until);
    if (result.isErr()) {
      this.deps.logger.error({ threadId, err: result.error }, 'token-tracker: aggregateByThread failed');
      return err(result.error);
    }
    return ok(this._toSummary(result.value));
  }

  /**
   * Returns aggregate token usage for all completed runs within a time period
   * across all personas and threads.
   *
   * @param since - Lower bound (Unix epoch ms, inclusive).
   * @param until - Optional upper bound (Unix epoch ms, inclusive). Defaults to now.
   */
  getUsageByPeriod(since: number, until?: number): Result<TokenUsageSummary, DbError> {
    const result = this.deps.runRepo.aggregateByPeriod(since, until);
    if (result.isErr()) {
      this.deps.logger.error({ since, until, err: result.error }, 'token-tracker: aggregateByPeriod failed');
      return err(result.error);
    }
    return ok(this._toSummary(result.value));
  }

  // ---------------------------------------------------------------------------
  // Budget checks
  // ---------------------------------------------------------------------------

  /**
   * Checks whether a persona has exceeded its configured budget limit.
   *
   * Uses `input_tokens + output_tokens` as the "total tokens" metric for
   * budget purposes (cache tokens are not counted against the quota).
   *
   * @param personaId - Persona primary key.
   * @param budgetConfig - Budget parameters including maxTokens and period.
   */
  checkBudget(personaId: string, budgetConfig: BudgetConfig): Result<BudgetStatus, DbError> {
    const until = budgetConfig.periodEnd ?? Date.now();
    const warnThreshold = budgetConfig.warnThresholdPercent ?? DEFAULT_WARN_THRESHOLD_PERCENT;

    const result = this.deps.runRepo.aggregateByPersona(personaId, budgetConfig.periodStart, until);
    if (result.isErr()) {
      this.deps.logger.error({ personaId, err: result.error }, 'token-tracker: checkBudget aggregation failed');
      return err(result.error);
    }

    const row = result.value;
    const totalTokensUsed = row.total_input_tokens + row.total_output_tokens;
    const remainingTokens = budgetConfig.maxTokens - totalTokensUsed;
    const percentUsed = budgetConfig.maxTokens > 0 ? (totalTokensUsed / budgetConfig.maxTokens) * 100 : 0;
    const withinBudget = totalTokensUsed <= budgetConfig.maxTokens;
    const warningTriggered = withinBudget && percentUsed >= warnThreshold;

    const status: BudgetStatus = {
      withinBudget,
      percentUsed,
      totalTokensUsed,
      remainingTokens,
      warningTriggered,
    };

    if (!withinBudget) {
      this.deps.logger.warn(
        { personaId, totalTokensUsed, maxTokens: budgetConfig.maxTokens, percentUsed },
        'token-tracker: persona has exceeded budget',
      );
    } else if (warningTriggered) {
      this.deps.logger.warn(
        { personaId, percentUsed, warnThreshold },
        'token-tracker: persona is approaching budget limit',
      );
    }

    return ok(status);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Converts a raw TokenAggregateRow into the public TokenUsageSummary shape. */
  private _toSummary(row: {
    total_input_tokens: number;
    total_output_tokens: number;
    total_cache_read_tokens: number;
    total_cache_write_tokens: number;
    total_cost_usd: number;
    run_count: number;
  }): TokenUsageSummary {
    return {
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      totalCacheReadTokens: row.total_cache_read_tokens,
      totalCacheWriteTokens: row.total_cache_write_tokens,
      totalCostUsd: row.total_cost_usd,
      runCount: row.run_count,
    };
  }
}
