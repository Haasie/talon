/**
 * Approval gate for tool calls that require operator confirmation.
 *
 * When the policy engine returns `require_approval`, the tool dispatcher
 * routes the request through this gate before execution. The gate prompts
 * the operator via the channel that originated the request and waits for
 * an explicit allow/deny response.
 *
 * @remarks
 * This is a placeholder implementation. Full in-channel approval prompting
 * (sending approval requests to Telegram/Slack/etc. and waiting for the
 * operator's reply) is implemented in TASK-028.
 */

import type { ToolCallRequest } from './tool-types.js';

/**
 * Outcome returned by the approval gate after operator interaction.
 *
 * - `approved` — operator confirmed the tool call; proceed with execution
 * - `denied`   — operator rejected the tool call; return error to agent
 * - `timeout`  — no response received within the deadline; treat as denied
 */
export type ApprovalOutcome = 'approved' | 'denied' | 'timeout';

/**
 * Gate that pauses tool execution pending operator approval.
 *
 * In the placeholder implementation all requests are immediately denied
 * because no approval channel is connected. The full implementation
 * (TASK-028) will send an approval request to the originating channel and
 * long-poll for the operator's reply.
 */
export class ApprovalGate {
  /**
   * Request operator approval for a tool call.
   *
   * @param request  - The tool call awaiting approval.
   * @param threadId - The thread ID of the originating conversation,
   *                   used to route the approval prompt to the correct channel.
   * @returns The operator's decision.
   *
   * @remarks Placeholder — always returns `'denied'` until TASK-028 is implemented.
   */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  requestApproval(request: ToolCallRequest, threadId: string): Promise<ApprovalOutcome> {
    // Placeholder: no channel connected yet, default to deny.
    return Promise.resolve('denied');
  }
}
