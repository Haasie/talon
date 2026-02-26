# Autonomous Agent Design (NanoClaw-class, but sane)

This document designs a resilient, secure, extensible autonomous agent system inspired by NanoClaw’s *capabilities* (multi-channel, persona-per-channel, container sandboxing, per-thread memory, scheduled tasks, agent swarms), but with a clean architecture, explicit safety model, and maintainable code boundaries.

The design assumes a single-user / small-team self-hosted deployment first (like NanoClaw), while keeping the core abstractions stable enough to scale to multi-tenant later.

## Goals

- Same feature set: channels (WhatsApp/Telegram/Slack/email/etc.), persona-bound channels, skills, MCP tools, per-conversation memory, agent-to-agent collaboration, scheduled jobs, safe container execution with explicit mounts.
- Resilient by default: durable queues, crash recovery, idempotent processing, bounded concurrency, backpressure.
- Secure by construction: OS isolation, capability-based tool execution, explicit mount policy, secrets never copied into sandboxes by default.
- Extensible without “framework bloat”: small core + plugins (channels, skills, tool providers, storage backends).
- Fast: minimal overhead for common interactions; low-latency reply paths; streaming where possible.
- Easy to operate: a single daemon, clear config, systemd integration, good logs, sane defaults.

## Non-goals

- A generic “AI platform” with dashboards, RBAC matrices, multi-region HA, etc.
- Running arbitrary untrusted third-party plugins with no review. (We support plugins, but you must treat them as code execution.)
- A “magic” permission model based on LLM self-reporting.

## Terminology

- **Channel**: a transport (WhatsApp, Telegram, Slack, Email…). Provides inbound messages and outbound delivery.
- **Identity**: the sender identity on a channel (phone number, Telegram user, Slack user…).
- **Thread**: a conversation scope for memory + ordering (e.g., WhatsApp group, Telegram chat, email thread, Slack channel+thread_ts).
- **Persona**: a configured agent profile (system prompt, allowed tools, memory rules, channel bindings).
- **Run**: a single agent execution (triggered by message, schedule, or another agent).
- **Sandbox**: an isolated execution environment (Docker/rootless container, Apple Container, microVM if available).
- **Workspace**: per-thread filesystem directory mounted into the sandbox (with explicit sub-mounts RO/RW).
- **Skill**: a packaged capability (often a set of tools + prompt fragments + configuration) installable/enabled per persona.
- **Tool**: an executable action (shell, HTTP fetch, DB query, MCP tool, internal operations), gated by policy.
- **Policy**: rules deciding what tools/mounts/networking a run may use.

## High-level Architecture

One long-running **host daemon** (“agentd”) handles I/O, scheduling, persistence, sandbox orchestration, and policy enforcement. Agent logic runs inside **persistent warm containers** per thread and communicates with the host through a narrow, validated IPC. Containers stay running to eliminate cold-start latency on inbound messages.

### Agent SDK

The sandbox runtime uses the **Anthropic Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`), the same SDK that powers Claude Code. The SDK provides:

- **Built-in tools**: Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, AskUserQuestion
- **Subagents**: built-in via the `Task` tool — this IS the swarm/collaboration primitive
- **MCP support**: native MCP server integration
- **Hooks**: programmatic lifecycle hooks (PreToolUse, PostToolUse, Stop, SessionStart, SessionEnd, etc.)
- **Sessions**: resumable sessions with full context preservation
- **Skills/Memory**: filesystem-based CLAUDE.md, `.claude/skills/`, slash commands
- **Context window management**: handled internally by the SDK (same as Claude Code) — the host does NOT manage prompt assembly or token budgets

**Authentication** (two modes):

1. **Claude Pro/Max subscription**: OAuth-based auth using the user's claude.ai account. Best for personal/small-team self-hosted deployments (no per-token cost). This is how NanoClaw operates.
2. **Anthropic API keys**: standard API key auth. Required for production/commercial deployments or when token tracking/budgets are needed.

The SDK also supports Amazon Bedrock, Google Vertex AI, and Microsoft Azure as alternative providers.

> **Note**: The SDK docs contain language about not using claude.ai login for third-party products, but Anthropic CEO Thariq clarified on X (Feb 18, 2026) that this was a docs cleanup error — “Nothing is changing about how you can use the Agent SDK and MAX subscriptions.”

### Concurrency model

agentd is a **TypeScript single-threaded event loop** (Node.js). All I/O is async/non-blocking. The event loop handles channel connectors, queue management, scheduler ticks, and IPC multiplexing. CPU-bound work (if any) should be offloaded to worker threads or the sandboxes themselves.

```
           +------------------------------+
