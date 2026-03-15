# Multi-Provider Agent Runner Abstraction

**RFC** | 2026-03-14 | Talon Project
**Status**: Draft v2
**GitHub Issue**: https://github.com/ivo-toby/talon/issues/58
**Last updated**: 2026-03-15 (review corrections applied, phasing restructured)

---

## 1. Problem Statement

Talon currently has a hard dependency on two Anthropic-specific execution backends:

1. **AgentRunner** (`src/daemon/agent-runner.ts`) uses the `@anthropic-ai/claude-agent-sdk` for interactive queue-item processing (the main conversation loop).
2. **BackgroundAgentManager** (`src/subagents/background/background-agent-manager.ts`) spawns `claude` CLI processes in `--print` mode for long-running background tasks.

Both paths are tightly coupled to Claude Code's APIs, flags, session model, and output format. This makes it impossible to use alternative AI coding CLIs as execution backends, which limits:

- Cost optimization (routing cheap tasks to cheaper models)
- Resilience (failing over when one provider is down)
- Capability-based routing (some tasks suit different models)
- Experimentation (A/B testing providers)

This spec defines a **pluggable provider architecture** that decouples Talon's execution pipeline from any specific AI CLI. The interface is the product — once the abstraction is solid, adding providers becomes mechanical.

### 1.1 Design Principles

1. **Decouple first, add providers later.** Phase 1 produces zero new providers — just Claude behind the new interface.
2. **The interface is the product.** A well-designed provider contract makes adding Gemini, Codex, Ollama, Mastra, or any future CLI trivial.
3. **Providers are plugins, not features.** Each provider is a self-contained adapter. Adding one should not require changes to core pipeline code.
4. **Background agents first.** Lower risk, simpler contract, proves the abstraction before touching the main runner.

### 1.2 Provider Horizon

The architecture explicitly supports an open-ended set of providers. Known candidates:

| Provider | Type | Use Case |
|---|---|---|
| **Claude Code** | SDK + CLI | Primary — streaming, sessions, caching |
| **Gemini CLI** | CLI | Large context (1M tokens), cost optimization |
| **Codex CLI** | CLI | OpenAI models, different reasoning strengths |
| **Ollama** | CLI/API | Local models, privacy, zero-cost experimentation |
| **Mastra CLI** | CLI | Multi-model orchestration framework |
| *Future CLIs* | CLI/SDK | Whatever emerges — the interface handles it |

The `ProviderName` type is a string, not a closed enum, to accommodate future providers without type changes.

---

## 2. Current State Analysis

### 2.1 Main Agent Runner (AgentRunner)

**File**: `src/daemon/agent-runner.ts`

The `AgentRunner.run()` method processes queue items by:

1. Loading the persona and resolving the session ID (for conversation continuity)
2. Building the system prompt from persona config, skills, channel context, and time
3. Importing `query` from `@anthropic-ai/claude-agent-sdk`
4. Constructing MCP server configs from persona skills + the built-in `host-tools` MCP server
5. Calling `query()` with streaming iteration, collecting `assistant` text blocks and a `result` message
6. Extracting `session_id`, token usage, and cost from the result
7. Sending the response back through the channel connector

**Key coupling points to Claude Agent SDK**:
- `import { query } from '@anthropic-ai/claude-agent-sdk'` (line 189)
- Streaming protocol: iterates `for await (const message of agentQuery)` with message types `assistant`, `result`, tool events
- Session resumption via `resume: existingSessionId` option
- `permissionMode: 'bypassPermissions'` flag
- MCP server format: `Record<string, { type: 'stdio', command, args, env }>`
- Result shape: `{ session_id, total_cost_usd, usage: { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }, is_error }`

### 2.2 Background Agent Manager

**Files**:
- `src/subagents/background/background-agent-manager.ts` (orchestrator)
- `src/subagents/background/background-agent-process.ts` (process spawning)
- `src/subagents/background/background-agent-config-builder.ts` (config/prompt files)
- `src/subagents/background/background-agent-types.ts` (types)

The background agent path spawns a `claude` CLI process with these exact flags (lines 141-152 of manager):

```
claude --print --output-format json \
  --append-system-prompt <system-prompt-content> \
  --mcp-config <path-to-mcp-config.json> \
  --strict-mcp-config \
  --dangerously-skip-permissions \
  --no-session-persistence
```

The prompt is piped via stdin. Output is captured from stdout/stderr. The MCP config is written as a JSON file with format `{ "mcpServers": { ... } }`.

