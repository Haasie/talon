/**
 * Shared types for the approval gate subsystem.
 *
 * These types are separated from the ApprovalGate class to allow the message
 * pipeline and other callers to reference them without importing the full gate
 * implementation.
 */

import type { ToolCallRequest } from './tool-types.js';
import type { ApprovalOutcome } from './approval-gate.js';

// ---------------------------------------------------------------------------
// Pending approval
// ---------------------------------------------------------------------------

/**
 * An in-flight approval request that is waiting for an operator response.
 *
 * Stored in the ApprovalGate's internal map keyed by `threadId`.
 * The `resolve` callback drives the Promise returned by `requestApproval()`.
 * The `timer` is the auto-deny timeout; it is cleared when the operator
 * responds before the deadline.
 */
export interface PendingApproval {
  /** Original tool call request that triggered the approval prompt. */
  request: ToolCallRequest;
  /** Channel instance name that should receive the approval prompt. */
  channelId: string;
  /** Thread that originated the tool call. */
  threadId: string;
  /**
   * Resolve function for the Promise returned by `requestApproval()`.
   * Call this with the outcome to unblock the waiting caller.
   */
  resolve: (outcome: ApprovalOutcome) => void;
  /** Unix epoch ms deadline after which the request auto-denies. */
  deadline: number;
  /**
   * Handle for the timer that fires on timeout.
   * Must be cleared via `clearTimeout()` when the operator responds in time.
   */
  timer: ReturnType<typeof setTimeout>;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Configuration knobs for the ApprovalGate.
 *
 * All fields have sane defaults so callers only need to supply the values they
 * want to override.
 */
export interface ApprovalConfig {
  /**
   * How long (in milliseconds) to wait for an operator response before
   * auto-denying.
   *
   * @default 300_000 (5 minutes)
   */
  defaultTimeoutMs: number;
}
