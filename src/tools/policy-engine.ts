/**
 * Policy engine for tool call authorization.
 *
 * Evaluates whether a tool call should be allowed, denied, or held for
 * operator approval based on the persona's policy configuration and the
 * capabilities that have been granted to the current run.
 *
 * Decision algorithm (in order):
 *   1. If any of the tool's required capabilities are NOT in `grantedCapabilities`
 *      → `deny` (persona lacks the required permission)
 *   2. If any of the tool's required capabilities appear in `requireApproval`
 *      → `require_approval` (valid but needs operator confirmation)
 *   3. If all of the tool's required capabilities appear in `allow`
 *      → `allow`
 *   4. Default → `deny`
 */

import type pino from 'pino';
import type { ToolCallRequest, ToolManifest, PolicyDecision } from './tool-types.js';

// ---------------------------------------------------------------------------
// Policy configuration
// ---------------------------------------------------------------------------

/**
 * Policy configuration extracted from a persona's capability section.
 *
 * `allow` and `requireApproval` are independent sets — a capability may
 * appear in `requireApproval` without also being in `allow`. The policy
 * engine checks `requireApproval` before `allow`.
 */
export interface PolicyConfig {
  /** Capability labels that the persona explicitly allows without operator approval. */
  allow: string[];
  /** Capability labels that require explicit operator approval before proceeding. */
  requireApproval: string[];
}

// ---------------------------------------------------------------------------
// Policy engine
// ---------------------------------------------------------------------------

/**
 * Stateless policy engine that evaluates tool call requests against persona policy.
 *
 * The engine is stateless — all context required for a decision is passed
 * in at evaluation time. Instantiate once per daemon and reuse across runs.
 */
export class PolicyEngine {
  constructor(private readonly logger: pino.Logger) {}

  /**
   * Evaluate a tool call request and return a policy decision.
   *
   * The evaluation is purely synchronous and has no side effects. Audit
   * logging of decisions is handled by the caller.
   *
   * Decision steps:
   * 1. Check all tool capabilities are in `grantedCapabilities`. If any are
   *    missing → `deny`.
   * 2. Check if any tool capability is in `personaPolicy.requireApproval`.
   *    If yes → `require_approval`.
   * 3. Check all tool capabilities are in `personaPolicy.allow`.
   *    If yes → `allow`.
   * 4. Default → `deny`.
   *
   * @param request              - The inbound tool call request.
   * @param toolManifest         - The registered manifest for the requested tool.
   * @param personaPolicy        - The persona's allow / requireApproval capability config.
   * @param grantedCapabilities  - Capabilities resolved for this run (persona ∩ skills).
   * @returns The policy decision.
   */
  evaluate(
    request: ToolCallRequest,
    toolManifest: ToolManifest,
    personaPolicy: PolicyConfig,
    grantedCapabilities: string[],
  ): PolicyDecision {
    const { tool, requestId, personaId } = request;
    const required = toolManifest.capabilities;

    // Step 1: All required capabilities must be in the granted set.
    // A missing grant means the persona's allowlist does not cover this tool.
    const grantedSet = new Set(grantedCapabilities);
    for (const cap of required) {
      if (!grantedSet.has(cap)) {
        this.logger.debug(
          { tool, requestId, personaId, missingCapability: cap },
          'policy.deny: missing granted capability',
        );
        return 'deny';
      }
    }

    // Step 2: If any required capability is in requireApproval, pause for
    // operator confirmation before proceeding.
    const approvalSet = new Set(personaPolicy.requireApproval);
    for (const cap of required) {
      if (approvalSet.has(cap)) {
        this.logger.debug(
          { tool, requestId, personaId, requireApprovalCapability: cap },
          'policy.require_approval: capability requires operator approval',
        );
        return 'require_approval';
      }
    }

    // Step 3: All required capabilities must appear in the explicit allow list.
    const allowSet = new Set(personaPolicy.allow);
    const allAllowed = required.every((cap) => allowSet.has(cap));
    if (allAllowed) {
      this.logger.debug(
        { tool, requestId, personaId },
        'policy.allow: all capabilities allowed',
      );
      return 'allow';
    }

    // Step 4: Default deny — capabilities are granted but not in the explicit
    // allow list (should not normally occur if policy is consistent, but
    // default-deny is the safe fallback).
    this.logger.debug(
      { tool, requestId, personaId },
      'policy.deny: default deny (capabilities not in allow list)',
    );
    return 'deny';
  }
}
