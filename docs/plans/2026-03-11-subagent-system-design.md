# Sub-Agent System Design

> **Status**: Draft — awaiting review
> **Date**: 2026-03-11
> **Goal**: Reduce token usage and cost by routing mechanical tasks to cheap, fast models via a pluggable sub-agent system that sits alongside the existing Agent SDK persona.

## Problem

Every interaction with a Talon persona replays the full session via the Claude Agent SDK. A 10-turn conversation sends 100k+ tokens per turn (mostly cache-read at $0.50/1M for Opus). Rate limits on Max subscriptions drop 3-4% per interaction. Mechanical tasks like memory grooming, session summarization, and web search don't need Opus-level reasoning.

**Current cost per Opus interaction**: ~$0.48
**Haiku equivalent via API**: ~$0.06
**Savings on routable tasks**: ~87%

## Architecture Overview

```
┌─────────────────────────────────────────────┐
│ Persona (Agent SDK — Opus/Sonnet)           │
│  - Main conversation, session resume        │
│  - Full MCP tools, host tools               │
│  - Delegates to sub-agents via host tool     │
│                                             │
│  ┌─────────────────────────────────────┐    │
│  │ host tool: subagent_invoke          │    │
│  │  - name: "memory-groomer"           │    │
│  │  - input: { ... }                   │    │
│  │  - returns: structured result       │    │
│  └──────────┬──────────────────────────┘    │
└─────────────┼───────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────┐
│ Sub-Agent Runner (daemon-side)              │
│  - Loads sub-agent from folder              │
│  - Uses Vercel AI SDK (ai package)          │
│  - Provider resolved from auth config       │
│  - Stateless: no session, no resume         │
│  - Returns structured result to caller      │
└─────────────────────────────────────────────┘
```

The main persona delegates specific tasks to sub-agents via a new `subagent_invoke` host tool. Sub-agents run stateless, single-turn LLM calls using the Vercel AI SDK. They return structured results. No session state, no Agent SDK overhead.

## Sub-Agent Folder Structure

Each sub-agent lives in its own directory under a configurable `subagents/` root:

```
subagents/
  memory-groomer/
    subagent.yaml          # Manifest (required)
    index.ts               # Entry point (required) — exports run()
    lib/                   # Private utilities
    tools/                 # AI SDK tool definitions
    prompts/               # System prompt fragments (*.md, sorted)
  session-summarizer/
    subagent.yaml
    index.ts
    prompts/
  web-searcher/
    subagent.yaml
    index.ts
    tools/
    lib/
  embedding-writer/
    subagent.yaml
    index.ts
```

## Sub-Agent Manifest (`subagent.yaml`)

```yaml
name: memory-groomer
version: "0.1.0"
description: "Reviews recent memories, consolidates patterns, prunes stale entries"

# Model configuration — provider is resolved from auth config
model:
  provider: anthropic          # Key into auth.providers
  name: claude-haiku-4-5      # Model identifier for the provider
  maxTokens: 2048             # Max output tokens

# Optional: MCP servers this sub-agent can use
mcpServers:
  - name: filesystem
    transport: stdio
    command: npx
    args: ["-y", "@anthropic-ai/mcp-server-filesystem"]

# Optional: required capabilities (same format as skills)
requiredCapabilities:
  - memory.read:thread
  - memory.write:thread

# Optional: filesystem roots (for sub-agents that need file access)
rootPaths:
  - /home/talon/cf-notes
  - /home/talon/personal-notes

# Optional: timeout
timeoutMs: 30000
```

## Sub-Agent Interface

Every sub-agent exports a single `run` function with a standard interface:

```typescript
// subagents/types.ts — shared interface

export interface SubAgentContext {
  /** The thread this sub-agent is operating on */
  threadId: string;
  /** The persona that invoked this sub-agent */
  personaId: string;
  /** Pre-loaded prompt content (from prompts/*.md) */
  systemPrompt: string;
  /** Model instance (pre-configured by runner from subagent.yaml + auth) */
  model: LanguageModel;      // From Vercel AI SDK
  /** Access to all Talon internals — gated by requiredCapabilities */
  services: {
    memory: MemoryManager;
    schedules: ScheduleRepository;
    personas: PersonaRepository;
    channels: ChannelRepository;
    threads: ThreadRepository;
    messages: MessageRepository;
    runs: RunRepository;
    queue: QueueRepository;
    logger: pino.Logger;
  };
}

export interface SubAgentInput {
  /** Task-specific input (defined per sub-agent) */
  [key: string]: unknown;
}

export interface SubAgentResult {
  /** Whether the sub-agent succeeded */
  success: boolean;
  /** Human-readable summary of what happened */
  summary: string;
  /** Structured output (task-specific) */
  data?: Record<string, unknown>;
  /** Token usage for tracking */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

/** The function every sub-agent must export */
export type SubAgentRunFn = (
  ctx: SubAgentContext,
  input: SubAgentInput,
) => Promise<SubAgentResult>;
```

## Auth Configuration

Extend `talond.yaml` auth section to support multiple providers:

```yaml
auth:
  # Existing — used for Agent SDK persona
  mode: subscription    # or api_key
  apiKey: ${ANTHROPIC_API_KEY}

  # New — provider credentials for sub-agents
  providers:
    anthropic:
      apiKey: ${ANTHROPIC_API_KEY}
    openai:
      apiKey: ${OPENAI_API_KEY}
    google:
      apiKey: ${GOOGLE_AI_KEY}
```

Schema addition:

```typescript
const ProviderAuthSchema = z.object({
  apiKey: z.string(),
});

const AuthConfigSchema = z.object({
  mode: z.enum(['subscription', 'api_key']).default('subscription'),
  apiKey: z.string().optional(),
  providers: z.record(z.string(), ProviderAuthSchema).default({}),
});
```

## Persona Configuration

Personas declare which sub-agents they can use:

```yaml
personas:
  - name: assistant
    model: claude-opus-4-6
    skills: [web-search, code-runner]
    subagents: [memory-groomer, session-summarizer, web-searcher]
    capabilities:
      allow:
        - memory.read:thread
        - memory.write:thread
        - subagent.invoke:*
```

## Service Access & Capability Gating

Sub-agents receive a `services` object with access to **all** Talon repositories and managers. This gives sub-agents the same power as the daemon itself — they can read/write memory, create schedules, query messages, enqueue work, etc.

Access is controlled at two levels:

1. **Manifest declaration** — `requiredCapabilities` in `subagent.yaml` declares what the sub-agent needs. The runner refuses to load a sub-agent if the invoking persona doesn't grant those capabilities.

2. **Persona assignment** — only sub-agents listed in a persona's `subagents` array can be invoked. A persona with `subagents: [memory-groomer]` cannot invoke `web-searcher`.

The services object is **not filtered** at runtime — if a sub-agent has the capabilities, it gets the full repository. This is intentional: sub-agents are authored code (not user prompts), so we trust them to use only what they declared. The capability check prevents misconfiguration, not malicious code. Docker sandboxing (Phase 4) adds the hard isolation layer.

Example capability mappings:

| Capability | Services unlocked |
|------------|-------------------|
| `memory.read:thread` | `services.memory` (read methods) |
| `memory.write:thread` | `services.memory` (write methods) |
| `schedule.write:own` | `services.schedules` |
| `channel.send:*` | `services.channels`, `services.messages` |
| `queue.write` | `services.queue` |
| `fs.read` | `rootPaths` filesystem access (direct Node.js) |

## Host Tool: `subagent_invoke`

The main persona calls sub-agents via a new host tool:

```typescript
// Tool definition
{
  name: "subagent_invoke",
  description: "Delegate a task to a specialized sub-agent",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Sub-agent name" },
      input: { type: "object", description: "Task-specific input" },
    },
    required: ["name"],
  },
}
```

