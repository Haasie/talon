/**
 * Approval gate for tool calls that require operator confirmation.
 *
 * When the policy engine returns `require_approval`, the tool dispatcher
 * routes the request through this gate before execution. The gate sends an
 * approval prompt to the originating channel thread, registers the pending
 * request, and returns a Promise that resolves when the operator responds or
 * the timeout expires.
 *
 * ### In-channel response matching
 *
 * The message pipeline must call `resolveApproval(threadId, responseText)`
 * whenever an inbound message arrives on a thread that has an outstanding
 * approval. The gate matches the text against known approval/denial phrases
 * (case-insensitive) and resolves the waiting Promise accordingly.
 *
 * ### Timeout
 *
 * If no operator response is received within `defaultTimeoutMs` the gate
 * automatically resolves the request as `'timeout'` (treated as denied by
 * the dispatcher).
 *
 * ### Audit logging
 *
 * Every decision (approved / denied / timeout) is recorded in the audit log
 * via `AuditRepository` so the decision trail is preserved even across
 * process restarts.
 */

import type pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import type { ToolCallRequest } from './tool-types.js';
import type { PendingApproval } from './approval-types.js';
import type { ChannelRegistry } from '../channels/channel-registry.js';
import type { AuditRepository } from '../core/database/repositories/audit-repository.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outcome returned by the approval gate after operator interaction.
 *
 * - `approved` — operator confirmed the tool call; proceed with execution
 * - `denied`   — operator rejected the tool call; return error to agent
 * - `timeout`  — no response received within the deadline; treat as denied
 */
export type ApprovalOutcome = 'approved' | 'denied' | 'timeout';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Phrases that count as approval (case-insensitive after trim). */
const APPROVE_PHRASES = new Set(['y', 'yes', 'approve', 'ok']);
/** Phrases that count as denial (case-insensitive after trim). */
const DENY_PHRASES = new Set(['n', 'no', 'deny', 'reject']);

/** Default operator response timeout: 5 minutes. */
const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * Build the approval prompt message body that is sent to the operator.
 *
 * Uses a concise format that is readable across all channel types:
 *   Tool `{toolName}` wants to: {description}
 *   Args: {summary}
 *
 *   Approve? (y/n)
 */
function buildApprovalPrompt(request: ToolCallRequest): string {
  const argSummary = JSON.stringify(request.args);
  return (
    `Tool \`${request.tool}\` wants to execute.\n` +
    `Args: ${argSummary}\n\n` +
    `Approve? (y/n)`
  );
}

// ---------------------------------------------------------------------------
// ApprovalGate
// ---------------------------------------------------------------------------

/**
 * Gate that pauses tool execution pending operator approval.
 *
 * One instance is shared across all active threads. Pending approvals are
 * keyed by `threadId` — only one outstanding approval per thread is
 * supported at a time (aligns with the per-thread FIFO run model).
 */
export class ApprovalGate {
  /** In-flight approvals, keyed by threadId. */
  private readonly pending = new Map<string, PendingApproval>();

  private readonly defaultTimeoutMs: number;

