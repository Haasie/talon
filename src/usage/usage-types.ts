/**
 * Token usage and budget type definitions for the usage tracking subsystem.
 */

// ---------------------------------------------------------------------------
// Token usage types
// ---------------------------------------------------------------------------

/** Raw token counts and cost for a single agent run. */
export interface TokenUsage {
  /** Number of input (prompt) tokens consumed. */
  inputTokens: number;
  /** Number of output (completion) tokens consumed. */
  outputTokens: number;
  /** Number of tokens read from the prompt cache. */
  cacheReadTokens: number;
  /** Number of tokens written to the prompt cache. */
  cacheWriteTokens: number;
  /** Estimated cost in US dollars for this run. */
  costUsd: number;
}

/** Aggregated token usage across one or more runs. */
export interface TokenUsageSummary {
  /** Sum of input tokens across all matching runs. */
  totalInputTokens: number;
  /** Sum of output tokens across all matching runs. */
  totalOutputTokens: number;
  /** Sum of cache-read tokens across all matching runs. */
  totalCacheReadTokens: number;
  /** Sum of cache-write tokens across all matching runs. */
  totalCacheWriteTokens: number;
  /** Sum of cost in USD across all matching runs. */
  totalCostUsd: number;
  /** Number of completed runs included in the aggregate. */
  runCount: number;
}

// ---------------------------------------------------------------------------
// Budget types
// ---------------------------------------------------------------------------

/** Configuration for a per-persona budget check. */
export interface BudgetConfig {
  /** Maximum total tokens (input + output) allowed within the period. */
  maxTokens: number;
  /** Budget period start timestamp (Unix epoch milliseconds). */
  periodStart: number;
  /** Budget period end timestamp (Unix epoch milliseconds). Defaults to now. */
  periodEnd?: number;
  /**
   * Percentage of maxTokens at which to trigger a warning.
   * Defaults to 80.
   */
  warnThresholdPercent?: number;
}

/** Result of a budget check for a persona. */
export interface BudgetStatus {
  /** True when total usage is at or below maxTokens. */
  withinBudget: boolean;
  /** Percentage of the budget already consumed (0–100+). */
  percentUsed: number;
  /** Total tokens (input + output) consumed in the period. */
  totalTokensUsed: number;
  /** Tokens remaining before the budget is exhausted. Negative when over budget. */
  remainingTokens: number;
  /** True when usage exceeds warnThresholdPercent but is still within budget. */
  warningTriggered: boolean;
}