**Key coupling points**:
- `claudePath` config option (defaults to `'claude'`)
- Claude-specific CLI flags
- MCP config JSON format (Claude's `{ mcpServers: {} }`)
- Output parsing assumes Claude JSON output format
- Process lifecycle (spawn, pid tracking, kill, timeout)

### 2.3 MCP Server Configuration

MCP servers flow through the system as:

1. Skills declare MCP servers in `mcp/*.json` files
2. `SkillResolver.collectMcpServers()` aggregates them
3. `buildPersonaRuntimeContext()` resolves env vars and produces `Record<string, unknown>`
4. Both agent paths pass this map to the execution backend

The host-tools MCP server is always added as a `stdio` server pointing to `dist/tools/host-tools-mcp-server.js`.

### 2.4 Configuration

`talond.yaml` has a `backgroundAgent` section:

```yaml
backgroundAgent:
  enabled: true
  maxConcurrent: 2
  defaultTimeoutMinutes: 30
```

The schema (`BackgroundAgentConfigSchema`) also includes `claudePath: z.string().default('claude')`.

---

## 3. Provider Interface

### 3.1 Core Types

```typescript
// src/providers/provider-types.ts

/**
 * Provider identifier. String type to allow future providers
 * without type changes. Known values: 'claude-code', 'gemini-cli',
 * 'codex-cli', 'ollama', 'mastra-cli'.
 */
export type ProviderName = string;

/** Normalized result from any provider execution. */
export interface ProviderResult {
  /** The text output from the agent. */
  output: string;
  /** Exit code from the process (0 = success). */
  exitCode: number | null;
  /** Whether the process was killed due to timeout. */
  timedOut: boolean;
  /** Stderr content, if any. */
  stderr: string;
  /** Token usage, if reported by the provider. */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalCostUsd?: number;
  };
}

/** Input for spawning a background agent task. */
export interface ProviderSpawnInput {
  /** The task prompt (piped to stdin or passed as argument). */
  prompt: string;
  /** System prompt to prepend. */
  systemPrompt: string;
  /** MCP servers in Talon's canonical format. */
  mcpServers: Record<string, McpServerCanonical>;
  /** Working directory for the process. */
  cwd: string;
  /** Timeout in milliseconds. */
  timeoutMs: number;
}

/**
 * Canonical MCP server definition used internally by Talon.
 * Each provider adapter translates this into the provider's native format.
 */
export interface McpServerCanonical {
  /** Transport type. All CLIs support stdio. */
  transport: 'stdio';
  /** Command to execute. */
  command: string;
  /** Command arguments as separate array elements. */
  args: string[];
  /** Environment variables for the process. */
  env?: Record<string, string>;
}

/** Provider-specific configuration from talond.yaml. */
export interface ProviderConfig {
  /** Path or command name for the CLI binary. */
  command: string;
  /** Whether this provider is enabled. */
  enabled: boolean;
  /** Context window size in tokens for this provider. */
  contextWindowTokens: number;
  /** Additional provider-specific options. */
  options?: Record<string, unknown>;
}
```

### 3.2 Provider Interface

```typescript
// src/providers/provider.ts

import type { Result } from 'neverthrow';
import type { BackgroundAgentError } from '../core/errors/error-types.js';
import type {
  ProviderName,
  ProviderResult,
  ProviderSpawnInput,
  ProviderConfig,
} from './provider-types.js';

/**
 * Contract that every agent CLI provider must implement.
 *
 * Providers are stateless adapters: they translate Talon's canonical
 * inputs into provider-specific CLI invocations and normalize the output.
 * Process lifecycle (pid tracking, timeout, kill) is handled by the
 * shared BackgroundAgentProcess class.
 */
export interface AgentProvider {
  /** Unique provider identifier. */
  readonly name: ProviderName;

  /**
   * Build the CLI argument array for a background agent invocation.
   *
   * The returned args are passed to child_process.spawn() along with
   * the command from ProviderConfig. The provider must include all
   * flags needed for non-interactive, headless, JSON-output execution.
   */
  buildArgs(input: ProviderSpawnInput): string[];

  /**
   * Write any provider-specific configuration files to disk
   * (e.g., MCP config, system prompt files).
   *
   * Returns paths to created files so they can be cleaned up later.
   */
  writeConfigFiles(
    input: ProviderSpawnInput,
    tempDir: string,
  ): Result<ProviderConfigFiles, BackgroundAgentError>;

  /**
   * Parse the raw process output into a normalized ProviderResult.
   *
   * Each CLI has a different output format. This method normalizes
   * stdout/stderr/exitCode into the common ProviderResult shape.
   */
  parseOutput(raw: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }): ProviderResult;

  /**
   * Whether stdin should be used to deliver the prompt.
   * Claude Code reads the prompt from stdin in --print mode.
   * Other CLIs may take it as a positional argument or flag.
   */
  readonly promptViaStdin: boolean;

  /**
   * Estimate context usage from token metrics.
   *
   * IMPORTANT: The semantics of token metrics differ across providers.
   * Claude's `cache_read_input_tokens` measures cached content (a subset
   * of input). Other providers report total `input_tokens`. These are NOT
   * equivalent — thresholds must be calibrated per provider.
   *
   * See Section 15 for details.
   */
  estimateContextUsage(usage: AgentUsage): ContextUsage;
}

/** Files written by writeConfigFiles that need cleanup. */
export interface ProviderConfigFiles {
  /** Path to the MCP configuration file. */
  mcpConfigPath: string;
  /** Path to the system prompt file (if written). */
  promptPath?: string;
  /** Any additional files that need cleanup. */
  additionalPaths?: string[];
}
```

---

## 4. Provider Implementations

### 4.1 Claude Code Provider

The only provider implemented in Phase 1. This is a direct extraction of the current Claude-specific logic into the provider interface.

```typescript
// src/providers/claude-code-provider.ts

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ok, err, type Result } from 'neverthrow';
import type { AgentProvider, ProviderConfigFiles } from './provider.js';
import type { ProviderSpawnInput, ProviderResult, McpServerCanonical } from './provider-types.js';
import { BackgroundAgentError } from '../core/errors/error-types.js';

export class ClaudeCodeProvider implements AgentProvider {
  readonly name = 'claude-code';
  readonly promptViaStdin = true;

  constructor(private readonly contextWindowTokens: number = 200_000) {}

  buildArgs(input: ProviderSpawnInput): string[] {
    return [
      '--print',
      '--output-format', 'json',
      '--dangerously-skip-permissions',
      '--no-session-persistence',
    ];
  }

  writeConfigFiles(
    input: ProviderSpawnInput,
    tempDir: string,
  ): Result<ProviderConfigFiles, BackgroundAgentError> {
    try {
      // Write MCP config in Claude's native format
      const mcpConfigPath = join(tempDir, 'mcp-config.json');
      const claudeMcpServers: Record<string, unknown> = {};
      for (const [name, server] of Object.entries(input.mcpServers)) {
        claudeMcpServers[name] = {
          type: server.transport,
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {}),
        };
      }
      writeFileSync(mcpConfigPath, JSON.stringify({ mcpServers: claudeMcpServers }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });

      // Write system prompt
      const promptPath = join(tempDir, 'system-prompt.txt');
      writeFileSync(promptPath, input.systemPrompt, { encoding: 'utf8', mode: 0o600 });

      return ok({ mcpConfigPath, promptPath });
    } catch (cause) {
      return err(new BackgroundAgentError(
        `Claude Code: failed to write config files: ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ));
    }
  }

  parseOutput(raw: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }): ProviderResult {
    let usage: ProviderResult['usage'];

    try {
      const parsed = JSON.parse(raw.stdout);
      if (parsed.usage) {
        usage = {
          inputTokens: parsed.usage.input_tokens ?? 0,
          outputTokens: parsed.usage.output_tokens ?? 0,
          cacheReadTokens: parsed.usage.cache_read_input_tokens,
          cacheWriteTokens: parsed.usage.cache_creation_input_tokens,
          totalCostUsd: parsed.total_cost_usd,
        };
      }
    } catch {
      // Non-JSON output; treat stdout as plain text.
    }

    return {
      output: raw.stdout,
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
      stderr: raw.stderr,
      usage,
    };
  }

  estimateContextUsage(usage: AgentUsage): ContextUsage {
    // Claude reports cache_read_input_tokens — a SUBSET of input that was
    // served from cache. This grows as conversation history accumulates.
    const cacheRead = usage.cacheReadTokens ?? 0;
    return {
      ratio: cacheRead / this.contextWindowTokens,
      inputTokens: usage.inputTokens,
      rawMetric: cacheRead,
      rawMetricName: 'cache_read_input_tokens',
    };
  }

  /**
   * Build the full spawn args including config file references.
   * Called by the manager after writeConfigFiles.
   */
  buildFullArgs(
    input: ProviderSpawnInput,
    files: ProviderConfigFiles,
  ): string[] {
    const args = this.buildArgs(input);

    if (files.promptPath) {
      const { readFileSync } = require('node:fs');
      const content = readFileSync(files.promptPath, 'utf8');
      args.push('--append-system-prompt', content);
    }

    args.push('--mcp-config', files.mcpConfigPath);
    args.push('--strict-mcp-config');

    return args;
  }
}
```

### 4.2 Gemini CLI Provider (Phase 2)

> **Not implemented in Phase 1.** Included here as the reference design for the first non-Claude provider.

```typescript
// src/providers/gemini-cli-provider.ts

