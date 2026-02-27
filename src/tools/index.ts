/**
 * Tool registry and dispatch.
 *
 * Registers built-in and capability-gated tools. All tool calls are
 * host-mediated — the sandbox requests an action, the host validates it
 * against persona policy, executes it, and returns the result.
 */

export type {
  ExecutionLocation,
  ToolManifest,
  PolicyDecision,
  ToolCallRequest,
  ToolCallResult,
} from './tool-types.js';

export { ToolRegistry } from './tool-registry.js';

export type { ResolvedCapabilities } from './capability-resolver.js';
export {
  resolveCapabilities,
  hasCapability,
  isValidCapabilityLabel,
} from './capability-resolver.js';

export type { PolicyConfig } from './policy-engine.js';
export { PolicyEngine } from './policy-engine.js';

export type { ApprovalOutcome } from './approval-gate.js';
export { ApprovalGate } from './approval-gate.js';

export type { PendingApproval, ApprovalConfig } from './approval-types.js';

export type {
  ChannelSendTool,
  ChannelSendArgs,
  ScheduleManageTool,
  ScheduleManageArgs,
  MemoryAccessTool,
  MemoryAccessArgs,
  HttpProxyTool,
  HttpProxyArgs,
  DbQueryTool,
  DbQueryArgs,
  ToolExecutionContext,
} from './host-tools/index.js';

export {
  ChannelSendHandler,
  ScheduleManageHandler,
  MemoryAccessHandler,
  HttpProxyHandler,
  DbQueryHandler,
} from './host-tools/index.js';
