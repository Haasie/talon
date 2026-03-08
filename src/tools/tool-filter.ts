/**
 * Tool filtering based on persona capabilities.
 *
 * Maps capability labels from persona config to MCP tool names and provides
 * functions to determine which host tools a persona is allowed to use.
 *
 * Capability format: `<domain>.<action>` or `<domain>.<action>:<scope>`
 * Tool name format (MCP): `schedule_manage`, `channel_send`, etc.
 * Tool name format (internal): `schedule.manage`, `channel.send`, etc.
 *
 * The mapping uses the domain + action portion of the capability label to
 * match against known host tool names. The scope portion (after `:`) is
 * ignored for tool-level filtering — it is used for finer-grained access
 * control within handlers (e.g., which channels can be sent to).
 */

import type { ResolvedCapabilities } from '../personas/persona-types.js';

// ---------------------------------------------------------------------------
// Capability-to-tool mapping
// ---------------------------------------------------------------------------

/**
 * Maps the `domain.action` prefix of a capability label to the internal
 * (dot-notation) host tool name.
 *
 * For example:
 *   - capability `channel.send:TalonMain` → tool `channel.send`
 *   - capability `schedule.manage` → tool `schedule.manage`
 *   - capability `net.http` → tool `net.http`
 */
const CAPABILITY_TO_TOOL: Record<string, string> = {
  'schedule.manage': 'schedule.manage',
  'channel.send': 'channel.send',
  'memory.access': 'memory.access',
  'net.http': 'net.http',
  'db.query': 'db.query',
};

/** Internal tool names mapped to MCP-style names (underscores). */
const TOOL_TO_MCP: Record<string, string> = {
  'schedule.manage': 'schedule_manage',
  'channel.send': 'channel_send',
  'memory.access': 'memory_access',
  'net.http': 'net_http',
  'db.query': 'db_query',
};

/** All known host tool names (internal format). */
export const ALL_HOST_TOOLS = Object.values(CAPABILITY_TO_TOOL);

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Extracts the `domain.action` prefix from a capability label.
 *
 * Examples:
 *   - `channel.send:TalonMain` → `channel.send`
 *   - `fs.read:workspace` → `fs.read`
 *   - `memory.access` → `memory.access`
 *
 * Returns `null` if the label does not match the expected format.
 */
export function extractCapabilityPrefix(label: string): string | null {
  const colonIndex = label.indexOf(':');
  const prefix = colonIndex === -1 ? label : label.slice(0, colonIndex);

  // Must match `word.word` pattern.
  if (/^\w+\.\w+$/.test(prefix)) {
    return prefix;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/**
 * Given resolved capabilities, returns the set of MCP tool names (underscore
 * format) that the persona is allowed to use.
 *
 * A tool is allowed if its corresponding capability prefix appears in either
 * the `allow` or `requireApproval` list. Tools in `requireApproval` are still
 * exposed (the agent can call them), but future enforcement at the bridge
 * level can gate execution with an approval step.
 *
 * If capabilities are empty (both allow and requireApproval are empty arrays),
 * no host tools are exposed — this is the secure default.
 */
export function filterAllowedMcpTools(capabilities: ResolvedCapabilities): string[] {
  const allowedMcpNames = new Set<string>();

  const allLabels = [...capabilities.allow, ...capabilities.requireApproval];

  for (const label of allLabels) {
    const prefix = extractCapabilityPrefix(label);
    if (prefix === null) continue;

    const toolName = CAPABILITY_TO_TOOL[prefix];
    if (toolName === undefined) continue;

    const mcpName = TOOL_TO_MCP[toolName];
    if (mcpName !== undefined) {
      allowedMcpNames.add(mcpName);
    }
  }

  return [...allowedMcpNames];
}

/**
 * Given resolved capabilities, returns the set of internal (dot-notation)
 * tool names that the persona is allowed to use.
 *
 * Same logic as `filterAllowedMcpTools` but returns dot-notation names.
 */
export function filterAllowedTools(capabilities: ResolvedCapabilities): string[] {
  const allowedTools = new Set<string>();

  const allLabels = [...capabilities.allow, ...capabilities.requireApproval];

  for (const label of allLabels) {
    const prefix = extractCapabilityPrefix(label);
    if (prefix === null) continue;

    const toolName = CAPABILITY_TO_TOOL[prefix];
    if (toolName !== undefined) {
      allowedTools.add(toolName);
    }
  }

  return [...allowedTools];
}

/**
 * Checks whether a specific tool (internal dot-notation name) is allowed
 * by the given capabilities.
 */
export function isToolAllowed(toolName: string, capabilities: ResolvedCapabilities): boolean {
  const allowedTools = filterAllowedTools(capabilities);
  return allowedTools.includes(toolName);
}