export class GeminiCliProvider implements AgentProvider {
  readonly name = 'gemini-cli';
  readonly promptViaStdin = false; // Gemini uses -p flag

  constructor(private readonly contextWindowTokens: number = 1_000_000) {}

  buildArgs(input: ProviderSpawnInput): string[] {
    // NOTE: --non-interactive may not be a valid flag. Headless mode is
    // triggered by non-TTY environment (piped stdin) or -p flag.
    // Verify against current Gemini CLI version before using.
    //
    // WARNING: --output-format json has known issues (GitHub issue #9009).
    // Test thoroughly before relying on JSON output.
    return [
      '-p', input.prompt,
      '--output-format', 'json',
      '--yolo',
    ];
  }

  writeConfigFiles(
    input: ProviderSpawnInput,
    tempDir: string,
  ): Result<ProviderConfigFiles, BackgroundAgentError> {
    try {
      const geminiDir = join(tempDir, '.gemini');
      mkdirSync(geminiDir, { recursive: true, mode: 0o700 });

      const settingsPath = join(geminiDir, 'settings.json');
      const mcpServers: Record<string, unknown> = {};
      for (const [name, server] of Object.entries(input.mcpServers)) {
        mcpServers[name] = {
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {}),
        };
      }

      writeFileSync(settingsPath, JSON.stringify({ mcpServers }, null, 2), {
        encoding: 'utf8',
        mode: 0o600,
      });

      const promptPath = join(tempDir, 'system-prompt.txt');
      writeFileSync(promptPath, input.systemPrompt, { encoding: 'utf8', mode: 0o600 });

      return ok({ mcpConfigPath: settingsPath, promptPath });
    } catch (cause) {
      return err(new BackgroundAgentError(
        `Gemini CLI: failed to write config files: ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ));
    }
  }

  parseOutput(raw: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }): ProviderResult {
    let usage: ProviderResult['usage'];

    try {
      const parsed = JSON.parse(raw.stdout);
      if (parsed.stats?.perModel) {
        const totalInput = Object.values(parsed.stats.perModel)
          .reduce((sum: number, m: any) => sum + (m.inputTokens ?? 0), 0);
        const totalOutput = Object.values(parsed.stats.perModel)
          .reduce((sum: number, m: any) => sum + (m.outputTokens ?? 0), 0);
        usage = { inputTokens: totalInput as number, outputTokens: totalOutput as number };
      }
    } catch {
      // Non-JSON output — may be caused by --output-format json bug (issue #9009)
    }

    return { output: raw.stdout, exitCode: raw.exitCode, timedOut: raw.timedOut, stderr: raw.stderr, usage };
  }

  estimateContextUsage(usage: AgentUsage): ContextUsage {
    // Gemini reports total input_tokens, NOT cached subset.
    // This means the ratio will be higher than Claude's for the same
    // conversation length. Threshold must be calibrated accordingly —
    // a 0.7 threshold here means something different than 0.7 for Claude.
    const input = usage.inputTokens;
    return {
      ratio: input / this.contextWindowTokens,
      inputTokens: input,
      rawMetric: input,
      rawMetricName: 'input_tokens',
    };
  }

  buildFullArgs(input: ProviderSpawnInput, files: ProviderConfigFiles): string[] {
    // Prepend system prompt to user prompt (no --system-prompt flag in Gemini CLI)
    // TODO: Check if Gemini CLI has added --system-instruction flag
    const fullPrompt = `${input.systemPrompt}\n\n---\n\n${input.prompt}`;
    return ['-p', fullPrompt, '--output-format', 'json', '--yolo'];
  }
}
```

### 4.3 Codex CLI Provider (Phase 2+)

> **Not implemented in Phase 1.** Reference design — flag names and output format need verification with a real Codex CLI run before implementation.

```typescript
// src/providers/codex-cli-provider.ts

export class CodexCliProvider implements AgentProvider {
  readonly name = 'codex-cli';
  readonly promptViaStdin = false; // Codex uses positional args with `exec`

  constructor(private readonly contextWindowTokens: number = 200_000) {}

  buildArgs(input: ProviderSpawnInput): string[] {
    // Codex CLI non-interactive mode: `codex exec "prompt" --json`
    //
    // CORRECTED: The flag is `-a` / `--approval-policy`, NOT `--approval-mode`.
    // `never` is the MOST PERMISSIVE mode — it skips all approval prompts.
    // Combined with appropriate sandbox_mode for the execution environment.
    //
    // NOTE: `--ephemeral` flag is UNVERIFIED — may not exist in current
    // Codex CLI. Verify before using.
    //
    // WARNING: Long prompts as positional arguments may hit ARG_MAX.
    // Consider using stdin or temp files for system prompt + long tasks.
    return [
      'exec',
      input.prompt,
      '--json',
      '-a', 'never',
    ];
  }

  writeConfigFiles(
    input: ProviderSpawnInput,
    tempDir: string,
  ): Result<ProviderConfigFiles, BackgroundAgentError> {
    try {
      const codexDir = join(tempDir, '.codex');
      mkdirSync(codexDir, { recursive: true, mode: 0o700 });

      const configPath = join(codexDir, 'config.toml');
      const tomlLines: string[] = [];

      // System prompt as config key
      tomlLines.push(`system_prompt = ${JSON.stringify(input.systemPrompt)}`);
      tomlLines.push('');

      // MCP servers — CORRECTED: use separate command and args array,
      // NOT a joined command string. Joined strings break on paths with spaces.
      for (const [name, server] of Object.entries(input.mcpServers)) {
        tomlLines.push(`[mcp_servers.${name}]`);
        tomlLines.push(`command = ${JSON.stringify(server.command)}`);
        // TOML array format for args
        const argsToml = server.args.map(a => JSON.stringify(a)).join(', ');
        tomlLines.push(`args = [${argsToml}]`);

        if (server.env && Object.keys(server.env).length > 0) {
          tomlLines.push(`[mcp_servers.${name}.env]`);
          for (const [k, v] of Object.entries(server.env)) {
            tomlLines.push(`${k} = ${JSON.stringify(v)}`);
          }
        }
        tomlLines.push('');
      }

      writeFileSync(configPath, tomlLines.join('\n'), { encoding: 'utf8', mode: 0o600 });

      const promptPath = join(tempDir, 'system-prompt.txt');
      writeFileSync(promptPath, input.systemPrompt, { encoding: 'utf8', mode: 0o600 });

      return ok({ mcpConfigPath: configPath, promptPath });
    } catch (cause) {
      return err(new BackgroundAgentError(
        `Codex CLI: failed to write config files: ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ));
    }
  }

  parseOutput(raw: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }): ProviderResult {
    let output = raw.stdout;
    let usage: ProviderResult['usage'];

    // CORRECTED: Codex --json outputs JSONL (newline-delimited JSON events),
    // NOT a single JSON object. Parse line-by-line.
    //
    // Known event types: thread.started, turn.started, turn.completed, item.*
    // Agent text is in item events, usage is in turn.completed events.
    //
    // NOTE: Exact event shapes (field names like `text` vs `content`)
    // need verification with a real Codex run.
    try {
      const lines = raw.stdout.trim().split('\n').filter(Boolean);
      let lastAgentMessage = '';
      let lastUsage: ProviderResult['usage'];

      for (const line of lines) {
        try {
          const event = JSON.parse(line);

          // Collect agent message text from item events
          if (event.type?.startsWith('item.') && event.item?.type === 'agent_message') {
            lastAgentMessage = event.item.text ?? event.item.content ?? lastAgentMessage;
          }

          // Collect usage from turn.completed events
          if (event.type === 'turn.completed' && event.usage) {
            lastUsage = {
              inputTokens: event.usage.input_tokens ?? 0,
              outputTokens: event.usage.output_tokens ?? 0,
            };
          }
        } catch {
          // Skip non-JSON lines
        }
      }

      if (lastAgentMessage) output = lastAgentMessage;
      if (lastUsage) usage = lastUsage;
    } catch {
      // Fallback: use raw stdout
    }

    return { output, exitCode: raw.exitCode, timedOut: raw.timedOut, stderr: raw.stderr, usage };
  }

  estimateContextUsage(usage: AgentUsage): ContextUsage {
    // Same caveat as Gemini: input_tokens is total input, not cached subset.
    const input = usage.inputTokens;
    return {
      ratio: input / this.contextWindowTokens,
      inputTokens: input,
      rawMetric: input,
      rawMetricName: 'input_tokens',
    };
  }

  buildFullArgs(input: ProviderSpawnInput, _files: ProviderConfigFiles): string[] {
    return this.buildArgs(input);
  }
}
```

### 4.4 Future Providers

Adding a new provider requires:

1. Create `src/providers/<name>-provider.ts` implementing `AgentProvider`
2. Register it in `ProviderRegistry` factory map
3. Add config entry in `talond.yaml`
4. Done — no core pipeline changes needed

Example candidates:

- **Ollama**: Local models via `ollama run <model> --format json`. No MCP support (yet), so `writeConfigFiles()` would skip MCP config. System prompt via `--system` flag.
- **Mastra CLI**: Multi-model orchestration. MCP support TBD. Would need custom output parsing.

---

## 5. Provider Registry

```typescript
// src/providers/provider-registry.ts

