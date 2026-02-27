# Task TASK-026: MCP Integration — proxy, allowlists

## Changes Made

- `src/mcp/mcp-types.ts` (new) — MCP domain types: McpServerConfig, McpRateLimitConfig, McpToolCall, McpToolResult, McpServerStatus, McpServerEntry
- `src/mcp/mcp-registry.ts` (new) — McpRegistry class: register/unregister/get/listServers/listEntries, setStatus, startAll/stopAll lifecycle management
- `src/mcp/mcp-proxy.ts` (new) — McpProxy class: handleToolCall with full policy validation pipeline (server existence, server status, persona capability check, tool allowlist glob matching, token-bucket rate limiting), buildAllowedServers, forwardCall placeholder
- `src/mcp/index.ts` (updated) — barrel now exports all new types and classes
- `src/core/errors/error-types.ts` (updated) — added McpError class extending TalonError with code 'MCP_ERROR'
- `src/core/errors/index.ts` (updated) — re-exports McpError

## Tests Added

- `tests/unit/mcp/mcp-registry.test.ts` — 26 tests covering register/unregister/get/listServers/listEntries, setStatus transitions, startAll/stopAll lifecycle, duplicate registration error, round-trip lifecycle
- `tests/unit/mcp/mcp-proxy.test.ts` — 27 tests covering happy path, server-not-found, server-not-running, capability check (allow/deny), tool allowlist (exact/glob/wildcard/deny), rate limiting (within/exceeded), buildAllowedServers filtering, McpError code verification

Total: 53 new tests. Full suite: 1141 tests (56 files), all passing.

## Deviations from Plan

- `buildAllowedServers` takes `(personaCapabilities: string[], allServers: McpServerConfig[])` rather than accessing a LoadedPersona/registry directly. This keeps the proxy stateless for filtering and matches the task spec more closely than the plan snippet (which referenced a future PolicyEngine that doesn't exist yet).
- Capability check uses the label pattern `mcp.<serverName>` (e.g. `mcp.filesystem`). This is consistent with the existing capability label format `<domain>.<action>:<scope>` documented in the codebase.
- Rate limiting is a simple in-memory token bucket per server, lazily created on first call. No persistence; buckets reset on daemon restart.
- `forwardCall` is a placeholder returning mock content with `_mock: true` and echoed args. Actual MCP transport (stdio/SSE) is a separate future task per spec.

## Status
completed

## Notes

- The token bucket refills continuously based on elapsed wall time; no scheduled tick is needed.
- MCP server failures are always caught within handleToolCall and returned as Err(McpError) — the outer try/catch guarantees this.
- The `allowedTools` glob patterns support `*` wildcard (expands to `.*` in regex). More complex negation patterns (`!dangerous_*`) would require micromatch; deferred to a future task if needed.
