# Talon

**Resilient, secure, extensible autonomous agent daemon.**

[![Tests](https://img.shields.io/badge/tests-2425%20passing-brightgreen)](#testing)
[![Node](https://img.shields.io/badge/node-%3E%3D22-blue)](https://nodejs.org)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![TypeScript](https://img.shields.io/badge/typescript-strict-blue)](https://www.typescriptlang.org)

---

## What is Talon?

Talon is a self-hosted daemon that orchestrates autonomous AI agents across multiple communication channels. You configure personas — each with their own system prompt, tools, and security policy — and bind them to channels like Telegram, Slack, Discord, WhatsApp, or email. Messages flow in, get routed to the right persona, processed by the Claude Agent SDK, and responses flow back out.

It is built for single-user or small-team deployments where you want persistent, always-on AI agents that you fully control — no cloud platform, no vendor lock-in, just a daemon on your server.

### Why Talon?

- **Self-hosted**: runs on your own hardware, your data stays with you
- **Resilient**: durable message queue survives crashes, automatic retry with exponential backoff, dead-letter handling
- **Secure**: capability-based access control — every tool call is policy-checked and audit-logged
- **Multi-channel**: one daemon handles Telegram, Slack, Discord, WhatsApp, email, and terminal simultaneously
- **Multi-persona**: different agents with different personalities, tools, and permissions on different channels

---

## Features

### Channels

- **Telegram** — Long polling with MarkdownV2 formatting
- **Slack** — Events API / Socket Mode with mrkdwn formatting
- **Discord** — Gateway events with REST API, rate limit handling
- **WhatsApp** — Cloud API with webhook inbound
- **Email** — IMAP polling + SMTP send, thread tracking via In-Reply-To headers
- **Terminal** — WebSocket server with `talonctl chat` client, rendered markdown output, persistent threads

### Agent System

- **Persona-per-channel** — Each channel gets its own agent with a dedicated system prompt, model, tools, and capabilities
- **Claude Agent SDK** — Agents run via the Anthropic Agent SDK with session persistence and multi-turn support
- **Per-thread memory** — Each conversation thread gets its own workspace with transcript, working memory, and artifacts
- **Skills** — Modular prompt fragments and tool bundles that snap onto personas
- **MCP integration** — Connect external MCP tool servers via stdio, policy-enforced through host-tools bridge

### Infrastructure

- **Durable queue** — SQLite-backed message queue with crash recovery, retry, and dead-letter
- **Scheduler** — Agent-managed cron, interval, and one-shot scheduled tasks
- **Host-tools MCP bridge** — 6 built-in tools (schedule, channel, memory, http, db, subagent) exposed via Unix socket
- **Sub-agent system** — Route mechanical LLM tasks (summarization, memory grooming, search) to cheap models via pluggable sub-agents
- **Hot reload** — Change config, personas, and skills without restarting the daemon
- **Systemd integration** — Watchdog heartbeat, graceful shutdown, timer-based wake-only mode
- **Session persistence** — Agent sessions resume across messages in the same thread

### Security

- **Default-deny capabilities** — Tools are gated by capability labels (`channel.send`, `schedule.manage`, etc.)
- **Approval gates** — High-risk actions prompt for user approval in-channel before executing
- **Secrets management** — Credentials via `${ENV_VAR}` substitution, never hardcoded in config
- **Audit logging** — Every side-effecting operation recorded with full provenance

---

## Architecture

The daemon receives messages from channels, routes them through a durable queue, and dispatches them to the Claude Agent SDK. Agents interact with the host via MCP host-tools exposed over a Unix socket.

```mermaid
graph TB
    subgraph Channels
        TG[Telegram]
        SL[Slack]
        DC[Discord]
        WA[WhatsApp]
        EM[Email]
        TM[Terminal]
    end

    subgraph "talond (Host Daemon)"
        CR[Channel Registry]
        NP[Normalize + Dedup]
        RT[Router / Bindings]
        Q[Durable Queue]
        SCH[Scheduler]
        HT[Host-Tools MCP Server]
    end

    subgraph "Agent SDK (Host Process)"
        A1[Agent: Thread A]
        A2[Agent: Thread B]
    end

    DB[(SQLite)]

    TG & SL & DC & WA & EM & TM --> CR
    CR --> NP --> RT --> Q
    Q --> A1 & A2
    A1 & A2 -->|"MCP: schedule, channel,<br/>memory, http, db, subagent"| HT
    HT --> CR
    HT --> DB
    SCH --> Q
    Q --> DB
```

### Message Flow

```mermaid
sequenceDiagram
    participant Ch as Channel
    participant D as talond
    participant Q as Queue
    participant A as Agent SDK

    Ch->>D: Inbound message
    D->>D: Normalize + dedup
    D->>D: Route via bindings
    D->>Q: Enqueue (FIFO per thread)
    Q->>A: Dispatch to Agent SDK
    A->>D: MCP: host-tool call (Unix socket)
    D->>D: Execute tool
    D->>A: Tool result
    A->>D: MCP: channel.send
    D->>Ch: Outbound reply
```

---

## Quick Start

### Prerequisites

- **Node.js 22+**
- **Claude Max subscription** or **Anthropic API key**
- **SQLite** (ships with better-sqlite3, no separate install)

### Install

```bash
git clone https://github.com/your-org/talon.git
cd talon
npm install
npm run build
```

### First-Time Setup

```bash
# Run interactive setup — checks environment, creates directories, generates config
npx talonctl setup

# Add a Telegram channel
npx talonctl add-channel --name my-telegram --type telegram

# Add a persona
npx talonctl add-persona --name assistant

# Run database migrations
npx talonctl migrate

# Check everything is ready
npx talonctl doctor
```

### Start the Daemon

```bash
# Direct
node dist/index.js --config talond.yaml

# Or via npm
npm run talond
```

---

## Configuration

Talon uses a single YAML configuration file. A fully annotated example ships at [`config/talond.example.yaml`](config/talond.example.yaml).

### Minimal Configuration

```yaml
storage:
  type: sqlite
  path: data/talond.sqlite

queue:
  maxAttempts: 3
  backoffBaseMs: 1000
  backoffMaxMs: 60000
  concurrencyLimit: 5

personas:
  - name: assistant
    model: claude-sonnet-4-6
    systemPromptFile: personas/assistant/system.md
    skills: []
    capabilities:
      allow:
        - channel.send:telegram
      requireApproval: []

channels:
  - name: my-telegram
    type: telegram
    enabled: true
    config:
      botToken: ${TELEGRAM_BOT_TOKEN}

bindings:
  - persona: assistant
    channel: my-telegram
    isDefault: true

schedules: []

scheduler:
  tickIntervalMs: 5000

auth:
  mode: subscription

logLevel: info
dataDir: data
```

### Configuration Sections

| Section                | Purpose                                                                       |
| ---------------------- | ----------------------------------------------------------------------------- |
| `storage`              | Database backend and SQLite path                                              |
| `queue`                | Retry/backoff/concurrency controls for durable queue processing               |
| `personas`             | Persona profiles: model, system prompt, skills, capabilities                  |
| `channels`             | Channel connector entries with `type`, `name`, and connector `config` payload |
| `bindings`             | Channel-to-persona routing with default persona per channel                   |
| `schedules`            | Agent-managed schedule entries (cron, interval, one-shot)                     |
| `scheduler`            | Scheduler tick interval                                                       |
| `auth`                 | `subscription` or `api_key` authentication mode                               |
| `logLevel` / `dataDir` | Runtime logging level and data root                                           |

### Environment Variable Substitution

Credential fields support `${ENV_VAR}` syntax so you never hardcode secrets:

```yaml
channels:
  - name: my-telegram
    type: telegram
    config:
      botToken: ${TELEGRAM_BOT_TOKEN}
```

---

## Channel Connectors

Each connector implements the `ChannelConnector` interface: `start()`, `stop()`, `onMessage()`, `send()`, and `format()`. All connectors convert Markdown output to channel-native formatting automatically.

### Telegram

Long-polling connector using the Telegram Bot API.

```yaml
channels:
  - name: my-telegram
    type: telegram
    enabled: true
    config:
      botToken: ${TELEGRAM_BOT_TOKEN}
      pollingTimeoutSec: 30
      allowedChatIds:
        - 123456789
```

- **Inbound**: Long polling via `getUpdates`
- **Outbound**: `sendMessage` with MarkdownV2 parse mode
- **Idempotency key**: `update_id`
- **Thread mapping**: `chat_id`

### Slack

Event-driven connector for Slack's Events API or Socket Mode.

```yaml
channels:
  - name: my-slack
    type: slack
    enabled: true
    config:
      botToken: ${SLACK_BOT_TOKEN}
      appToken: ${SLACK_APP_TOKEN}
      signingSecret: ${SLACK_SIGNING_SECRET}
```

- **Inbound**: Events API webhooks or Socket Mode
- **Outbound**: `chat.postMessage` Web API
- **Idempotency key**: `event_id` > `client_msg_id` > `channel:ts`
- **Thread mapping**: `channel_id:thread_ts`
- **Format**: Slack mrkdwn (`*bold*`, `_italic_`, `` `code` ``)

### Discord

Push-based connector using the Discord Gateway and REST API.

```yaml
channels:
  - name: my-discord
    type: discord
    enabled: true
    config:
      botToken: ${DISCORD_BOT_TOKEN}
      applicationId: '123456789'
      allowedChannelIds:
        - '987654321'
```

- **Inbound**: Gateway `MESSAGE_CREATE` events
- **Outbound**: REST API `POST /channels/{id}/messages`
- **Idempotency key**: Message snowflake ID
- **Thread mapping**: `channel_id:message_id`
- **Rate limiting**: Automatic retry with `Retry-After` header handling

### WhatsApp

Webhook-based connector using the WhatsApp Cloud API.

```yaml
channels:
  - name: my-whatsapp
    type: whatsapp
    enabled: true
    config:
      phoneNumberId: '123456789'
      accessToken: ${WHATSAPP_ACCESS_TOKEN}
      verifyToken: ${WHATSAPP_VERIFY_TOKEN}
```

- **Inbound**: Webhook events via `feedWebhook()`
- **Outbound**: Cloud API `POST /{phone_number_id}/messages`
- **Idempotency key**: `message_id`
- **Format**: WhatsApp-flavored markdown

### Email

Dual-mode connector with IMAP polling and SMTP outbound.

```yaml
channels:
  - name: my-email
    type: email
    enabled: true
    config:
      imapHost: imap.gmail.com
      imapPort: 993
      imapUser: agent@example.com
      imapPass: ${EMAIL_PASSWORD}
      imapSecure: true
      smtpHost: smtp.gmail.com
      smtpPort: 587
      smtpUser: agent@example.com
      smtpPass: ${EMAIL_PASSWORD}
      smtpSecure: false
      fromAddress: 'Talon <agent@example.com>'
```

- **Inbound**: IMAP polling (or webhook via `feedInbound()`)
- **Outbound**: SMTP with HTML formatting
- **Idempotency key**: `Message-ID` header
- **Thread mapping**: `In-Reply-To` / `References` headers
- **Format**: Markdown to HTML conversion

### Terminal

WebSocket-based connector for direct CLI access to any persona. Connect from any machine with `talonctl chat`.

```yaml
channels:
  - name: my-terminal
    type: terminal
    enabled: true
    config:
      port: 7700
      host: 0.0.0.0
      token: ${TERMINAL_TOKEN}
```

- **Inbound**: WebSocket JSON messages from `talonctl chat`
- **Outbound**: JSON response over WebSocket, client renders with `marked-terminal`
- **Auth**: Shared token with constant-time comparison, 64KB max payload, 10s auth timeout
- **Thread mapping**: `clientId` — same client always gets the same conversation thread
- **Persona override**: `--persona` flag switches persona at connect time
- **Format**: Raw markdown passthrough (client handles rendering)

#### Connecting

```bash
# Set token via env var or --token flag
export TERMINAL_TOKEN=your-secret-token

# Connect to a running Talon instance
talonctl chat --host 10.0.1.95 --port 7700 --persona assistant

# Or with explicit token
talonctl chat --host 10.0.1.95 --port 7700 --token your-secret-token

# Custom client ID for persistent thread identity
talonctl chat --host 10.0.1.95 --port 7700 --client-id my-laptop
```

The client provides:
- Rendered markdown output via `marked-terminal`
- Typing spinner (`ora`) while the agent works
- Persistent conversation — reconnecting with the same `clientId` resumes the thread
- Graceful disconnect on Ctrl+C

---

## Personas

A persona defines an AI agent's identity, capabilities, and channel bindings. Bindings are managed separately via `talonctl bind`.

```yaml
personas:
  - name: alfred
    description: Personal assistant
    model: claude-sonnet-4-6
    systemPromptFile: personas/alfred/system.md
    skills:
      - web-search
      - calendar
    capabilities:
      allow:
        - channel.send:telegram
        - channel.send:slack
        - net.http
        - schedule.manage
        - memory.access
      requireApproval:
        - db.query

bindings:
  - persona: alfred
    channel: my-telegram
    isDefault: true
  - persona: alfred
    channel: my-slack
    isDefault: true
```

### Capability Labels

Tools are gated by scoped capability labels. Capabilities are listed in `allow` or `requireApproval` arrays — anything not listed is denied by default.

| Capability                 | Description                              |
| -------------------------- | ---------------------------------------- |
| `channel.send:<channel>`   | Send messages to a specific channel      |
| `schedule.manage`          | Create/modify/delete scheduled tasks     |
| `memory.access`            | Read/write per-thread structured memory  |
| `net.http`                 | Fetch external URLs                      |
| `db.query`                 | Execute read-only database queries       |
| `subagent.invoke`          | Invoke sub-agents for delegated tasks    |

### Capability Resolution

When an agent requests a tool:

```mermaid
flowchart LR
    A[Tool request] --> B{In persona's<br/>allow list?}
    B -->|not listed| C[Reject]
    B -->|allow| D[Execute]
    B -->|requireApproval| E[Prompt user<br/>in channel]
    E -->|approved| D
    E -->|denied/timeout| C
```

---

## Skills

Skills are modular bundles of prompts, tools, and configuration that snap onto personas.

### Skill Structure

```
skills/<skill_name>/
  skill.yaml          # metadata, required capabilities, config schema
  prompts/*.md        # persona augmentation fragments
  tools/*.yaml        # tool manifests (capability labels + schemas)
  mcp/*.json          # MCP server definitions (optional)
  migrations/*.sql    # DB migrations (optional)
```

### Adding a Skill

```bash
# Scaffold a new skill and attach it to a persona
npx talonctl add-skill --name web-search --persona assistant
```

This creates the skill directory structure, generates a default `skill.yaml`, and adds the skill to the persona in `talond.yaml`.

### Skill Resolution

Persona capabilities and skill requirements are intersected at runtime:

```
granted = persona.capabilities ∩ skill.requiredCapabilities
```

Skills with unmet capabilities produce a warning at startup and are skipped.

---

## Sub-Agents

Sub-agents are lightweight, single-purpose AI agents that handle mechanical LLM tasks using cheap models (e.g. Haiku) instead of routing everything through the main Claude agent. They reduce token costs and keep the main agent focused on conversation.

### How Sub-Agents Work

1. The main agent calls `subagent_invoke` via MCP, specifying a sub-agent name and input
2. The daemon validates that the persona is assigned this sub-agent and has the required capabilities
3. The **ModelResolver** creates a Vercel AI SDK model instance for the sub-agent's configured provider
4. The sub-agent's `run()` function executes with a system prompt, model, and injected services
5. Results flow back to the main agent as structured data

### Sub-Agent Structure

```
subagents/<agent_name>/
  subagent.yaml          # manifest: model, capabilities, timeout
  index.ts               # entry point: run(ctx, input) -> Result<SubAgentResult>
  prompts/*.md           # system prompt fragments (concatenated in order)
  lib/                   # optional helper modules
```

### Built-in Sub-Agents

| Sub-Agent | Purpose | Required Capabilities |
|-----------|---------|----------------------|
| `session-summarizer` | Compresses conversation transcripts into structured summaries | none |
| `memory-groomer` | Consolidates duplicates and prunes stale memory items | `memory.read:thread`, `memory.write:thread` |
| `file-searcher` | Searches files with keyword matching and optional LLM ranking | none |
| `memory-retriever` | Finds relevant memories via keyword filter and LLM reranking | `memory.read:thread` |

### Provider Support

Sub-agents can use any supported AI provider. Configure API keys in `talond.yaml`:

```yaml
auth:
  mode: subscription
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
    openai:
      apiKey: ${OPENAI_API_KEY}
    google:
      apiKey: ${GOOGLE_API_KEY}
    ollama:
      baseURL: http://localhost:11434/v1
```

### Persona Assignment

Personas declare which sub-agents they can invoke:

```yaml
personas:
  - name: assistant
    model: claude-sonnet-4-6
    subagents:
      - session-summarizer
      - memory-groomer
      - memory-retriever
    capabilities:
      allow:
        - subagent.invoke
        - memory.access
```

### Creating a Custom Sub-Agent

1. Create a directory under `subagents/` with a `subagent.yaml` manifest
2. Write an `index.ts` with an exported `run(ctx, input)` function returning `Result<SubAgentResult, SubAgentError>`
3. Add prompt fragments in `prompts/` (numbered for ordering: `01-system.md`, `02-examples.md`)
4. Test with `talonctl run-subagent --name your-agent --input '{}'`

---

## CLI Reference

`talonctl` is the management CLI for the daemon. All commands are available via `npx talonctl <command>`.

### Daemon Management

| Command           | Description                                                   |
| ----------------- | ------------------------------------------------------------- |
| `talonctl status` | Show daemon health, active channels, queue depth, token usage |
| `talonctl reload` | Hot-reload config without restarting the daemon               |
| `talonctl chat`   | Connect to a persona via the terminal channel                 |

```bash
# Check daemon status
npx talonctl status --timeout 5000

# Reload configuration
npx talonctl reload
```

### Setup and Configuration

| Command                                       | Description                                                                       |
| --------------------------------------------- | --------------------------------------------------------------------------------- |
| `talonctl setup`                              | First-time interactive setup (checks environment, creates dirs, generates config) |
| `talonctl add-channel --name <n> --type <t>`  | Add a channel connector to config                                                 |
| `talonctl add-persona --name <n>`             | Scaffold a persona directory and add to config                                    |
| `talonctl add-skill --name <n> --persona <p>` | Scaffold a skill and attach to a persona                                          |

```bash
# Full setup flow
npx talonctl setup --config talond.yaml --data-dir data
npx talonctl add-channel --name work-slack --type slack
npx talonctl add-persona --name researcher
npx talonctl add-skill --name web-search --persona researcher
```

### Channel & Persona Management

| Command                                           | Description                                              |
| ------------------------------------------------- | -------------------------------------------------------- |
| `talonctl list-channels`                          | List all configured channels                             |
| `talonctl list-personas`                          | List all configured personas                             |
| `talonctl list-skills`                            | List all configured skills across personas               |
| `talonctl bind --persona <p> --channel <c>`       | Bind a persona to a channel (first binding becomes default) |
| `talonctl unbind --persona <p> --channel <c>`     | Remove a persona-channel binding                         |
| `talonctl remove-channel --name <n>`              | Remove a channel and its bindings                        |
| `talonctl remove-persona --name <n>`              | Remove a persona, its directory, and bindings            |
| `talonctl add-mcp --name <n> --command <cmd>`     | Add an MCP server to a persona                           |
| `talonctl env-check`                              | Audit config for `${ENV_VAR}` placeholders and report missing env vars |
| `talonctl config-show`                            | Display resolved config with secrets masked              |

```bash
# List what's configured
npx talonctl list-channels
npx talonctl list-personas
npx talonctl list-skills

# Bind a persona to a channel
npx talonctl bind --persona assistant --channel my-telegram

# Remove a channel (cascades to bindings)
npx talonctl remove-channel --name old-slack

# Add an MCP server to a persona
npx talonctl add-mcp --name web-search --persona assistant \
  --command npx --args @anthropic-ai/mcp-web-search --transport stdio

# Check for missing environment variables
npx talonctl env-check

# Show resolved config (secrets masked)
npx talonctl config-show
```

### Sub-Agent Testing

| Command | Description |
| ------- | ----------- |
| `talonctl run-subagent --name <n> --input <json>` | Invoke a sub-agent directly (no daemon required) |

```bash
# Test the session-summarizer
npx talonctl run-subagent --name session-summarizer \
  --input '{"transcript": "User: Hi\nAssistant: Hello!"}'

# Test the memory-retriever
npx talonctl run-subagent --name memory-retriever \
  --input '{"query": "deployment steps"}'

# Use a custom subagents directory
npx talonctl run-subagent --name my-agent --input '{}' --subagents-dir ./subagents
```

### Database and Operations

| Command                 | Description                                                    |
| ----------------------- | -------------------------------------------------------------- |
| `talonctl migrate`      | Apply pending database migrations                              |
| `talonctl backup`       | Snapshot SQLite database and data directory                    |
| `talonctl doctor`       | Run diagnostic checks on environment, config, and dependencies |
| `talonctl queue-purge`  | Purge queue items by status                                    |

```bash
# Run migrations
npx talonctl migrate --config talond.yaml

# Create a backup
npx talonctl backup --config talond.yaml --output /backups/talon-$(date +%Y%m%d).tar.gz

# Check system health
npx talonctl doctor --config talond.yaml

# Purge completed, pending, and failed queue items (default)
npx talonctl queue-purge

# Purge specific statuses
npx talonctl queue-purge --statuses dead_letter,failed

# Purge ALL queue items including in-flight (claimed, processing)
npx talonctl queue-purge --all
```

### Doctor Checks

`talonctl doctor` runs 7 structured checks:

1. **OS compatibility** — Verifies Linux or macOS
2. **Node.js version** — Checks for Node 22+
3. **Docker availability** — Verifies Docker is installed and running
4. **Directory structure** — Ensures data directories exist
5. **Config file** — Validates `talond.yaml` syntax and schema
6. **Database migrations** — Checks for pending migrations
7. **Config validation** — Deep validation of personas, channels, and references

---

## Deployment

Talon supports three deployment modes.

### 1. Native Daemon (systemd)

The recommended mode for Linux servers. The daemon runs as a systemd service with automatic restart on failure.

```bash
# Install the service (detects user, directory, and node path)
sudo ./deploy/install-service.sh

# Or with explicit options
sudo ./deploy/install-service.sh --user talon --dir /home/talon/talon

# Start the daemon
sudo systemctl start talond

# Check status and follow logs
sudo systemctl status talond
journalctl -u talond -f

# The daemon will auto-start on boot and restart on crash
```

The install script generates a systemd unit from `deploy/talond.service` with your paths substituted. It reads environment variables from `.env` in the project root via `EnvironmentFile`.

The service includes security hardening: `NoNewPrivileges`, `PrivateTmp`, `ProtectKernelTunables`, `SystemCallFilter=@system-service`, `RestrictAddressFamilies`, and more.

### 2. Containerized Daemon (Docker)

> **Coming soon** — Docker deployment is under active development. The goal is to run the Agent SDK inside Docker containers for blast-radius isolation against prompt injection from untrusted input (repos, emails, messages). The host-mode path will remain as fallback. Dockerfiles and Compose config exist in `deploy/` and will be updated for the current architecture.

### 3. Wake-Only Mode (Timer)

For low-traffic deployments. A systemd timer wakes the daemon periodically to process the queue, then exits.

```bash
sudo cp deploy/talond-wake.service /etc/systemd/system/
sudo cp deploy/talond.timer /etc/systemd/system/

sudo systemctl daemon-reload
sudo systemctl enable talond.timer
sudo systemctl start talond.timer
```

Default: wakes every 5 minutes. Adjust `OnUnitActiveSec` in `talond.timer`.

### Deployment Files

| File                                                           | Purpose                                           |
| -------------------------------------------------------------- | ------------------------------------------------- |
| [`deploy/talond.service`](deploy/talond.service)               | systemd service unit template                     |
| [`deploy/install-service.sh`](deploy/install-service.sh)       | Install script (generates unit, enables service)  |
| [`deploy/Dockerfile`](deploy/Dockerfile)                       | Multi-stage talond container image (node:22-slim) |
| [`deploy/Dockerfile.sandbox`](deploy/Dockerfile.sandbox)       | Agent sandbox image with SDK runtime              |
| [`deploy/docker-compose.yaml`](deploy/docker-compose.yaml)     | Example Compose setup                             |
| [`deploy/talond.timer`](deploy/talond.timer)                   | systemd timer (wake-only mode)                    |
| [`deploy/talond-wake.service`](deploy/talond-wake.service)     | systemd oneshot for timer-triggered wake          |

---

## Security Model

Talon implements defense in depth through capability-based access control, host-mediated side effects, and audit logging. Docker container isolation for agent sandboxing is coming soon — wrapping Agent SDK execution in containers with network access limited to `api.anthropic.com` for defense-in-depth against prompt injection.

### Host-Tools MCP Bridge

Agents interact with the host through 5 MCP tools exposed over a Unix socket. The daemon mediates all side effects — agents cannot access channels, databases, or the network directly.

| Tool               | Purpose                              |
| ------------------ | ------------------------------------ |
| `schedule_manage`  | CRUD + list scheduled tasks          |
| `channel_send`     | Send messages to channel connectors  |
| `memory_access`    | Read/write per-thread memory         |
| `net_http`         | Fetch external URLs                  |
| `db_query`         | Read-only database queries           |
| `subagent_invoke`  | Invoke a sub-agent by name           |

### Capability System

```mermaid
flowchart TB
    subgraph "Agent SDK (host process)"
        Agent["Agent calls MCP tool"]
    end

    subgraph "talond (policy enforcement)"
        PR[Policy Engine]
        CR[Capability Resolver]
        AG[Approval Gate]
        EX[Execute Tool]
        AU[Audit Log]
    end

    Agent --> PR
    PR --> CR
    CR -->|not in allow list| R[Reject + log]
    CR -->|allowed| EX
    CR -->|requireApproval| AG
    AG -->|approved| EX
    AG -->|denied| R
    EX --> AU
    R --> AU
```

Every MCP tool call goes through:

1. **Policy Engine** — Validates the tool exists and maps to a capability label
2. **Capability Resolver** — Checks the persona's `allow` or `requireApproval` lists
3. **Approval Gate** — For `requireApproval` capabilities, prompts the user in-channel
4. **Audit Log** — Records the decision and result regardless of outcome

### Database Query Isolation

Agents can query the database via the `db.query` tool, but are constrained by five independent security layers:

| Layer | Mechanism | What it prevents |
|-------|-----------|-----------------|
| 1. Regex pre-check | Rejects non-SELECT statements and forbidden keywords (INSERT, DROP, etc.) | Write operations via SQL |
| 2. Table whitelist | Only 4 approved tables (`memory_items`, `schedules`, `messages`, `threads`) | Access to sensitive tables (personas, audit_log, queue_items) |
| 3. Thread/persona scoping | Auto-injects `WHERE thread_id = ? AND persona_id = ?` clauses | Cross-tenant data leakage between personas or threads |
| 4. Row limit | Hard cap at 1,000 rows per query | Resource exhaustion via large result sets |
| 5. Read-only connection | Separate SQLite connection opened with `{ readonly: true }` | Any write operation, even if all other layers are bypassed |

Complex SQL patterns (UNION, subqueries, CTEs, INTERSECT, EXCEPT) are rejected to prevent whitelist bypass via query composition. User-supplied WHERE conditions are wrapped in parentheses to prevent OR-based scoping escapes.

### Secrets Management

- Credentials use `${ENV_VAR}` substitution in `talond.yaml` — never hardcoded
- Environment variables loaded from `.env` file at startup
- `talonctl config-show` masks all secret values in output
- `talonctl env-check` audits for missing environment variables

### Approval Gates

High-risk capabilities can require interactive user approval:

```yaml
capabilities:
  allow:
    - channel.send:telegram
    - memory.access
  requireApproval:
    - db.query   # prompts user in-channel before executing
```

Approval prompts are sent to the originating channel with a configurable timeout.

---

## Durable Queue

The message queue is the backbone of Talon's resilience. Every inbound message is persisted to SQLite before processing begins.

```mermaid
stateDiagram-v2
    [*] --> Pending: enqueue
    Pending --> Claimed: dequeue
    Claimed --> Processing: handler starts
    Processing --> Completed: success
    Processing --> Pending: transient error<br/>(retry with backoff)
    Processing --> DeadLetter: max attempts<br/>exceeded
    DeadLetter --> [*]: manual review
    Completed --> [*]
```

- **Crash recovery**: On restart, in-flight items (status `claimed` or `processing`) are reset to `pending`
- **FIFO per thread**: Messages within a thread are processed in order, no interleaving
- **Cross-thread parallelism**: Different threads process concurrently up to `max_concurrent_containers`
- **Exponential backoff**: Failed items retry with configurable base delay (1s), max delay (60s), and jitter
- **Dead-letter queue**: After max attempts (default 3), items move to dead-letter for manual review

---

## Memory System

Each conversation thread gets a persistent workspace:

```
data/threads/<thread_id>/
  memory/          # human-editable notes (CLAUDE.md, etc.)
  attachments/     # ingested inbound files
  artifacts/       # agent output files
  ipc/
    input/         # host -> container messages
    output/        # container -> host messages
    errors/        # failed IPC messages
```

### Memory Layers

| Layer             | Storage                | Purpose                                         |
| ----------------- | ---------------------- | ----------------------------------------------- |
| Transcript        | `messages` table       | Canonical message log, never rewritten          |
| Working memory    | In-prompt context      | Recent message window included in agent prompts |
| Thread notebook   | Filesystem (`memory/`) | Human-editable per-thread notes                 |
| Structured memory | `memory_items` table   | Extracted facts and summaries                   |

Memory writes are gated by persona capabilities. Thread notebooks persist across container restarts.

---

## Scheduling

Schedules are managed by agents at runtime via the `schedule_manage` MCP tool — agents can create, update, delete, and list their own scheduled tasks. Scheduled tasks flow through the same queue and routing system as regular messages.

```yaml
# Config only sets the tick interval — schedules are agent-managed
scheduler:
  tickIntervalMs: 5000
```

Agents create schedules like:

```
"Schedule a daily briefing at 8am: cron 0 8 * * *"
"Check system health every 30 minutes"
```

| Schedule Type | Example     | Behavior                     |
| ------------- | ----------- | ---------------------------- |
| Cron          | `0 9 * * *` | Fires at 09:00 daily         |
| Interval      | `30m`       | Recurring at fixed intervals |
| One-shot      | (future)    | Single execution at set time |

Scheduled tasks are enqueued through the standard queue pipeline, subject to the same retry and dead-letter policies as regular messages. Cron expressions evaluate in system local time.

---

## MCP Integration

Talon supports the [Model Context Protocol](https://modelcontextprotocol.io) for connecting external tool servers to personas. MCP servers are added per-persona via `talonctl add-mcp`.

```bash
# Add an MCP server to a persona
npx talonctl add-mcp --name web-search --persona assistant \
  --command npx --args @anthropic-ai/mcp-web-search --transport stdio

# Add a custom MCP server
npx talonctl add-mcp --name my-tools --persona assistant \
  --command node --args ./tools/server.js --transport stdio
```

This adds the MCP server to the persona's config in `talond.yaml`:

```yaml
personas:
  - name: assistant
    mcpServers:
      - name: web-search
        command: npx
        args: ['@anthropic-ai/mcp-web-search']
        transport: stdio
```

MCP servers are passed through to the Agent SDK at runtime. Each persona gets its own set of MCP servers.

---

## Token Usage Tracking

When using Anthropic API keys, Talon records token usage from Agent SDK results in the `runs` table:

- Input tokens, output tokens, cache read/write tokens per run
- `total_cost_usd` from Agent SDK results

Per-persona budget limits and a `talonctl usage` report command are planned (TASK-047).

---

## Development

### Build

```bash
npm install
npm run build          # TypeScript -> dist/
```

### Test

```bash
npm test               # Run all tests
npm run test:watch     # Watch mode
npm run test:coverage  # Coverage report (80% target)
```

The test suite includes:

- **Unit tests** — Every module, repository, connector, and CLI command
- **Integration tests** — IPC round-trips, queue durability, channel registry lifecycle
- **End-to-end tests** — Full message flow from inbound to outbound with real SQLite

### Lint and Format

```bash
npm run lint           # ESLint with TypeScript strict rules
npm run format         # Prettier
```

### Dev Server

```bash
npm run dev            # tsx watch mode with auto-reload
```

---

## Project Structure

```
talon/
  config/
    talond.example.yaml          # Annotated example configuration
  deploy/
    Dockerfile                   # talond container image
    Dockerfile.sandbox           # Agent sandbox image
    docker-compose.yaml          # Example Compose setup
    talond.service               # systemd service unit
    talond.timer                 # systemd timer (wake-only)
    talond-wake.service          # Oneshot service for timer wake
  src/
    channels/
      connectors/
        telegram/                # Telegram Bot API connector
        slack/                   # Slack Events API connector
        discord/                 # Discord Gateway + REST connector
        whatsapp/                # WhatsApp Cloud API connector
        email/                   # IMAP + SMTP connector
        terminal/                # WebSocket terminal connector
      channel-registry.ts        # Connector lifecycle management
      channel-router.ts          # Thread -> persona routing
      channel-types.ts           # ChannelConnector interface
    cli/
      commands/                  # talonctl subcommands
      index.ts                   # CLI entry point (commander)
    collaboration/
      supervisor.ts              # Multi-agent supervisor
      worker-manager.ts          # Worker sandbox orchestration
    core/
      config/                    # YAML loader + Zod schemas
      database/
        migrations/              # Versioned SQL migrations
        repositories/            # Repository pattern (12 repos)
        connection.ts            # SQLite connection factory
      errors/                    # TalonError hierarchy (16 error types)
      logging/                   # pino logger + audit logger
      types/                     # Result helpers, common types
    daemon/
      daemon.ts                  # TalondDaemon orchestrator
      lifecycle.ts               # PID file, crash recovery
      signal-handler.ts          # SIGTERM/SIGINT handling
      watchdog.ts                # systemd watchdog heartbeat
    ipc/
      ipc-writer.ts              # Atomic file write
      ipc-reader.ts              # Directory poll + validate
      ipc-channel.ts             # Bidirectional IPC channel
      daemon-ipc-server.ts       # talond <-> talonctl IPC
    mcp/
      mcp-proxy.ts               # MCP tool proxy
      mcp-registry.ts            # MCP server registry
    memory/
      memory-manager.ts          # Memory read/write/delete
      thread-workspace.ts        # Per-thread filesystem layout
      context-builder.ts         # Prompt context assembly
    personas/
      persona-loader.ts          # Load + validate personas
      capability-merger.ts       # Persona x skill capability resolution
    pipeline/
      message-normalizer.ts      # Inbound message normalization
      message-pipeline.ts        # Normalize -> dedup -> route -> enqueue
    queue/
      queue-manager.ts           # Queue lifecycle + processing loop
      queue-processor.ts         # Item processing with retry
      retry-strategy.ts          # Exponential backoff with jitter
      dead-letter.ts             # Dead-letter queue management
    sandbox/
      sandbox-manager.ts         # Agent lifecycle management
      agent-runner.ts            # Agent SDK query dispatch
      session-tracker.ts         # Session resume tracking
    scheduler/
      scheduler.ts               # Tick-based schedule processor
      cron-evaluator.ts          # Cron expression evaluation
    skills/
      skill-loader.ts            # Load + validate skills
      skill-resolver.ts          # Skill -> persona resolution
    subagents/
      subagent-types.ts          # Core type definitions
      subagent-schema.ts         # Zod manifest validation
      subagent-loader.ts         # Load sub-agents from directories
      model-resolver.ts          # Vercel AI SDK provider factory
      subagent-runner.ts         # Execution engine with timeout
      index.ts                   # Barrel export
    tools/
      host-tools/                # Host-side tool handlers
        channel-send.ts          # Send via channel connector
        http-proxy.ts            # Fetch with domain allowlist
        memory-access.ts         # Thread memory CRUD
        schedule-manage.ts       # Schedule CRUD
        db-query.ts              # Read-only DB queries
        subagent-invoke.ts       # Invoke sub-agents
      tool-registry.ts           # Tool manifest registry
      policy-engine.ts           # Capability-based access control
      capability-resolver.ts     # Label resolution
      approval-gate.ts           # In-channel approval prompting
    usage/
      token-tracker.ts           # Token usage recording + aggregation
  tests/
    unit/                        # Unit tests (mirrors src/ structure)
    integration/                 # Integration + e2e tests
```

---

## Data Model

Talon uses SQLite with WAL mode and foreign keys. All persistence goes through the repository pattern for future Postgres portability.

### Tables

| Table          | Purpose                                                         |
| -------------- | --------------------------------------------------------------- |
| `channels`     | Channel connector configurations                                |
| `personas`     | Agent profiles and capabilities                                 |
| `bindings`     | Channel+thread to persona routing                               |
| `threads`      | Conversation thread metadata                                    |
| `messages`     | Normalized inbound/outbound messages                            |
| `queue_items`  | Durable work queue with retry state                             |
| `runs`         | Agent execution records (supports parent/child for multi-agent) |
| `schedules`    | Cron/interval/one-shot job definitions                          |
| `memory_items` | Structured per-thread memory                                    |
| `artifacts`    | Agent output files                                              |
| `audit_log`    | Append-only audit trail                                         |
| `tool_results` | Idempotent tool result cache                                    |

---

## Multi-Agent Collaboration

Talon's data model supports supervisor/worker patterns via `parent_run_id` in the `runs` table. Full multi-agent collaboration (Agent SDK subagent/Task tool support) is planned in TASK-054.

---

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/my-feature`)
3. Write tests first — the project maintains 80%+ coverage
4. Run the full test suite (`npm test`)
5. Run the type checker (`npx tsc --noEmit`)
6. Run the linter (`npm run lint`)
7. Submit a pull request

### Code Conventions

- **Files**: kebab-case (`sandbox-manager.ts`)
- **Functions**: camelCase (`loadConfig()`)
- **Types/Classes**: PascalCase (`TalondDaemon`)
- **Constants**: UPPER_SNAKE_CASE (`MAX_BACKOFF_MS`)
- **Error handling**: `neverthrow` Result types for expected errors, exceptions for truly unrecoverable failures
- **Logging**: `pino` structured JSON with correlation fields (`run_id`, `thread_id`, `persona`)
- **Imports**: ESM with `.js` extensions, `type` imports where possible
- **Testing**: Vitest, aim for 80%+ coverage, mock external services only

---

## License

[MIT](LICENSE)