import type { AgentProvider } from './provider.js';
import type { ProviderName, ProviderConfig } from './provider-types.js';

/**
 * Registry of available agent providers.
 *
 * Providers are created once at daemon startup from config. The registry
 * provides lookup by name and reports which providers are available.
 *
 * The registry accepts a factory map, making it open to new providers
 * without modifying the registry itself.
 */
export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, {
    provider: AgentProvider;
    config: ProviderConfig;
  }>();

  constructor(
    configs: Record<string, ProviderConfig>,
    factories: Record<string, () => AgentProvider>,
  ) {
    for (const [name, config] of Object.entries(configs)) {
      if (config.enabled && factories[name]) {
        this.providers.set(name, {
          provider: factories[name](),
          config,
        });
      }
    }
  }

  get(name: ProviderName): { provider: AgentProvider; config: ProviderConfig } | undefined {
    return this.providers.get(name);
  }

  getDefault(preferredOrder: ProviderName[]): { provider: AgentProvider; config: ProviderConfig } | undefined {
    for (const name of preferredOrder) {
      const entry = this.providers.get(name);
      if (entry) return entry;
    }
    // Fallback: return first enabled
    return this.providers.values().next().value;
  }

  listEnabled(): ProviderName[] {
    return [...this.providers.keys()];
  }
}
```

---

## 6. MCP Server Passthrough

All three initial CLI tools support MCP via stdio transport, but each uses a different config format:

| Feature | Claude Code | Gemini CLI | Codex CLI |
|---|---|---|---|
| Config format | JSON | JSON | TOML |
| Config location | `--mcp-config <path>` | `.gemini/settings.json` in cwd | `.codex/config.toml` in cwd |
| Server key | `mcpServers` | `mcpServers` | `mcp_servers` |
| Transport field | `type: "stdio"` | (implicit) | (implicit) |
| Command format | `command` + `args` array | `command` + `args` array | `command` + `args` array |
| Env vars | `env: {}` | `env: {}` | `[mcp_servers.X.env]` table |

**Strategy**: Talon maintains a single canonical `McpServerCanonical` type (see Section 3.1). Each provider's `writeConfigFiles()` method translates this into the native format. This keeps the core pipeline provider-agnostic.

The existing `buildPersonaRuntimeContext()` and `BackgroundAgentConfigBuilder` already produce `Record<string, unknown>` MCP server maps. The refactored flow:

1. `buildPersonaRuntimeContext()` returns `McpServerCanonical` objects (type-safe, not `unknown`)
2. The background agent handler passes them to `BackgroundAgentManager.spawn()`
3. The manager delegates to the provider's `writeConfigFiles()` which writes the native format

The host-tools MCP server is always added as a canonical server regardless of provider:

```typescript
const hostToolsServer: McpServerCanonical = {
  transport: 'stdio',
  command: 'node',
  args: [join(import.meta.dirname, '../../dist/tools/host-tools-mcp-server.js')],
  env: {
    TALOND_SOCKET: bridgePath,
    TALOND_RUN_ID: runId,
    TALOND_THREAD_ID: threadId,
    TALOND_PERSONA_ID: personaId,
    TALOND_ALLOWED_TOOLS: allowedTools.join(','),
  },
};
```

---

## 7. Task Routing

### 7.1 Phase 1: Single Provider (Claude)

No routing needed. All tasks go to `claude-code`. The routing infrastructure is wired up but only one provider is registered.

### 7.2 Phase 2: Explicit Selection

Tasks specify which provider to use. The selection flows through:

1. **Config-level default**: `talond.yaml` specifies the default provider
2. **Per-task override**: The `background_agent` tool gains an optional `provider` parameter

```yaml
# talond.yaml
backgroundAgent:
  enabled: true
  maxConcurrent: 2
  defaultTimeoutMinutes: 30
  defaultProvider: claude-code
  providers:
    claude-code:
      enabled: true
      command: claude
    gemini-cli:
      enabled: true
      command: gemini