The host tools bridge validates:
1. Sub-agent name is in persona's `subagents` list
2. Sub-agent's `requiredCapabilities` are satisfied by persona
3. Loads and executes the sub-agent via `SubAgentRunner`

## Sub-Agent Runner

The runner is a daemon-side service that:

1. Loads sub-agent manifest and entry point
2. Resolves the model via Vercel AI SDK + auth config
3. Reads prompt fragments from `prompts/` directory
4. Calls the sub-agent's `run()` function
5. Tracks token usage per invocation
6. Returns the result to the host tool bridge

```typescript
// Simplified runner logic
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';

class SubAgentRunner {
  async execute(name: string, input: SubAgentInput, ctx: RunContext): Promise<SubAgentResult> {
    const manifest = this.loadManifest(name);
    const model = this.resolveModel(manifest.model);
    const systemPrompt = this.loadPrompts(name);
    const runFn = this.loadEntryPoint(name);

    return runFn(
      { threadId: ctx.threadId, personaId: ctx.personaId, systemPrompt, model, services: ctx.services },
      input,
    );
  }

  private resolveModel(config: { provider: string; name: string }): LanguageModel {
    const creds = this.authConfig.providers[config.provider];
    switch (config.provider) {
      case 'anthropic': return createAnthropic({ apiKey: creds.apiKey })(config.name);
      case 'openai':    return createOpenAI({ apiKey: creds.apiKey })(config.name);
      // ... other providers
    }
  }
}
```

## Built-in Sub-Agents (Phase 1)

### 1. `session-summarizer`

**Purpose**: Compress a long Agent SDK session into key facts before the context window overflows.

- **Model**: Haiku 4.5 (cheap, fast)
- **Input**: Last N messages from transcript
- **Output**: Structured summary (decisions, open threads, key facts)
- **Trigger**: Automatically by daemon when session exceeds token threshold, or by persona via tool call
- **Cost**: ~$0.06 per summarization vs $0.48 for Opus replay

### 2. `memory-groomer`

**Purpose**: Review recent memory entries, consolidate patterns, prune stale items. Can create schedules for recurring patterns it discovers.

- **Model**: Haiku 4.5
- **Input**: All memory items for a thread
- **Output**: List of actions taken (consolidate, prune, create-schedule)
- **Trigger**: Scheduled (e.g., twice daily via `add-schedule`)
- **Capabilities needed**: `memory.read:thread`, `memory.write:thread`, `schedule.write:own`
- **Services used**: `memory` for read/write, `schedules` to create follow-up schedules for discovered patterns

### 3. `file-searcher`

**Purpose**: Search through files (markdown, text, code) and return ranked results with paths and snippets. Saves the main persona from burning Opus tokens on file scanning.

- **Model**: Haiku 4.5
- **Input**: `{ query: string, fileTypes?: string[], maxResults?: number }`
- **Output**: Ranked list of `{ path, snippet, relevance }` objects
- **Filesystem access**: Direct Node.js `fs` + glob + ripgrep via `rootPaths` config
- **Capabilities needed**: `fs.read`
- **Future**: Add vector store for embedding-based retrieval (semantic search over file contents)

```yaml
# subagent.yaml
name: file-searcher
version: "0.1.0"
description: "Search files by content and return ranked results with snippets"

model:
  provider: anthropic
  name: claude-haiku-4-5
  maxTokens: 2048

requiredCapabilities:
  - fs.read

# Filesystem roots this sub-agent can access (operator-configured)
rootPaths:
  - /home/talon/cf-notes
  - /home/talon/personal-notes
  - /home/talon/talon/personas
```

The sub-agent:
1. Greps `rootPaths` for matches (keyword search via ripgrep or Node.js)
2. Reads surrounding context from matching files
3. Sends snippets to Haiku for relevance ranking and summarization
4. Returns top N results with file paths, line numbers, and snippets

This keeps the Opus persona out of the file-scanning loop entirely — it asks "find notes about X" and gets back a concise digest.

### 4. `web-searcher`


**Purpose**: Search the web and return a digest.

