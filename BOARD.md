# Talon — Project Board

> Last updated: 2026-03-09

## ✅ Done

| ID | Title | Commit |
|----|-------|--------|
| TASK-032 | Wire daemon bootstrap and runtime orchestration | `9f6aa4b` |
| TASK-033 | Implement MCP transport forwarding in proxy | `f34e17d` |
| TASK-034 | Fix run identity and channel-scoped idempotency | `b20efd4` |
| FIX-001 | cron-parser ESM default import | `5456c61` |
| FIX-002 | Copy SQL migrations to dist/ | `8e22e9f` |
| FIX-003 | Add ${ENV_VAR} substitution in config loader | `fb6a309` |
| FIX-004 | Seed channel DB rows on startup | `79e82bd` |
| FIX-005 | Create default channel→persona binding on startup | `f382655` |
| FIX-006 | Resolve Docker bind mount paths to absolute | `5828635` |
| FEAT-001 | Agent SDK integration (replaced direct-mode API calls) | `bd25665` |
| FEAT-002 | Session persistence across daemon restarts | `df9342e` |
| FEAT-003 | Conversation history / multi-turn support | `1861f20` |
| FEAT-004 | Skill MCP server passthrough to Agent SDK | `da2728b` |
| FEAT-005 | Skills system live (web-research + picnic on VM) | — |
| FIX-007 | Agent SDK query timeout (3 min) to prevent indefinite hangs | `397a028` |
| FIX-008 | Remove stale DB session fallback causing agent hangs | `005e23d` |
| FIX-009 | Disable session resume (hangs with MCP servers attached) | `442b01d` |
| FIX-010 | Merge process.env into host-tools MCP server env | `a0735ea` |
| FIX-011 | Resolve host-tools socket path to absolute | `b8b54e2` |
| FIX-012 | Inject channel context into agent system prompt | `8d1f508` |
| FIX-013 | Wire memory.access handler + local timezone for cron | `11f9ef3` |
| FIX-014 | Resolve thread external_id for channel.send | `a158e90` |
| FIX-015 | Skip duplicate outbound reply for schedule items | `3c3ce3b` |
| FEAT-006 | `talonctl queue-purge` command with FK-safe transaction | `6e7c8ad` |
| FEAT-007 | Schedule list action (agents can review their schedules) | `7de45de` |
| TASK-044 | Scheduled tasks — tested end-to-end on VM | `7de45de` |
| TASK-059 | Native .env file loading (PR #1) | merged |
| TASK-039 | Systemd service unit with install script (PR #2) | merged |
| TASK-040 | Per-persona tool restrictions (PR #3) | merged |
| FIX-016 | Re-enable session resume for conversation memory | `cc3449c` |
| TASK-060 | GPT-5.4 code review fixes (all 10 items) | PR #4 |
| TASK-062 | Terminal channel connector + talonctl chat CLI | PR #5 |
| BUG-007 | Compound PK (thread_id, id) for memory_items | PR #6 |
| BUG-008 | Session resume across daemon restarts | PR #7 |
| TASK-038 | talonctl CLI cleanup (20/20 subtasks) | branch `refactor/talonctl-cleanup` |

---

## 🔨 In Progress

_Nothing currently in progress._

---

## 📋 Backlog — High Priority

| ID | Title | Description |
|----|-------|-------------|
| TASK-037 | Docker sandbox hardening | Run Agent SDK inside Docker containers for blast-radius isolation against prompt injection from untrusted input (repos, emails, messages). The Agent SDK `query()` already works on the host; wrap it in a container with network access to `api.anthropic.com`. Keep the host-mode path as fallback. |

---

## 📋 Backlog — Medium Priority

| ID | Title | Description |
|----|-------|-------------|
| TASK-041 | Multi-persona support | Test multiple personas bound to different channels (e.g. a "coder" persona for Slack, an "assistant" persona for Telegram). Verify routing and isolation. |
| TASK-042 | Slack channel connector + multi-agent swarm | Test and fix the Slack connector end-to-end. **Design needed**: `bot_id` filter (line 220) drops ALL bot messages — blocks agent-to-agent communication. Need echo prevention that allows cross-channel bot messages while preventing self-reply loops. Also: shared workspace between agents, persona-per-channel routing. Target: multiple domain-specific agents collaborating in Slack. |
| TASK-043 | Discord channel connector | Test and fix the Discord connector end-to-end. |
| ~~TASK-045~~ | ~~`talonctl add-mcp` command~~ | Done as CLI-013 in TASK-038 |
| ~~TASK-046~~ | ~~Setup skill cleanup~~ | Done as CLI-019 in TASK-038 |
| TASK-047 | Cost tracking & limits | Persist `total_cost_usd` from Agent SDK results to the runs table. Add `maxBudgetUsd` per persona config. Add a `talonctl usage` report command. |
| TASK-048 | Thread memory | Use the thread workspace's `memory/` directory for persistent agent memory across sessions. Explore Agent SDK file persistence. |

---

## 📋 Backlog — Low Priority

| ID | Title | Description |
|----|-------|-------------|
| TASK-049 | Email channel connector | Test and fix the email (IMAP/SMTP) connector. |
| TASK-050 | WhatsApp channel connector | Test and fix the WhatsApp Business connector. |
| TASK-051 | Audit logging | Verify audit log entries are written for all tool calls, messages, and permission decisions. Add `talonctl audit` query command. |
| TASK-052 | Health endpoint | Expose an HTTP health endpoint for monitoring (uptime, active threads, queue depth, last error). |
| TASK-053 | Backup & restore | Test the SQLite backup mechanism. Add `talonctl backup` and `talonctl restore` commands. |
| TASK-054 | Multi-agent collaboration | Test the Agent SDK's subagent/Task tool support. Configure `agents` in persona config for specialized sub-tasks. |
| TASK-055 | Graceful shutdown | Verify SIGTERM handling: drain queue, finish active runs, close channels, then exit. |
| TASK-056 | Fix pre-existing test failures | 30 test files / 359 tests failing (pre-existing, mostly tool-result-repository setup issues). |
| TASK-058 | Connector plugin/factory pattern | Refactor channel connectors into a plugin or factory pattern so new connectors can be added without touching core code. Currently connectors are hardcoded by type string in channel registration. Move to a registry where connectors self-register or are loaded from a config-driven factory. |
| TASK-061 | Dynamic code generation & execution | When Talon lacks a tool for a user's request, it should be able to generate code, deploy it safely (Sprites.dev sandbox or Docker container), and execute it. Saved snippets can be reused later. Code generation via Claude Code or OpenAI API with GPT-5.3-spark (optimized for speed). Key differentiator — turns Talon from a fixed-tool agent into a self-extending one. Needs: code-gen prompt pipeline, sandbox execution runtime (Sprites.dev preferred, Docker fallback), snippet storage/retrieval, capability gating so only authorized personas can generate+run code. |

---

## 🐛 Known Issues

| ID | Description | Severity |
|----|-------------|----------|
| BUG-001 | 359 tests failing (pre-existing, not from recent changes) — likely test setup/teardown issues in repository tests | Low |
| BUG-002 | `SdkProcessSpawner` is dead code now that Agent SDK runs on host — should be removed or repurposed for Docker mode | Low |
| BUG-003 | `zod` peer dep conflict: Agent SDK `@0.2.71` requires `zod@^4.0.0`, project uses `zod@3.25.76`. Upgrade zod to v4 — `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` both support v4 in their peer ranges. | Medium |
| BUG-007 | ~~Memory key (`id`) globally unique, collides across threads.~~ Fixed: compound PK `(thread_id, id)` via migration 002, all repo methods scope by thread_id. | Resolved |
| BUG-008 | ~~Session resume lost on daemon restart.~~ Fixed: `AgentRunner` falls back to `getLatestSessionId()` from `runs` table when in-memory tracker is empty, then seeds the tracker. | Resolved |
| BUG-004 | ~~`schedule.manage` host tool dead code~~ — Fixed: wired via host-tools MCP bridge + Unix socket. All 5 tools work (schedule, channel, memory, http, db). | Resolved |
| BUG-005 | ~~`schedule.manage` sets `next_run_at: null`~~ — Fixed: computes `next_run_at` from cron expression on create/update. | Resolved |
| BUG-006 | ~~Agent SDK session resume hangs when MCP servers are attached.~~ Re-enabled and working. | Resolved |

---

## 📝 Notes

- **Auth**: Running on Claude Max subscription via `claude login` on VM. No API key needed.
- **VM**: 10.0.1.95, user `talon`, Debian 13, Node.js 22, Claude Code 2.1.71
- **Security**: Telegram bot restricted to chat ID `74575531` via `allowedChatIds`
- **Architecture decision**: Agent SDK runs on host (not in Docker) for v1. Docker isolation deferred to TASK-037 for defense-in-depth against prompt injection from untrusted input.
- **Host-tools MCP**: All 5 tools operational via Unix socket bridge — schedule_manage (CRUD+list), channel_send, memory_access, net_http, db_query.
- **Cron timezone**: Cron expressions evaluate in system local time (CET on VM). Tests pin to UTC explicitly.
- **Session resume**: Re-enabled — conversation memory works across messages in the same thread.
