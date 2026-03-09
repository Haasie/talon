The refactor is mostly a step up structurally: the daemon/bootstrap split is cleaner, queue claiming looks more disciplined, and the test suite is green. But there are a few real issues hiding under that nice surface.
High Risk
- db.query is oversold on safety. The comment says db.read:own, but the implementation just runs arbitrary SELECT against the whole database with no persona/thread scoping at all in src/tools/host-tools/db-query.ts:4 and src/tools/host-tools/db-query.ts:136. That means one persona can read every thread, run, persona, etc. That's a real security hole.
- The capability model looks declarative, not enforced. src/tools/tool-types.ts:8 says every tool call is policy-gated, but I can't find runtime enforcement. Meanwhile src/tools/host-tools-mcp-server.ts:179 exposes all host tools, and src/daemon/agent-runner.ts:191 runs the SDK in bypassPermissions mode with allowDangerouslySkipPermissions: true. Net effect: the security story in comments is stronger than the actual runtime behavior.
- MessagePipeline has racey check-then-act dedupe/thread creation in src/pipeline/message-pipeline.ts:95 and src/pipeline/message-pipeline.ts:143. The DB has unique constraints in src/core/database/migrations/001-initial-schema.sql:65 and src/core/database/migrations/001-initial-schema.sql:85, so concurrent duplicates can turn into hard errors instead of clean dedupe. Tests won’t catch this because they mock the repos.
Obvious Bugs
- net.http is basically dead in production wiring. The handler enforces an allowlist in src/tools/host-tools/http-proxy.ts:121, but the bridge constructs it with allowedDomains: [] in src/tools/host-tools-bridge.ts:70. So every request gets denied.
- The host-tools bridge can double-respond to the same request. Timeout writes an error in src/tools/host-tools-bridge.ts:181, but there’s no “already responded” guard before the later success/error path in src/tools/host-tools-bridge.ts:189. That’s a protocol bug.
- The MCP socket client drops top-level bridge errors. src/tools/host-tools-mcp-server.ts:163 resolves only response.result, so a bridge timeout/error becomes undefined, then the caller reports No response from bridge in src/tools/host-tools-mcp-server.ts:381. Wrong error, harder debugging.
- Queue backoff config is ignored. QueueManager accepts backoffBaseMs and backoffMaxMs in src/queue/queue-manager.ts:26, but QueueProcessor hardcodes 1000 and 60000 in src/queue/queue-processor.ts:211.
Dead Code / Residue
- McpRegistry is still a stub pretending to manage lifecycle but not actually starting anything in src/mcp/mcp-registry.ts:133. Fine during a transition, but right now it adds fake completeness.
- src/usage/token-tracker.ts:21 looks unused outside tests.
- src/daemon/health-check.ts:20 is exported but I couldn't find runtime usage.
- ArtifactRepository and ToolResultRepository are still part of the old dependency shape in src/daemon/daemon-types.ts:76, but not actually wired into bootstrap in src/daemon/daemon-bootstrap.ts:105. Smells like refactor leftovers.
Weird Patterns / Reliability
- src/daemon/agent-runner.ts:226 fires sendTyping without awaiting or handling rejection, and src/daemon/agent-runner.ts:303 swallows async generator cleanup errors. Not catastrophic, but very “future I hate debugging this” energy.
- bootstrap claims all context fields are non-null, then does a null as unknown as HostToolsBridge dance in src/daemon/daemon-bootstrap.ts:207. Works, but it undercuts the nice type-safety story from src/daemon/daemon-context.ts:4.
Signal From Tooling
- npm test passes: 82 files, 1875 tests.
- npm run lint does not: 41 errors, 4 warnings. A lot are not cosmetic. The no-floating-promises, unsafe any, unused vars, and fake-async findings line up with the real issues above.

---

## Action Plan

### Actionable Items

