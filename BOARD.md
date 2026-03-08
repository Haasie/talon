# Talon — Project Board

> Last updated: 2026-03-07

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

---

## 🔨 In Progress

_Nothing currently in progress._

---

## 📋 Backlog — High Priority

| ID | Title | Description |
|----|-------|-------------|
| TASK-037 | Docker sandbox hardening | Run Agent SDK inside Docker containers for blast-radius isolation against prompt injection from untrusted input (repos, emails, messages). The Agent SDK `query()` already works on the host; wrap it in a container with network access to `api.anthropic.com`. Keep the host-mode path as fallback. |
| TASK-038 | talonctl as single source of truth | The `/talon-setup` skill edits YAML directly, duplicating config knowledge. Migrate to `talonctl` CLI commands as single source of truth. All config mutations (channels, personas, MCP, skills, bindings) should go through CLI. The setup skill should only call CLI commands, never write YAML. Needs: `add-channel`, `add-persona`, `add-mcp`, `add-skill`, `bind`, `env-check`. |
| TASK-039 | Systemd service unit | Create a systemd service file for `talond` so it auto-starts on boot, restarts on crash, and manages env vars via an EnvironmentFile. |
| TASK-040 | Per-persona tool restrictions | Map persona `capabilities.allow` / `capabilities.requireApproval` to Agent SDK `allowedTools` / `disallowedTools` / `canUseTool`. Currently all tools are allowed via `bypassPermissions`. |
| TASK-057 | Extract AgentRunner from daemon.ts | `daemon.ts` is 1373 lines. Extract `handleQueueItem` into an `AgentRunner` class owning: Agent SDK query, MCP wiring, typing indicators, session management, output parsing. Also extract `DaemonBootstrap` for the `start()` init sequence. Daemon becomes a thin lifecycle orchestrator. Prepares cleanly for Docker sandbox mode (just swap `spawnClaudeCodeProcess` in the runner). |
| TASK-059 | Native .env file loading | Add `dotenv` to load a `.env` file at daemon startup so env vars do not require external tooling like direnv or manual exports. Load before config parsing so `${VAR}` substitution in `talond.yaml` and skill MCP configs works automatically. |

---

## 📋 Backlog — Medium Priority

| ID | Title | Description |
|----|-------|-------------|
| TASK-041 | Multi-persona support | Test multiple personas bound to different channels (e.g. a "coder" persona for Slack, an "assistant" persona for Telegram). Verify routing and isolation. |
| TASK-042 | Slack channel connector | Test and fix the Slack connector end-to-end. Add a Slack channel, bind a persona, verify message flow. |
| TASK-043 | Discord channel connector | Test and fix the Discord connector end-to-end. |
| TASK-044 | Scheduled tasks | Test cron/interval schedules. Verify the scheduler triggers queue items and personas execute on schedule. |
| TASK-045 | `talonctl add-mcp` command | Add MCP servers to skills or personas via CLI: `talonctl add-mcp --skill web-research --name brave-search --transport stdio --command npx --args "-y @modelcontextprotocol/server-brave-search" --env BRAVE_API_KEY=\${BRAVE_API_KEY}`. Should create the skill directory structure and MCP JSON config. The setup skill should expose this as a conversational flow. |
| TASK-046 | Setup skill cleanup | Rewrite the `/talon-setup` skill to use `talonctl` commands exclusively. Add flows for: adding MCP servers to skills, adding skills to personas, managing env vars. Remove all direct YAML editing. |
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

---

## 🐛 Known Issues

| ID | Description | Severity |
|----|-------------|----------|
| BUG-001 | 359 tests failing (pre-existing, not from recent changes) — likely test setup/teardown issues in repository tests | Low |
| BUG-002 | `SdkProcessSpawner` is dead code now that Agent SDK runs on host — should be removed or repurposed for Docker mode | Low |
| BUG-003 | `zod` peer dep conflict: Agent SDK `@0.2.71` requires `zod@^4.0.0`, project uses `zod@3.25.76`. Upgrade zod to v4 — `@anthropic-ai/sdk` and `@modelcontextprotocol/sdk` both support v4 in their peer ranges. | Medium |
| BUG-004 | `schedule.manage` host tool is dead code in Agent SDK mode — never instantiated or wired in `daemon.ts`. Agent has no way to create schedules. Needs exposing as an MCP server so it works in both host and Docker modes. | High |
| BUG-005 | `schedule.manage` create action sets `next_run_at: null` — scheduler's `findDue` query requires `next_run_at IS NOT NULL`, so created schedules never fire. Must compute `next_run_at` from cron expression on insert. | High |

---

## 📝 Notes

- **Auth**: Running on Claude Max subscription via `claude login` on VM. No API key needed.
- **VM**: 10.0.1.95, user `talon`, Debian 13, Node.js 22, Claude Code 2.1.71
- **Security**: Telegram bot restricted to chat ID `74575531` via `allowedChatIds`
- **Architecture decision**: Agent SDK runs on host (not in Docker) for v1. Docker isolation deferred to TASK-037 for defense-in-depth against prompt injection from untrusted input.