  constructor(
    private readonly deps: {
      channelRegistry: ChannelRegistry;
      auditRepo: AuditRepository;
      logger: pino.Logger;
      defaultTimeoutMs?: number;
    },
  ) {
    this.defaultTimeoutMs = deps.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Request operator approval for a tool call.
   *
   * Steps:
   * 1. Build an approval prompt describing what the tool wants to do.
   * 2. Send it to the originating thread's channel.
   * 3. Register the request in the pending approvals map with a deadline.
   * 4. Wait for the operator to respond via `resolveApproval()`, or for the
   *    timeout to fire.
   * 5. Record the decision in the audit log.
   * 6. Return the outcome.
   *
   * @param request   - The tool call awaiting approval.
   * @param threadId  - Thread ID of the originating conversation.
   * @param channelId - Channel connector name to send the approval prompt to.
   * @returns A Promise that resolves with the operator's decision.
   */
  async requestApproval(
    request: ToolCallRequest,
    threadId: string,
    channelId: string,
  ): Promise<ApprovalOutcome> {
    this.deps.logger.info(
      {
        requestId: request.requestId,
        tool: request.tool,
        threadId,
        channelId,
        runId: request.runId,
        personaId: request.personaId,
      },
      'approval.gate: requesting operator approval',
    );

    // Send the approval prompt to the channel.
    await this.sendApprovalPrompt(request, threadId, channelId);

    // Create the Promise and register the pending approval.
    const outcome = await new Promise<ApprovalOutcome>((resolve) => {
      const deadline = Date.now() + this.defaultTimeoutMs;

      const timer = setTimeout(() => {
        const entry = this.pending.get(threadId);
        if (!entry) return; // already resolved by operator

        this.deps.logger.warn(
          { requestId: request.requestId, tool: request.tool, threadId },
          'approval.gate: timeout — auto-denying',
        );

        this.pending.delete(threadId);
        resolve('timeout');
      }, this.defaultTimeoutMs);

      const pendingApproval: PendingApproval = {
        request,
        channelId,
        threadId,
        resolve,
        deadline,
        timer,
      };

      this.pending.set(threadId, pendingApproval);
    });

    // Record the decision in the audit log.
    this.recordAuditDecision(request, threadId, outcome);

    return outcome;
  }

  /**
   * Called by the message pipeline when an operator responds to an approval
   * prompt. Matches the response to a pending approval by threadId.
   *
   * Recognised approval phrases (case-insensitive, trimmed):
   * - Approve: `y`, `yes`, `approve`, `ok`
   * - Deny:    `n`, `no`, `deny`, `reject`
   *
   * Unrecognised responses are silently ignored (the gate stays pending).
   *
   * @param threadId - The thread where the approval prompt was sent.
   * @param response - The operator's raw response text.
   * @returns `true` if the response matched a pending approval and resolved it;
   *          `false` if there was no pending approval for the thread OR the
   *          response text was not recognised.
   */
  resolveApproval(threadId: string, response: string): boolean {
    const entry = this.pending.get(threadId);
    if (!entry) {
      return false;
    }

    const normalised = response.trim().toLowerCase();

    let outcome: ApprovalOutcome | null = null;
    if (APPROVE_PHRASES.has(normalised)) {
      outcome = 'approved';
    } else if (DENY_PHRASES.has(normalised)) {
      outcome = 'denied';
    }

    if (outcome === null) {
      // Not a recognised response — leave the approval pending.
      this.deps.logger.debug(
        { threadId, response },
        'approval.gate: unrecognised response — approval still pending',
      );
      return false;
    }

    clearTimeout(entry.timer);
    this.pending.delete(threadId);

    this.deps.logger.info(
      {
        requestId: entry.request.requestId,
        tool: entry.request.tool,
        threadId,
        outcome,
      },
      'approval.gate: operator responded',
    );

    entry.resolve(outcome);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Send the approval prompt to the operator via the named channel connector.
   *
   * Errors from the channel send are logged as warnings but do not throw —
   * the caller will still wait for the operator and eventually timeout.
   */
  private async sendApprovalPrompt(
    request: ToolCallRequest,
    threadId: string,
    channelId: string,
  ): Promise<void> {
    const connector = this.deps.channelRegistry.get(channelId);
    if (!connector) {
      this.deps.logger.warn(
        { channelId, threadId, requestId: request.requestId },
        'approval.gate: channel connector not found — approval prompt not sent',
      );
      return;
    }

    const promptBody = buildApprovalPrompt(request);

    const result = await connector.send(threadId, { body: promptBody });
    if (result.isErr()) {
      this.deps.logger.warn(
        { channelId, threadId, requestId: request.requestId, err: result.error },
        'approval.gate: failed to send approval prompt',
      );
    }
  }

  /**
   * Append an audit log entry for the approval decision.
   *
   * Errors are logged but do not propagate — the audit log is best-effort
   * for gate decisions (the outcome is already resolved).
   */
  private recordAuditDecision(
    request: ToolCallRequest,
    threadId: string,
    outcome: ApprovalOutcome,
  ): void {
    const insertResult = this.deps.auditRepo.insert({
      id: uuidv4(),
      run_id: request.runId,
      thread_id: threadId,
      persona_id: request.personaId,
      action: 'approval.decision',
      tool: request.tool,
      request_id: request.requestId,
      details: JSON.stringify({ outcome, args: request.args }),
    });

    if (insertResult.isErr()) {
      this.deps.logger.error(
        {
          requestId: request.requestId,
          tool: request.tool,
          outcome,
          err: insertResult.error,
        },
        'approval.gate: failed to write audit log entry',
      );
    }
  }
}
