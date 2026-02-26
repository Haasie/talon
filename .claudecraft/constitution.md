# Project Constitution

> This constitution defines ground rules for ALL AI agents working on this project.
> Last updated: 2026-02-26

## Identity

- **Project**: talon
- **Purpose**: Resilient, secure, extensible autonomous agent daemon — multi-channel AI agents with persona-per-channel, container sandboxing, per-thread memory, scheduled tasks, and agent swarms
- **Target Users**: Single-user / small-team self-hosted deployment (multi-tenant is a future consideration, not v1)
- **Scale**: Medium-large system
- **Design Reference**: `AUTONOMOUS_AGENT_DESIGN.md` is the authoritative architecture document

---

## Requirements Phase (BRD/PRD)

### Business Requirements (BRD)

- Resilience is non-negotiable: durable queues, crash recovery, idempotent processing
- Security by construction: OS isolation, capability-based tools, default-deny
- Operational simplicity: single daemon, clear config, systemd integration, good logs
- Feature parity with NanoClaw: channels, personas, skills, MCP tools, memory, scheduling, swarms
- Self-hosted first — no cloud dependencies for core functionality

### Product Requirements (PRD)

- Setup should be conversational (Claude Code slash commands wrapping `talonctl`)
- Configuration via a single readable YAML file with sane defaults
- Plugin interfaces must be small, versioned, and "data in/data out"
- Markdown is the canonical output format; channels convert to native rendering
- No web UI or dashboard in v1

---

## Specification Phase

### Specification Quality

- Specs must include acceptance criteria for every feature
- Specs must define error handling and edge cases
- Specs must reference existing patterns in codebase and `AUTONOMOUS_AGENT_DESIGN.md`
- Specs require human approval before implementation

### Technical Decisions

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js (single-threaded event loop, all I/O async/non-blocking)
- **Agent SDK**: `@anthropic-ai/claude-agent-sdk` — provides built-in tools, subagents, MCP support, hooks, sessions
- **Database**: SQLite (via `better-sqlite3`) with abstract persistence interface for future Postgres swap
- **Sandboxing**: Docker (rootless preferred), with support for Apple Container and microVMs
- **IPC**: File-based atomic writes with polling (host <-> sandbox, talonctl <-> talond)
- **Deployment**: systemd service (native daemon), containerized daemon, or timer-driven wake-only mode
- **Auth modes**: Claude Pro/Max subscription (OAuth) or Anthropic API keys

---

## Task Generation

### Task Decomposition

- Tasks should be atomic and independently testable
- Each task should take 1-4 hours of implementation time
- Tasks must specify clear completion criteria
- Dependencies between tasks must be explicit
- Tasks should align with the plugin architecture: core, channels, skills, tools, storage

### Task Priorities

- P1: Blocking other work or critical path
- P2: Important but not blocking
- P3: Nice to have, can be deferred

### Follow-up Tasks

- Agents should create TECH-DEBT tasks for shortcuts taken
- Agents should create TEST-GAP tasks for missing coverage
- Agents should create DOC tasks for undocumented features

---

## Implementation Phase

### Code Quality

- **Linting**: ESLint with TypeScript strict rules
- **Formatting**: Prettier
- **Testing**: Vitest (unit + integration minimum)
- **Coverage**: 80% minimum enforced
- **Test types**: contract tests for plugin interfaces, policy tests, sandbox spawn tests, replay tests for idempotency
- No code merges without passing CI
- Follow existing patterns and conventions in codebase
- Documentation required for public APIs (TSDoc)
- Comments only where logic isn't self-evident

### Naming Conventions

- **Variables / functions**: camelCase
- **Types / classes / interfaces**: PascalCase
- **Constants**: UPPER_SNAKE_CASE
- **File names**: kebab-case (e.g., `sandbox-manager.ts`, `queue-item.ts`)
- **Directories**: kebab-case

### Architecture Principles

- **Pattern**: Plugin core — small core (`talond`) + plugins for channels, skills, tools, storage backends
- **Error handling**: Result types (`neverthrow`) for expected errors; exceptions only for truly exceptional/unrecoverable failures
- **Logging**: `pino` — structured JSON logs with `run_id`, `thread_id`, `persona`, `tool`, `request_id`
- **Observability**: Structured logs, metrics (queue depth, run duration, sandbox starts, tool call counts, error rates), append-only audit log
- **Security**: Default-deny capabilities, host-mediated side effects, no ambient authority in sandboxes, secrets never in container filesystem

### Data Access

- **No ORM** — use raw SQL or a lightweight query builder (e.g., `kysely` or hand-written prepared statements)
- Keep the persistence interface abstract (repository pattern) so SQLite can be swapped for Postgres
- Migrations are versioned and applied via `talonctl migrate`

### Process

- Implementation is fully autonomous after spec approval
- All changes happen in isolated git worktrees
- Each stage (coder -> reviewer -> tester -> qa) must pass before proceeding
- QA validation required before merge to main

---

## Constraints & Boundaries

### Security

- Sandboxes start with no host access except explicitly granted mounts
- Drop all Linux capabilities (`--cap-drop=ALL`), read-only rootfs, no Docker socket
- Secrets delivered via stdin JSON at spawn time, never written to disk in containers
- Network default: off. Enable per persona/tool policy with domain allowlists
- Audit everything: every side-effecting operation recorded with provenance
- Channel sends require approval unless persona is explicitly trusted

### Performance

- Warm containers per thread (persistent, not per-run) to minimize response latency
- IPC poll interval: 500ms default (configurable)
- Idle container timeout: 30 minutes default
- Global concurrency limit on warm containers (`maxConcurrent`)
- Per-thread FIFO ordering (no interleaved runs)
- Exponential backoff with jitter for retries; capped attempts; dead-letter queue

### Compatibility

- Linux (systemd) as primary platform; macOS (launchd) as secondary
- Node.js 22+
- Docker or rootless container runtime required for sandboxing
- Plugin interfaces versioned — keep small and stable

---

## Explicitly Out of Scope

- **No web UI / dashboard** — CLI and channel-based interaction only (v1)
- **No ORM** — raw SQL or query builder only
- **No multi-tenant RBAC** — single-user/small-team first
- **No formal eval pipeline** — behavioral correctness validated through manual/vibe testing (v1)
- **No "magic" permission model** based on LLM self-reporting
- **No arbitrary untrusted third-party plugins** — plugins are treated as code execution
- **No GraphQL** — internal IPC is file-based JSON; no external API surface in v1
- **No sub-100ms latency guarantees** — file-based IPC polling is acceptable for chat interactions