| # | Issue | Category | Priority | Effort | Proposed Fix |
|---|-------|----------|----------|--------|--------------|
| 1 | db.query has no persona/thread scoping — any persona can SELECT all tables | Security | High | Medium | Add WHERE clauses or a query-rewriting layer that injects `persona_id`/`thread_id` predicates. Alternatively, restrict to a set of approved query templates. The `db.read:own` capability label is accurate in intent but unenforced. |
| 2 | Capability model is declarative only — no runtime policy gate before tool dispatch | Security | High | Medium | Add a policy check in `HostToolsBridge.dispatch()` that validates the calling persona's capabilities against the tool manifest before executing. Currently `bypassPermissions` in agent-runner is about the Agent SDK's own permission model (file I/O, shell), not the Talon capability system — these are separate concerns. |
| 3 | net.http is dead — bridge constructs HttpProxyHandler with `allowedDomains: []` | Bug | High | Low | Read allowed domains from persona config or a top-level config field and pass them to the HttpProxyHandler constructor in `host-tools-bridge.ts:70-73`. |
| 4 | Bridge double-respond on timeout — timeout fires, then success/error also writes | Bug | High | Low | Add a `responded` boolean flag per request in `handleRequest()`. Check it before writing the success/error response after `dispatch()` returns. Clear timeout on response, skip response if already timed out. |
| 5 | MCP socket client swallows top-level bridge errors — `response.error` is never surfaced | Bug | Medium | Low | In `SocketClient.processBuffer()` (host-tools-mcp-server.ts), when resolving the promise, pass the full `BridgeResponse` so the `CallToolRequestSchema` handler can check `response.error` and surface the actual bridge error message instead of generic "No response from bridge". |
| 6 | Queue backoff config ignored — QueueProcessor hardcodes 1000/60000 instead of using QueueConfig values | Bug | Medium | Low | Pass `config.backoffBaseMs` and `config.backoffMaxMs` from QueueManager to QueueProcessor (via constructor), then use them in `fail()` at line 211 instead of hardcoded literals. |
| 7 | ArtifactRepository and ToolResultRepository in DaemonDependencies but not wired in bootstrap | Cleanup | Low | Low | Remove them from `DaemonDependencies` in daemon-types.ts. They are not in `DaemonContext` or `DaemonRepos` already — only the old test-injection interface references them. |
| 8 | bootstrap `null as unknown as HostToolsBridge` pattern undercuts type safety | Code quality | Low | Low | Use a builder pattern or two-phase init. Simplest fix: make `hostToolsBridge` a `let` binding created after the context, then freeze. Or accept the tradeoff and add a comment explaining why — it's a one-time bootstrap dance. |
| 9 | sendTyping fire-and-forget with no error handling; generator `.return()` swallows errors | Reliability | Low | Low | For sendTyping: wrap in a `.catch()` that logs. For generator cleanup (line 303): already has `.catch(() => {})` which is intentional — add a logger.debug so timeouts are traceable. |
| 10 | Lint errors (41 errors, 4 warnings) | Code quality | Medium | Medium | Run `npm run lint`, triage the findings. Many will overlap with issues above (floating promises, unsafe any). Fix in a dedicated cleanup pass. |

### Already Fixed / Not Actionable

| # | Issue | Reason |
|---|-------|--------|
| 1 | MessagePipeline race condition in dedupe/thread creation (check-then-act) | Not a real bug in practice. All DB operations are synchronous better-sqlite3 calls in a single-threaded Node.js process — there is no actual interleaving between `existsByIdempotencyKey` and `insert`. The `INSERT OR IGNORE` plus unique index is defense-in-depth. The thread `UNIQUE(channel_id, external_id)` constraint would cause an error on true concurrent insert, but concurrent inserts cannot happen with synchronous SQLite in a single event loop tick. Would only matter if the daemon went multi-process. |
| 2 | McpRegistry is a stub that doesn't actually start transports | By design — confirmed in daemon.ts (lines 77-90, 320-336): the registry is actively used for registration, status tracking, and lifecycle transitions. The `startAll`/`stopAll` stubs are placeholders for future transport integration (comment says so). The Agent SDK handles actual MCP server spawning via its own `mcpServers` config. Not dead code — it's scaffolding for a planned feature. |
| 3 | TokenTracker unused outside tests | Confirmed — only imported in `src/usage/index.ts` (re-export) and tests. However, it is intentional infrastructure for a planned budget/usage feature. Low priority but worth noting it adds dead weight to the build. Not a bug. |
| 4 | HealthCheck exported but no runtime usage | Confirmed — only defined and re-exported from `src/daemon/index.ts`. No consumer imports it. Likely intended for a future `talonctl status` IPC endpoint. Same category as TokenTracker — planned infrastructure, not a bug. |
| 5 | Agent SDK `bypassPermissions` / `allowDangerouslySkipPermissions` | Partially accurate but misleading framing. These flags bypass the *Agent SDK's own* permission model (file writes, shell commands in the sandbox), not the Talon capability system. The Talon tools go through the MCP bridge which has its own dispatch. The real issue is #2 above (no Talon-level policy gate), not the SDK flags. |

### Notes
- Items 1-2 (security) are the most important but also the hardest — they require design decisions about how much scoping/policy enforcement to add.
- Items 3-6 (bugs) are all straightforward fixes, most under 30 lines of code each.
- Items 7-9 (cleanup/reliability) are low-effort polish that can be batched into a single commit.
- The lint errors (item 10) likely overlap significantly with the bugs identified here — fixing items 3-6 will probably knock out a chunk of the lint findings too.