- **Model**: Haiku 4.5 or Gemini Flash (very cheap)
- **Input**: Search query + context
- **Output**: Structured search results with relevance scores
- **MCP**: Could use Brave Search MCP or direct API
- **Capabilities needed**: `net.http`

### 5. `memory-retriever`

**Purpose**: Find relevant memories for a given query using semantic search.

- **Model**: Haiku 4.5 for reranking, embedding model for initial retrieval
- **Input**: Query string + thread context
- **Output**: Ranked list of relevant memory items
- **Future**: Pairs with vector store for embedding-based retrieval

## Session Management Integration

The session-summarizer sub-agent enables a new session strategy:

```
Turn 1-10: Normal Agent SDK session resume (full replay, cache-read)
Turn 11:   Session approaching threshold (~100k tokens)
           → Daemon invokes session-summarizer sub-agent
           → Summary stored as structured memory
           → Session cleared (new session ID)
Turn 12:   Fresh session with summary injected into system prompt
           → Dramatic token reduction
```

This is transparent to the user — the persona continues the conversation with full context via the summary.

## Future: Containerized Execution

Phase 2 adds Docker isolation for sub-agents:

```yaml
# subagent.yaml
sandbox:
  enabled: true
  image: talon-subagent:latest
  networkAccess: false
  memoryMb: 512
  timeoutMs: 30000
```

The runner would:
1. Build/pull the sub-agent image
2. Mount the sub-agent folder read-only
3. Pass input via stdin, collect output via stdout
4. Enforce resource limits and timeout
5. No filesystem access to host beyond mounted paths

This reuses the existing `sandbox` infrastructure already in Talon's config schema.

## Future: Vector Store & Graph Database

These are orthogonal to the sub-agent system but pair well:

**Vector Store** (e.g., SQLite-vec, Chroma, or Qdrant):
- `embedding-writer` sub-agent generates embeddings on memory write
- `memory-retriever` sub-agent uses vector similarity for recall
- Stored alongside existing `memory_items` table

**Graph Database** (e.g., property graph in SQLite or Neo4j):
- Relationships between entities (people, projects, decisions)
- `memory-groomer` builds graph edges during consolidation
- Persona queries graph for connected context

Both would be exposed to sub-agents via the `services` object in `SubAgentContext`.

## Implementation Phases

### Phase 1: Foundation
- Auth providers config
- Sub-agent loader (manifest + entry point)
- Sub-agent runner (Vercel AI SDK integration)
- `subagent_invoke` host tool
- Persona `subagents` config field
- Token tracking for sub-agent calls

### Phase 2: Built-in Sub-Agents
- `session-summarizer`
- `memory-groomer`
- `file-searcher`
- `memory-retriever`

### Phase 3: Session Management
- Automatic session compaction via summarizer
- Summary injection into new sessions
- Configurable token threshold triggers

### Phase 4: Extended Ecosystem
- `web-searcher`
- Docker sandbox for sub-agents
- CLI: `talonctl add-subagent`, `talonctl list-subagents`
- Vector store integration
- Graph database integration

## Dependencies

New packages:
- `ai` (Vercel AI SDK core)
- `@ai-sdk/anthropic` (Anthropic provider)
- `@ai-sdk/openai` (OpenAI provider, optional)
- `@ai-sdk/google` (Google provider, optional)
- `ollama-ai-provider` (Ollama provider for local models, optional)

## Trade-offs

| Decision | Alternative | Why this way |
|----------|-------------|--------------|
| Vercel AI SDK | Direct Anthropic SDK | Provider-agnostic, consistent tool interface, active ecosystem |
| Folder-per-subagent | Monolithic handler | Isolation, independent versioning, future Docker sandboxing |
| Stateless single-turn | Session-based | Sub-agents don't need memory — they get what they need via input |
| Host tool invocation | Direct daemon routing | Persona controls delegation, same security model as other tools |
| Provider in manifest | Provider in auth only | Sub-agent author picks the right model class, operator provides creds |