```

The `background_agent` tool schema adds:

```typescript
provider: {
  type: 'string',
  description: 'Which CLI provider to use. Defaults to config.',
}
```

### 7.3 Phase 3+: Smart Routing (Future)

Once usage data is collected, add heuristic routing:

- **Cost routing**: Route to the cheapest provider that supports the required capabilities
- **Load balancing**: Distribute across providers when multiple are available
- **Capability routing**: Some tasks require specific tool support
- **Failover**: Automatically retry on a different provider if one fails

---

## 8. Output Normalization

Each provider returns different output shapes. The `parseOutput()` method on each provider normalizes to `ProviderResult`:

### Claude Code JSON output
```json
{
  "result": "Agent response text...",
  "session_id": "sess_abc123",
  "total_cost_usd": 0.042,
  "usage": {
    "input_tokens": 1500,
    "output_tokens": 800,
    "cache_read_input_tokens": 500,
    "cache_creation_input_tokens": 200
  },
  "is_error": false
}
```

### Gemini CLI JSON output
```json
{
  "response": "Agent response text...",
  "stats": {
    "totalTokens": 2300,
    "perModel": {
      "gemini-2.5-pro": {
        "inputTokens": 1500,
        "outputTokens": 800
      }
    }
  }
}
```

### Codex CLI JSONL output (multiple events)
```jsonl
{"type": "thread.started", ...}
{"type": "turn.started", ...}
{"type": "item.completed", "item": {"type": "agent_message", "text": "Agent response..."}}
{"type": "turn.completed", "usage": {"input_tokens": 1500, "output_tokens": 800}}
```

> **Note**: Codex event shapes above are approximate. Exact field names need verification with a real Codex run. See Known Risks section.

---

## 9. Configuration Schema Changes

```typescript
// Addition to config-schema.ts

export const ProviderConfigSchema = z.object({
  enabled: z.boolean().default(false),
  command: z.string(),
  contextWindowTokens: z.number().int().min(1000).default(200_000),
  options: z.record(z.string(), z.unknown()).optional(),
});