Inbound    |          agentd              |
Events --->|  - channel connectors        |
           |  - router (thread->persona)  |
           |  - durable queue + dedupe    |
           |  - scheduler                 |
           |  - sandbox manager           |
           |  - policy + audit            |
           +--------------+---------------+
                          |
                          | IPC (file-based atomic writes + polling)
                          v
                 +--------------------+
                 | warm container     |
                 |  - Agent SDK       |
                 |  - skills          |
                 |  - MCP clients     |
                 |  - session state   |
                 +--------------------+
                          |
                          v
                     Channel send
```

Key property: **the host is the policy enforcement point**. The sandbox asks for actions; the host decides.

## Core Data & State

Use **SQLite** as the default persistence layer (single node, simple ops). Keep the persistence interface abstract so Postgres can be swapped later.

### Tables (minimal)

- `channels`: channel configs + credentials refs
- `personas`: persona configs (prompt refs, tool allowlists, policies)
- `bindings`: channel/thread routing to a persona
- `threads`: canonical thread IDs + metadata
- `messages`: inbound/outbound messages (normalized), with idempotency keys
- `queue_items`: durable work queue (thread-ordered), retry metadata
- `runs`: run records (start/end, status, sandbox id, audit pointers)
- `schedules`: cron/interval/one-shot jobs, tied to persona + thread (or global)
- `memory_items`: structured memory (facts, summaries, embeddings pointers)
- `artifacts`: files produced (optional), with provenance + retention

### Filesystem Layout

All per-thread state that must be file-backed (e.g. `CLAUDE.md`-style memory, attachments, artifacts) lives under a single root:

- `data/threads/<thread_id>/`
- `data/threads/<thread_id>/memory/` (human-editable)
- `data/threads/<thread_id>/attachments/` (ingested)
- `data/threads/<thread_id>/artifacts/` (agent outputs)
- `data/threads/<thread_id>/ipc/` (optional fallback IPC)

Host code owns this directory; the sandbox only sees what is mounted.

## Event Flow (Message -> Reply)

1. Channel connector receives an inbound event.
2. Normalize into a canonical `Message` (with stable `idempotency_key`).
3. Persist + deduplicate.
4. Resolve `thread_id` and route to persona via `bindings`.
5. Enqueue a `queue_item` for that thread (FIFO).
6. Thread queue runner dequeues when allowed (concurrency limits).
7. Host routes to the thread's **warm container** (or spawns one if none exists).
8. Message delivered to container via IPC (atomic file write to `ipc/input/`).
9. Container executes the agent using the Agent SDK (with session resumption for context continuity).
10. Agent requests tool actions via IPC; host validates against policy, executes, returns results.
11. Container emits outbound message(s) via IPC; host persists and sends through channel.
12. Run finalizes; host updates thread memory (summaries, extracted facts) according to policy.
13. Container remains warm, polling `ipc/input/` for follow-up messages.

## Resilience Model

### Exactly-once is a lie; aim for *effectively-once*

- **Inbound dedupe**: per-channel idempotency (WhatsApp message id, Telegram update id, Slack event id, email Message-ID).
- **Queue durability**: queue items are persisted before execution.
- **Idempotent tool execution**: tools get `request_id` and must be safe to retry; host stores tool results keyed by `(run_id, request_id)`.
- **Retry/backoff**: exponential backoff with jitter; capped attempts; dead-letter queue with human-readable reason.
- **Crash recovery**: on daemon restart, rehydrate in-flight items; mark stale sandboxes; re-run queue items.

### Backpressure and fairness

- Global concurrency limit (e.g. max N sandboxes).
- Per-thread FIFO (prevents interleaving runs that scramble memory).
- Optional per-persona concurrency caps.

## Security Model

### Threat model (what we defend against)

- Prompt injection causing unintended actions.
- LLM executing shell/tools that can read/modify sensitive host files.
- Credential exfiltration.
- Cross-thread data leakage.
- Accidental destructive actions (rm -rf) or “agent loops”.

### Safety principles

- **No ambient authority**: the sandbox starts with no host access except mounts explicitly granted.
- **Default-deny tools**: persona must explicitly allow tools, and many tools require human approval gates.
- **Host-mediated side effects**: network, filesystem writes, and integration actions are enforced by the host.
- **Audit everything**: every side-effecting operation is recorded with provenance.

### Sandboxing hardening defaults

Assuming Docker (similar knobs exist for Apple Container / other runtimes):

- Rootless containers when possible.
- Drop Linux capabilities (`--cap-drop=ALL`).
- Read-only rootfs (`--read-only`) with tmpfs for `/tmp`.
- No Docker socket, ever.
- Strict seccomp + AppArmor/SELinux if available.
- Resource limits: CPU, memory, PIDs, disk quota for RW mounts.
- Network default: **off**. Enable per persona/tool policy.
- Mount allowlist: only under `data/threads/<thread_id>/...` unless explicitly configured.

### Secrets

- Secrets live on the host (env/OS keychain/secret store) and are *not* mounted into sandboxes by default.
- **Initial secrets delivery**: passed to container via stdin JSON at spawn time (NanoClaw pattern — secrets never written to disk inside the container).
- Container bash hooks strip sensitive environment variables before subprocess execution (prevents leakage to tools/shell commands).
- Prefer a **credential helper** pattern for ongoing access: sandbox provides a sentinel and host (or a network proxy) injects the real credential at egress time.
- If a tool requires a secret, the host executes that tool (or passes short-lived tokens), not the sandbox.

## IPC Design (Host <-> Sandbox)

Primary IPC: **file-based atomic writes with polling**, following NanoClaw's proven pattern.

Each thread's IPC lives under `data/threads/<thread_id>/ipc/`:
- `input/` — host writes messages for the container (atomic: temp file → rename)
- `output/` — container writes results/messages for the host (same atomic pattern)
- `errors/` — failed IPC messages moved here for inspection

Why file-based over Unix sockets:
- Simpler to implement and debug (files are inspectable).
- Works across all container runtimes without socket mount complexity.
- NanoClaw validates this approach at scale.
- Atomic rename prevents partial reads.

Trade-off: polling adds latency (configurable interval, e.g. 100ms–1s). Acceptable for chat-based interactions. If sub-100ms latency becomes critical, Unix socket IPC can be added as an alternative transport behind the same interface.

### IPC surface area (small)

- `tool.call` (host executes tool)
- `memory.read` / `memory.write` (host mediates access)
- `channel.send` (host sends message mid-execution)
- `artifact.put` (host stores output file)

Everything else stays inside the sandbox.

### Output parsing

Container output is wrapped in sentinel markers for reliable parsing (NanoClaw pattern):
- `---AGENTD_OUTPUT_START---` / `---AGENTD_OUTPUT_END---`
- Enables the host to reliably extract structured output from container stdout, even when mixed with SDK debug/log output.
- Internal tags (e.g. `<internal>...</internal>`) are stripped before channel delivery.

## Tool System

Tools are declared via manifests and validated by the host. Tools can be:

- **Host tools**: implemented in agentd (DB, scheduling, channel send, secrets-aware HTTP).
- **Sandbox tools**: executed *inside* the sandbox (e.g., safe shell with no mounts except workspace).
- **MCP tools**: exposed via MCP servers, but still brokered by host policy.

### Capability-based authorization

Each tool is labeled with capabilities, e.g.:

- `fs.read:workspace`
- `fs.write:artifacts`
- `net.http:egress`
- `channel.send:whatsapp`
- `secrets.use:gmail_oauth`

Personas allow capabilities, not raw tool names. Skills request capabilities; host resolves the intersection.

### Approval gates

For high-risk capabilities (filesystem writes outside artifacts, network egress to arbitrary domains, sending messages to external channels, running shell with RW mounts), require one of:

- Interactive approval by the user (in-channel “Approve? y/n”).
- Pre-approved policy with explicit domain/path allowlists.
- Schedule-only mode with predeclared outputs.

## Skills

Skills are installable bundles:

- Prompt fragments (persona augmentations)
- Tool manifests (capabilities + schemas)
- Optional MCP server definitions
- Migration hooks (create tables, add config)

Packaging recommendation: a simple directory-based format:

```
skills/<skill_name>/
  skill.yaml
  prompts/*.md
  tools/*.yaml
  mcp/*.json
  migrations/*.sql
```

Skills are enabled per persona. agentd persists the resolved persona configuration (so upgrades are predictable).

## MCP Integration

MCP is supported, but treated as an untrusted tool boundary.

- MCP servers run either on the host (preferred) or in separate sandboxes.
- agentd acts as a **tool proxy**: the sandbox requests an MCP call; agentd checks policy (tool allowlist, argument schema, rate limits), then forwards.
- Each persona has an MCP allowlist; each MCP server has its own credential scope.

## Memory System

Use *layered* memory to avoid “dumping everything into prompts”:

1. **Transcript**: canonical message log (DB), never rewritten.
2. **Working memory**: recent window included in prompts.
3. **Thread notebook**: human-editable files (e.g. `memory/CLAUDE.md`, `memory/TASKS.md`).
4. **Structured memory**: extracted facts + summaries in `memory_items`.
5. **Vector memory (optional)**: embeddings for retrieval over attachments + notes.

Memory writes are policy-governed:

- Only write to `artifacts/` or `memory/` if persona has capability.
- Enforce redaction rules (e.g. never store raw secrets).
- Encrypt at rest optional (SQLCipher or OS-level disk encryption + per-field encryption).

## Multi-agent Collaboration (Swarms)

Support collaboration without letting agents freely talk behind your back. The Agent SDK's built-in **subagent system** (via the `Task` tool) is the primary primitive here.

### Model

- A **Supervisor persona** owns the run and can spawn **Worker personas** via the SDK's `Task` tool / `agents` configuration.
- Worker personas can only communicate via host-mediated messages.
- **Supervisor determines task dependencies on the fly** — this is its core job. No predefined task graph schema; the supervisor reasons about decomposition and ordering dynamically.

### Implementation

- `run` can have `child_runs` (maps to SDK subagent invocations).
- Each worker gets its own sandbox (or shared sandbox with strict namespaces), its own tool scope, and its own memory scope.
- Worker outputs are stored as artifacts; supervisor reads artifacts + summaries.
- **Retry policy**: configurable per persona, default **3 retries** per worker task. Supervisor decides whether to retry, reassign, or abort based on failure type.

### Safety

- Workers never get direct channel send unless explicitly allowed.
- Supervisor must explicitly request to send user-facing messages.

## Scheduling / Heartbeat

Scheduled tasks are first-class queue items.

- Store schedules in DB: cron, interval, one-shot, and “after X event” triggers.
- Scheduler wakes up every `tick` (e.g. 1s–10s), claims due jobs with DB locking, enqueues work.
- Jobs run through the same thread/persona routing + policy system.

### systemd integration

- Provide `agentd.service` (long-running).
- Optional `agentd.timer` if you prefer “wake on schedule” mode, but simplest is a daemon with an internal scheduler.
- Health checks: watchdog ping + metrics endpoint.

## Channels

Design channel connectors as plugins with a strict interface:

- `start()` / `stop()`
- `receive()` emits normalized inbound events
- `send()` delivers outbound messages
- `format()` renders agent output to channel-specific constraints

### Output representation

**Markdown is the canonical intermediate format.** Agent output is always markdown. Each channel's `format()` method converts markdown to channel-native rendering:

- **WhatsApp**: WhatsApp-flavored markdown (limited: bold, italic, monospace, lists)
- **Telegram**: Telegram MarkdownV2 or HTML
- **Slack**: mrkdwn (Slack's markdown dialect)
- **Email**: render to HTML via a markdown-to-HTML library
- **Discord**: Discord-flavored markdown (close to standard)

For rich content beyond text (images, files, buttons), use a simple envelope format alongside the markdown body:

```typescript
interface AgentOutput {
  body: string;          // markdown
  attachments?: Attachment[];  // files, images
  actions?: Action[];    // buttons, approval prompts (channel-dependent)
}
```

Channels that don't support attachments or actions silently drop them (with audit log entry).

### Connector responsibilities

- Stable idempotency keys for inbound events.
- Attachment ingestion into `attachments/`.
- Rate limiting + retries with provider-specific backoff.
- **Retry outbound sends** on transient failures (network errors, rate limits). Configurable max retries per channel.

### Router

Routing is explicit:

- `bindings` map `(channel, thread)` to `persona`.
- Default persona per channel if no binding exists.
- Commands in-channel (`/bind personaX`) change bindings (subject to auth).

## Configuration

Prefer a single readable config file with includes, plus a generated “resolved” config snapshot.

Example `agentd.yaml`:

```yaml
storage:
  type: sqlite
  path: data/agentd.sqlite

sandbox:
  runtime: docker
  image: agent-sandbox:latest
  maxConcurrent: 3
  networkDefault: off

channels:
  - type: telegram
    name: personal-telegram
    tokenRef: secrets:telegram_bot_token

personas:
  - name: alfred
    model: claude-sonnet-4-6
    systemPromptFile: personas/alfred/system.md
    skills: [gmail, web]
    capabilities:
      allow:
        - channel.send:telegram
        - net.http:egress
        - fs.read:workspace
      requireApproval:
        - fs.write:workspace
    mounts:
      - source: data/threads/{thread}/memory
        target: /workspace/memory
        mode: ro
      - source: data/threads/{thread}/artifacts
        target: /workspace/artifacts
        mode: rw
```

## agentctl: CLI and daemon boundary

`agentctl` is the CLI tool for operating agentd. It communicates with the running daemon via **file-based IPC** (same pattern as container IPC) — writing JSON command files to a well-known directory that agentd polls.

### agentctl commands

- `agentctl status` — health check, active containers, queue depth
- `agentctl setup` — interactive first-time setup (detect runtime, create DB, generate config)
- `agentctl doctor` — re-run checks, show actionable fixes
- `agentctl add-channel <type>` — add connector config, validate credentials
- `agentctl add-persona <name>` — scaffold persona prompt + default policy
- `agentctl add-skill <skill>` — install/enable a skill
- `agentctl migrate` — apply DB migrations safely
- `agentctl backup` — snapshot SQLite + data directory
- `agentctl reload` — signal agentd to hot-reload config, personas, skills, and channel connectors without restart

### Why file-based IPC for CLI too

Same rationale as container IPC: inspectable, debuggable, no version coupling, enables future reimplementation of agentctl in other languages. Processing flow:
- Success: agentd processes file, deletes from input directory
- Failure: agentd moves file to `errors/` subdirectory for inspection

## AI-Native Setup (Claude Code / Slash Commands)

NanoClaw’s killer feature is “setup as a conversation”: the system uses Claude Code to detect environment issues, guide auth, and generate working configs. This design supports that pattern explicitly.

### Bootstrap model

- Ship a tiny **bootstrap project** that uses Claude Code slash commands to get `agentd` into a known-good state.
- Bootstrap runs locally on the host (not inside the agent sandbox) and can:
  - detect OS + runtime (Docker vs Apple Container), check versions, and fix common misconfigurations
  - validate required binaries and permissions
  - acquire channel credentials interactively (QR flows, OAuth device flows)
  - write `agentd.yaml` and the “resolved config” snapshot (e.g. `data/resolved-config.json`)
  - generate systemd unit files and enable/start the service

### Recommended UX

- `claude` (or Claude Code) is the front-end, and it exposes *skills* that operate on this repo:
  - `/setup` - run environment checks, pick sandbox runtime, create DB, generate config, install systemd service
  - `/doctor` - re-run checks, show actionable fixes (missing group membership, cgroup limits, ports)
  - `/add-channel telegram|slack|email` - add connector config and validate credentials
  - `/add-persona <name>` - scaffold persona prompt + default policy, bind to a channel/thread
  - `/add-skill <skill>` - install/enable a skill and request required capabilities
  - `/migrate` - apply DB migrations safely

### Implementation notes (so it stays maintainable)

- Slash commands are *thin wrappers* around `agentctl` subcommands (e.g. `agentctl setup --json`), so the setup logic is testable without an LLM.
- The LLM is used for:
  - natural-language guidance, troubleshooting, and choosing safe defaults
  - stitching steps together and interpreting “doctor” outputs
- All edits happen through a typed config writer with schema validation; no “stringly-typed” YAML munging.

## Deployment Methods

Support three first-class deployment modes, all producing the same runtime behavior.

### 1) Native daemon (recommended)

- Install Node runtime + dependencies once.
- Run `agentd` as a systemd service (Linux) or launchd (macOS).
- Sandboxes run via Docker/Apple Container; the daemon talks to the local container runtime.

### 2) Containerized daemon

- Run `agentd` itself in a container, with:
  - explicit bind mount of `data/`
  - access to the container runtime via a safe mechanism (prefer rootless + dedicated socket; avoid mounting the host Docker socket when possible)
- Use this if you want a fully reproducible host environment.

### 3) “Wake-only” mode (timer-driven)

- For low-volume installs, run `agentd` on a schedule (systemd timer) to process pending queue items.
- Requires careful handling of in-flight runs and long polls; simplest when channels support webhook ingestion into a mailbox/DB.

### Health and lifecycle

- `agentd` exposes a local health endpoint (or `agentctl status`) for liveness/readiness.
- systemd watchdog integration: the daemon pings watchdog; if stuck, systemd restarts it.
- On restart, `agentd` replays the durable queue and cleans up stale sandboxes.

## Extensibility Boundaries (what goes where)

- Core (`agentd`): queue, scheduler, persistence, sandbox manager, policy engine, audit, minimal builtin tools.
- Plugins:
  - Channels (WhatsApp/Telegram/Slack/email)
  - Skills (bundles)
  - Tool providers (MCP servers, host tools)
  - Memory backends (vector store)

Stability rule: keep plugin interfaces small and versioned. Prefer “data in/data out” over deep callbacks.

## Observability & Audit

- Structured logs (JSON) with `run_id`, `thread_id`, `persona`, `tool`, `request_id`.
- Metrics: queue depth, run duration, sandbox starts, tool call counts, error rates.
- Audit log (append-only): tool calls, approvals, outbound sends, schedule triggers.
- Optional “self-audit” job that summarizes last N actions and flags anomalies.

### Token usage tracking

Track LLM token usage **only when using Anthropic API keys** (not relevant for subscription-based auth if supported later). Per-run tracking:
- Input tokens, output tokens, cache read/write tokens
- Aggregated per persona, per thread, per time period
- Optional budget limits per persona (soft warning + hard cap)

## Operational Notes

- **Backups**: SQLite file + `data/` directory; provide `agentctl backup` to snapshot safely.
- **Upgrades**: migrations are versioned; skills can pin versions.
- **Container image**: prebuilt minimal image (`node:22-slim` based) with Agent SDK runtime and skill loader; avoid “install at runtime” for reliability.
- **Hot reload**: `agentctl reload` signals agentd to re-read config, personas, skills, and channel connectors without restarting. Active containers are not affected; changes apply to new runs. For container image changes, a rolling restart of warm containers is needed.
- **Testing strategy**: contract tests for plugin interfaces; policy tests; sandbox spawn tests; replay tests for idempotency. **Agent behavior is not formally tested** — no evaluation pipeline. Behavioral correctness is validated through manual/vibe testing. A formal eval pipeline is a future consideration but out of scope for v1.

## Warm Container Lifecycle

Containers are **persistent by default** to minimize message response latency.

### Lifecycle

1. **Spawn**: First message to a thread triggers container creation. Initial config (secrets, persona, session ID) delivered via stdin JSON.
2. **Warm idle**: After completing a run, the container stays alive, polling `ipc/input/` for new messages. SDK session is preserved for context continuity.
3. **Follow-up**: New messages delivered via IPC file write. Container resumes SDK session (using `resume: sessionId`), maintaining full conversation context.
4. **Timeout**: Configurable idle timeout (default: 30 minutes). Hard timeout reaps idle containers; soft timeout resets when streaming output is detected.
5. **Graceful shutdown**: On `agentd` shutdown or `agentctl reload`, containers receive a shutdown signal via IPC. 10-second grace period before forced kill.

### State management

- Each container maintains its own `.claude/` session directory (per-thread isolation).
- SDK session resumption provides context continuity across messages within the same container.
- If a container dies unexpectedly, the next message spawns a fresh container; message history is reconstructed from the DB transcript + thread memory files.

### Resource limits

- `maxConcurrent` caps total warm containers globally.
- Per-persona concurrent container limits (optional).
- Idle containers count against limits; oldest-idle evicted when capacity is needed.

## Appendix: Recommended Defaults

- No network in sandboxes; network requests go through a host HTTP tool with domain allowlist.
- RW mounts only for `artifacts/` by default.
- Channel sends require approval unless persona is explicitly trusted.
- **Warm containers per thread** (persistent, not per-run) as the default sandbox model.
- Always store inbound/outbound messages with provider IDs for dedupe and traceability.
- Idle container timeout: 30 minutes.
- Worker task retry limit: 3.
- IPC poll interval: 500ms (configurable).