export const BackgroundAgentConfigSchema = z.object({
  enabled: z.boolean().default(true),
  maxConcurrent: z.number().int().min(1).max(10).default(3),
  defaultTimeoutMinutes: z.number().int().min(1).max(480).default(30),
  defaultProvider: z.string().default('claude-code'),
  providers: z.record(z.string(), ProviderConfigSchema).default({
    'claude-code': {
      enabled: true,
      command: 'claude',
      contextWindowTokens: 200_000,
    },
  }),
  // DEPRECATED: kept for backward compatibility, maps to providers.claude-code.command
  claudePath: z.string().optional(),
});
```

The `claudePath` field is kept but deprecated. During config loading, if `claudePath` is set and `providers` is not explicitly configured, it maps to `providers['claude-code'].command`.

---

## 10. Error Handling and Failover

### 10.1 Error Categories

| Error | Handling |
|---|---|
| Provider binary not found | Fail immediately with clear error message. Log which command was attempted. |
| MCP config write failure | Fail immediately. Cleanup temp files. |
| Process spawn failure | Mark task as `failed`. Do not retry with same provider. |
| Process timeout | Mark as `timed_out`. Kill process. Cleanup. |
| Non-zero exit code | Mark as `failed`. Store stderr in task error field. |
| JSON parse failure | Treat stdout as plain text output. Log warning. |

### 10.2 CLI Process Spawn Safety

The `spawnCli` utility must guard against double resolve/reject from concurrent `error` and `close` events:

```typescript
function spawnCli(opts: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void) => {
      if (!settled) { settled = true; fn(); }
    };

    const child = spawn(opts.command, opts.args, { cwd: opts.cwd });

    child.on('error', (err) => settle(() => reject(err)));
    child.on('close', (code) => settle(() => resolve({ exitCode: code, ... })));

    // Timeout handling
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      settle(() => resolve({ exitCode: null, timedOut: true, ... }));
    }, opts.timeoutMs);
  });
}
```

### 10.3 Failover (Phase 3+)

When a provider fails and failover is enabled:

1. Check if another enabled provider is available
2. Retry the task with the fallback provider
3. Record the failover in the task metadata for observability
4. Limit failover attempts to 1 (no cascading retries)

For Phases 1-2, there is no automatic failover. Tasks that fail are marked as `failed` and the notification is sent to the thread as today.

### 10.4 Health Checks

Add a simple binary-exists check at startup:

```typescript
async function checkProviderAvailable(command: string): Promise<boolean> {
  try {
    execFileSync(command, ['--version'], { timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}
```

Run this during daemon bootstrap for each enabled provider. Log warnings for unavailable providers and disable them.

---

## 11. Migration Path

### Phase 1: Decouple — Extract Provider Interface (non-breaking)

**Goal**: Claude Code works identically behind the new provider interface. Zero new providers. Prove the abstraction.

1. Create `src/providers/` directory with types, interfaces, registry
2. Implement `ClaudeCodeProvider` as the single provider (both SDK strategy for main runner, CLI strategy for background agents)
3. Extract Claude-specific logic from `AgentRunner.run()` into `ClaudeCodeProvider.createStrategy()`
4. Refactor `AgentRunner` to dispatch via strategy type (`sdk` vs `cli`)
5. Refactor `BackgroundAgentManager` to accept an `AgentProvider` via dependency injection
6. Remove `BackgroundAgentConfigBuilder` — logic moves into provider `writeConfigFiles()`
7. Refactor `ContextRoller` to accept `ContextUsage` (ratio-based) instead of raw `cacheReadTokens`
8. Update config schemas with backward-compatible defaults
9. All existing tests pass without changes

**Key invariant**: After Phase 1, `talond.yaml` with no changes produces identical behavior. `ClaudeCodeProvider` is the only provider, same SDK streaming, same session resumption.

**Critical Phase 1 task**: The `ContextRoller` refactor to use ratios MUST happen in Phase 1. Without it, any future non-Claude provider would silently skip context rotation (receiving 0 for `cacheReadTokens`), letting context grow unbounded.

### Phase 2: First Non-Claude Provider (background agents only)

**Goal**: Add Gemini CLI as a second provider for background agents. Validate the interface with a real non-Claude CLI.

1. Verify Gemini CLI flags and JSON output format (see Known Risks)
2. Implement `GeminiCliProvider`
3. Register in `ProviderRegistry` factory map
4. Wire the `provider` parameter through `background_agent` tool
5. Add integration tests (skip if `gemini` CLI not installed)
6. Test with real background agent tasks
7. Add "Waiting for agent..." channel notification for CLI-strategy providers (longer latency than SDK)

### Phase 3: Additional Providers

Add providers one by one based on need:

1. **Codex CLI** — verify flags (`-a never`, JSONL output shapes) with a real run first
2. **Ollama** — local models, no MCP support (skip MCP config in `writeConfigFiles`)
3. **Mastra CLI** — when/if it matures enough
4. **Main runner extension** — when a non-Claude provider proves stable in background agents, add CLI strategy support to the main runner

Each provider addition follows the same pattern:
1. Verify CLI flags and output format
2. Implement provider class
3. Register in factory map
4. Add config entry
5. Test

### Phase 4: Smart Routing, Failover, Cost Optimization

1. Per-persona provider override (already wired in Phase 2 config)
2. Automatic failover when a provider errors (with context loss warning)
3. Cost tracking per provider
4. Usage analytics
5. Provider affinity enforcement (threads stay on their original provider)

---

## 12. File Structure

```
src/providers/
  provider-types.ts          # Core types (ProviderName, ProviderResult, AgentRunInput, etc.)
  provider.ts                # AgentProvider interface + ExecutionStrategy types
  provider-registry.ts       # Registry for looking up providers
  claude-code-provider.ts    # Claude Code adapter (SDK + CLI strategies)
  cli-process-runner.ts      # Shared CLI spawn/wait/parse utility (with race condition guard)
  index.ts                   # Public exports
```

Phase 2+ adds:
```
  gemini-cli-provider.ts     # Gemini CLI adapter
  codex-cli-provider.ts      # Codex CLI adapter
  ollama-provider.ts         # Ollama adapter
```

Modified files:

```
src/core/config/config-schema.ts     # Updated BackgroundAgentConfigSchema
src/daemon/agent-runner.ts           # Refactored to use provider strategies
src/daemon/context-roller.ts         # Accept ContextUsage instead of raw cacheReadTokens
src/daemon/daemon-context.ts         # Add ProviderRegistry to context
src/daemon/daemon-bootstrap.ts       # Create ProviderRegistry, wire into runner + manager
src/subagents/background/
  background-agent-manager.ts        # Accept provider via DI, delegate to it
  background-agent-config-builder.ts # Removed — logic moves to providers
src/tools/host-tools/background-agent.ts  # Add optional `provider` field to args
src/personas/persona-types.ts        # Add optional `provider` field
```

---

## 13. Resource Considerations

This system runs on a 2-core, 4GB RAM Debian VM. Key constraints:

- **Concurrency**: The existing `maxConcurrent: 2` limit applies across all providers. Do not raise it.
- **Memory**: Each background agent process typically uses 200-500MB. With `maxConcurrent: 2`, peak memory for background agents is ~1GB.
- **Main runner memory**: The main runner is a single process at a time per thread. CLI strategy providers spawn a child process similar to background agents.
- **Disk**: Temp files for MCP configs are small (<10KB each) and cleaned up after task completion.
- **CPU**: The CLI processes are I/O-bound. CPU is not a bottleneck.

No changes to resource limits are needed.

---

## 14. Testing Strategy

### Unit Tests

- Each provider's `buildArgs()`, `writeConfigFiles()`, and `parseOutput()` methods
- `ProviderRegistry` lookup and default selection
- `BackgroundAgentManager` with a mock provider (verify it calls the provider interface correctly)
- Config schema backward compatibility (old `claudePath` maps correctly)
- SDK strategy execution with mocked `query()` call
- CLI strategy execution with mock CLI process
- `ContextRoller` with `ContextUsage` input (ratio-based)
- `spawnCli` race condition guard (error + close events)

### Integration Tests

- Spawn each CLI with a trivial prompt and verify output parsing
- Guard with `describe.skipIf(!commandExists('gemini'))` for optional providers
- Verify MCP config files are written in the correct format for each provider
- Verify cleanup happens on success, failure, and timeout

### Existing Test Compatibility

- All existing `BackgroundAgentManager` tests must pass with `ClaudeCodeProvider` injected
- The `background-agent-process.test.ts` tests are provider-agnostic
- All existing `AgentRunner` tests must pass with Claude SDK strategy injected

---

## 15. Context Roller Compatibility

**Critical coupling**: The `ContextRoller` uses `cacheReadTokens` to determine when the context window is nearing capacity. This is an Anthropic-specific metric.

### Current behavior

```typescript
// context-roller.ts line 82-84
async checkAndRotate(threadId, personaId, cacheReadTokens) {
  if (cacheReadTokens < this.deps.thresholdTokens) return;
  // ... trigger summarization and session rotation
}
```

### Problem: Metric Semantics Differ

| Provider | Metric | What it measures | Implication |
|---|---|---|---|
| Claude Code | `cache_read_input_tokens` | Cached subset of input (grows with history) | Proxy for "how much history is cached" |
| Gemini CLI | `input_tokens` (via `stats.perModel`) | **Total** input tokens | Includes system prompt + history + current turn |
| Codex CLI | `input_tokens` (via `turn.completed`) | **Total** input tokens | Same as Gemini |

**`cache_read_input_tokens` and `input_tokens` are NOT equivalent.** Claude's metric is a subset; Gemini/Codex's is the total. Using the same threshold for both would cause non-Claude providers to trigger rotation much earlier than intended.

### Fix: Ratio-Based with Per-Provider Calibration

Normalize to a **context usage ratio** (0.0 - 1.0), but acknowledge that the ratio means different things:

```typescript
export interface ContextUsage {
  /** 0.0 to 1.0 — how full is the context window. */
  ratio: number;
  /** Raw input tokens used this turn. */
  inputTokens: number;
  /** Provider-specific raw value (for logging). */
  rawMetric: number;
  /** What the raw metric represents. */
  rawMetricName: string;
}
```

Each provider computes its own ratio via `estimateContextUsage()`. The `ContextRoller` threshold (`thresholdRatio`) should be configurable per provider:

```yaml
agentRunner:
  providers:
    claude-code:
      contextWindowTokens: 200000
      rotationThreshold: 0.7    # 70% of cache reads = nearing capacity
    gemini-cli:
      contextWindowTokens: 1000000
      rotationThreshold: 0.8    # Higher threshold — 1M context has more room
    codex-cli:
      contextWindowTokens: 200000
      rotationThreshold: 0.6    # Lower — total input grows faster than cache reads
```

### Rotation strategy differences

| Provider | Rotation action | Context continuity |
|---|---|---|
| Claude Code | Clear session ID, ContextAssembler injects summary on next run | Seamless — new session picks up summary |
| CLI providers | Rebuild full prompt with summary prepended (context stuffing) | Already the primary mechanism — each invocation is standalone |

---

## 16. Main Runner: The Problem

The current `AgentRunner.run()` is a 400+ line method tightly coupled to the Claude Agent SDK:

| Coupling point | Claude SDK specific | Portable? |
|---|---|---|
| `import { query } from '@anthropic-ai/claude-agent-sdk'` | SDK function | No |
| `for await (const message of agentQuery)` | Streaming async iterator | CLI tools do not stream |
| `agentOptions.resume = existingSessionId` | Session resumption | Only Claude has this |
| `message.type === 'assistant'` / `'result'` | Typed stream events | Provider-specific |
| `permissionMode: 'bypassPermissions'` | SDK option | Maps to CLI flags |
| `result.usage.cache_read_input_tokens` | Anthropic metric | See Section 15 |

The fundamental asymmetry: Claude Agent SDK provides an in-process streaming API. Other CLIs are external binaries that produce output on stdout. There is no streaming SDK for them.

---

## 17. Main Runner: Two Execution Strategies

### 17.1 Strategy interfaces

```typescript
// src/providers/execution-strategy.ts

/**
 * SDKStrategy — used when we have a native SDK with streaming,
 * session resumption, and typed events. Currently only Claude.
 */
export interface SDKExecutionStrategy {
  readonly type: 'sdk';
  readonly supportsSessionResumption: true;
  run(input: AgentRunInput): AsyncIterable<AgentStreamEvent>;
}

/**
 * CLIStrategy — used when we invoke a CLI tool in print/exec mode.
 * No streaming, no session resumption. Prompt in, response out.
 */
export interface CLIExecutionStrategy {
  readonly type: 'cli';
  readonly supportsSessionResumption: false;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}

export type ExecutionStrategy = SDKExecutionStrategy | CLIExecutionStrategy;
```

### 17.2 Provider-agnostic types

```typescript
export interface AgentRunInput {
  prompt: string;
  systemPrompt: string;
  mcpServers: Record<string, McpServerCanonical>;
  cwd: string;
  model: string;
  maxTurns: number;
  timeoutMs: number;
  sessionId?: string;
}

export interface AgentRunResult {
  output: string;
  sessionId?: string;
  usage: AgentUsage;
  isError: boolean;
}

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCostUsd?: number;
}

export type AgentStreamEvent =
  | { type: 'text'; content: string }
  | { type: 'tool_use'; tool: string }
  | { type: 'result'; result: AgentRunResult }
  | { type: 'error'; message: string };
```

### 17.3 How the AgentRunner dispatches

```typescript
const provider = this.providerRegistry.get(providerName);
const strategy = provider.createStrategy(provider.config);

if (strategy.type === 'sdk') {
  // Streaming path: typing indicators with 4s keep-alive, real-time text capture
  const stream = strategy.run(runInput);
  for await (const event of stream) {
    if (event.type === 'text') outputText += event.content;
    if (event.type === 'result') { usage = event.result.usage; sessionId = event.result.sessionId; }
  }
} else {
  // CLI path: single typing indicator, wait for completion
  connector?.sendTyping?.(externalId).catch(() => {});
  const result = await strategy.run(runInput);
  outputText = result.output;
  usage = result.usage;
}

// Context rotation uses normalized usage from the provider
const contextUsage = provider.estimateContextUsage(usage);
await this.ctx.contextRoller?.checkAndRotate(threadId, personaId, contextUsage);
```

---

## 18. Main Runner: Session Management

### 18.1 The asymmetry

| Capability | Claude Code SDK | CLI Providers |
|---|---|---|
| Session resumption | Yes (`resume: sessionId`) | No |
| Multi-turn in single process | Yes (streaming) | No (exits after response) |
| Conversation memory | Managed by SDK | None — ContextAssembler fills the gap |

### 18.2 Conversation continuity for CLI providers

**The infrastructure already exists.** The `ContextAssembler` builds a "Previous Context" section for fresh sessions. For CLI strategy providers, `resolvedSessionId` is always undefined, so `ContextAssembler.assemble()` always runs. No new code needed.

### 18.3 Tradeoff comparison

| | Claude (SDK strategy) | CLI strategy providers |
|---|---|---|
| Conversation continuity | Session resumption (fast, exact) | Context reconstruction (slower, lossy) |
| Token cost per turn | Low after turn 1 (cache hits) | Higher (full context re-sent every turn) |
| Streaming | Real-time text blocks | No streaming, single response |

### 18.4 Session tracking for CLI providers

The `SessionTracker` and `sessionId` fields are simply unused for CLI providers. The runner already conditionally stores session IDs. No schema changes needed.

---

## 19. Main Runner: Provider Affinity

### 19.1 Thread-level affinity

Threads have **provider affinity**. Once a thread starts with a provider, it stays on that provider. This avoids lossy context switches.

```typescript
let threadProvider = this.resolveProvider(loadedPersona);

const firstRun = this.ctx.repos.run.getFirstByThread(item.threadId);
if (firstRun.isOk() && firstRun.value?.provider_name) {
  threadProvider = firstRun.value.provider_name;
}
```

Requires adding a `provider_name` column to the `runs` table (nullable, backfilled as `'claude-code'`).

### 19.2 Provider resolution order

1. Thread affinity (existing provider from first run)
2. Persona config `provider` field (if set)
3. `agentRunner.defaultProvider` from talond.yaml
4. `'claude-code'` (hardcoded fallback)

---

## 20. Configuration

### 20.1 Full config example

```yaml
# talond.yaml
agentRunner:
  defaultProvider: claude-code
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
      rotationThreshold: 0.7
    gemini-cli:
      enabled: false
      command: gemini
      contextWindowTokens: 1000000
      rotationThreshold: 0.8
      modelMap:
        default: gemini-2.5-pro
    codex-cli:
      enabled: false
      command: codex
      contextWindowTokens: 200000
      rotationThreshold: 0.6
      modelMap:
        default: o3

backgroundAgent:
  enabled: true
  maxConcurrent: 2
  defaultProvider: claude-code    # Can differ from agentRunner
  providers:
    claude-code:
      enabled: true
      command: claude
    gemini-cli:
      enabled: false
      command: gemini
```

### 20.2 Per-persona provider selection

```yaml
# personas/talon.yaml
name: Talon
model: claude-sonnet-4-20250514
provider: claude-code  # optional

# personas/research-agent.yaml
name: ResearchAgent
model: gemini-2.5-pro
provider: gemini-cli   # Gemini for 1M context
```

---

## 21. Known Risks & Open Questions

Issues identified during review that must be resolved before implementing specific providers:

### 21.1 Gemini CLI

| Risk | Severity | Status |
|---|---|---|
| `--output-format json` may not work ([GitHub issue #9009](https://github.com/google-gemini/gemini-cli/issues/9009)) | **High** — blocks JSON output parsing | Unverified |
| `--non-interactive` flag may not exist — headless mode may be triggered by non-TTY environment | Medium — affects buildArgs | Unverified |
| No `--system-instruction` flag — system prompt prepended to user prompt | Low — workaround in place | Needs verification |

### 21.2 Codex CLI

| Risk | Severity | Status |
|---|---|---|
| Flag is `-a` / `--approval-policy`, NOT `--approval-mode` | **High** — wrong flag name breaks execution | Corrected in spec |
| `--ephemeral` flag may not exist in current Codex CLI | Medium — remove if unverified | Unverified |
| JSONL event shapes (field names like `text` vs `content` in agent_message items) | Medium — affects parseOutput | Needs real run verification |
| Long prompts as positional `exec` argument may hit `ARG_MAX` shell limit | Low — consider stdin or temp file for long prompts | Design decision needed |

### 21.3 Architecture

| Risk | Severity | Status |
|---|---|---|
| `cacheReadTokens` vs `inputTokens` ratio semantics differ — same threshold means different things | **High** — could cause premature or missed rotation | Fix: per-provider thresholds (Section 15) |
| `spawnCli` race condition — `error` + `close` events can double-resolve | Medium | Fix: settled guard (Section 10.2) |
| Schema migration for `provider_name` column in `runs` table | Low — nullable, backward compatible | Design complete |

### 21.4 Verification Checklist

Before implementing any non-Claude provider, run through this checklist:

- [ ] Install the CLI and run `<cli> --version`
- [ ] Run a simple prompt in headless/non-interactive mode
- [ ] Verify JSON output format and parse it
- [ ] Verify MCP server config format works
- [ ] Test with a real MCP server (host-tools)
- [ ] Measure typical latency for a simple task
- [ ] Verify approval/permission bypass flags
- [ ] Test timeout and kill behavior

---

## 22. Summary

The multi-provider architecture is built in phases, with Phase 1 being purely about decoupling:

| Phase | Scope | Providers | Risk |
|---|---|---|---|
| **1: Decouple** | Extract provider interface, refactor AgentRunner + BackgroundAgentManager | Claude only | Zero — identical behavior |
| **2: First plugin** | Add Gemini CLI for background agents | Claude + Gemini | Low — background agents are fire-and-forget |
| **3: More plugins** | Codex CLI, Ollama, Mastra, main runner support | As needed | Medium — each provider independently tested |
| **4: Smart routing** | Failover, cost routing, provider affinity | All | Higher — complex UX implications |

The interface is the product. Once Phase 1 is complete, adding providers is mechanical: implement the interface, register the factory, add config. No core pipeline changes.
