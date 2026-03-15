# Gemini CLI Provider Implementation Plan

## Summary

Add `gemini-cli` as a Talon provider for both background agents and the main `AgentRunner`, but scope the work into explicit chunks so the new behavior is isolated:

1. Gemini provider and process plumbing
2. Background-agent tool surface and task persistence
3. Main-runner Gemini CLI execution
4. Provider affinity and run persistence

Use Gemini CLI's currently documented automation interfaces:

- `--output-format json`
- `--approval-mode yolo`
- `--model <name>` when a model is available
- `GEMINI_CLI_SYSTEM_SETTINGS_PATH` for provider-owned `settings.json`
- `GEMINI_SYSTEM_MD` for the system prompt
- `GEMINI_CLI_HOME` for isolated per-invocation CLI state

Do not rely on undocumented stdin prompt handling. Launch Gemini in a non-TTY process, pass the user/content prompt as a positional prompt argument, and let non-TTY execution trigger headless mode. This positional-argument choice is an inference from the current docs: the CLI reference deprecates `--prompt`, while the headless docs state non-TTY invocations run headlessly.

## Chunk 1: Gemini provider and process plumbing

**Goal:** add a provider-native Gemini adapter and the minimal core plumbing it needs.

**Files likely touched:**
- `src/providers/gemini-cli-provider.ts`
- `src/providers/provider-types.ts`
- `src/subagents/background/background-agent-process.ts`
- `src/daemon/daemon-bootstrap.ts`
- `src/core/config/config-schema.ts`
- `config/talond.example.yaml`

**Implementation**

- Create `GeminiCliProvider` implementing `AgentProvider`.
- Extend `PreparedProviderInvocation` and `BackgroundAgentProcessOptions` with optional `env`.
- Update `BackgroundAgentProcess` to pass merged env through `spawn()`.
- Register `gemini-cli` in the bootstrap provider factory map.
- Add documented example config for `gemini-cli` under both `agentRunner.providers` and `backgroundAgent.providers`.
- Keep the provider config shape additive:
  - `command: gemini`
  - `contextWindowTokens: 1000000`
  - `rotationThreshold: 0.8`
  - `options.defaultModel` for background agents when no persona-bound Gemini model is available

**Gemini provider decisions**

- Create one temp working directory per invocation and clean it up after completion.
- Write `settings.json` into that temp directory and set `GEMINI_CLI_SYSTEM_SETTINGS_PATH` to it.
- Write `system.md` into that temp directory and set `GEMINI_SYSTEM_MD` to it.
- Set `GEMINI_CLI_HOME` to a temp subdirectory so Gemini does not reuse or pollute user-global CLI state.
- Put `security.folderTrust.enabled: false` in the generated Gemini settings so headless MCP use is not blocked by workspace trust prompts.
- Translate Talon's canonical MCP server definitions into Gemini `mcpServers` entries:
  - stdio servers map to `command`, `args`, optional `env`, optional `cwd`, optional `timeout`
  - HTTP servers map to `httpUrl` plus optional `headers`
  - SSE servers map to `url` plus optional `headers`
- Pass the user/content prompt as a positional prompt argument, not stdin.
- Pass `--approval-mode yolo`.
- Pass `--output-format json`.
- Pass `--model` for:
  - main runner: `loadedPersona.config.model`
  - background agents: `backgroundAgent.providers.gemini-cli.options.defaultModel` when configured; otherwise omit `--model` and allow Gemini CLI's own default

**Parsing and usage**

- Parse Gemini JSON output into Talon `ProviderResult` / `AgentRunResult`.
- Use the top-level text response field as Talon output.
- Extract token usage from `stats`, preferring `stats.perModel` when present and falling back to top-level aggregates if needed.
- Normalize Gemini usage into `AgentUsage` with:
  - `inputTokens`
  - `outputTokens`
  - no cache-read/cache-write values
- Implement `estimateContextUsage()` using total input tokens divided by Gemini's configured `contextWindowTokens`.

## Chunk 2: Background-agent tool surface and task persistence

**Goal:** treat background-agent provider selection as an explicit tool-layer feature, not an implicit side effect of provider registration.

**Files likely touched:**
- `src/tools/host-tools/background-agent.ts`
- `src/subagents/background/background-agent-manager.ts`
- `src/subagents/background/background-agent-types.ts`
- `src/core/database/migrations/*`
- `src/core/database/repositories/background-task-repository.ts`

**Implementation**

- Extend `BackgroundAgentArgs` with optional `provider`.
- Update the host-tool manifest description/help text so provider selection is discoverable at the tool boundary.
- Thread the selected provider through:
  - `BackgroundAgentHandler`
  - `SpawnBackgroundAgentInput`
  - `BackgroundAgentManager`
- Make background-agent provider resolution explicit and local to this chunk:
  1. `background_agent.provider` when supplied
  2. persona `provider` when supplied
  3. `backgroundAgent.defaultProvider`
- Keep background-agent model selection separate from tool args:
  - the tool only selects provider
  - Gemini background model comes from provider config `options.defaultModel`

**Persistence**

- Add `provider_name` to `background_tasks`.
- Persist the resolved provider on task creation.
- Return provider name in task/status/result reads so Gemini-vs-Claude executions are observable.
- Update any completion-notification/log payloads to include `provider_name`.

## Chunk 3: Main-runner Gemini CLI execution

**Goal:** make Gemini work through the existing CLI-strategy shape in `AgentRunner`, while keeping this distinct from the later provider-affinity behavior.

**Files likely touched:**
- `src/daemon/agent-runner.ts`
- `tests/unit/daemon/agent-runner.test.ts`
- `tests/unit/providers/gemini-cli-provider.test.ts`

**Implementation**

- Keep using `GeminiCliProvider.createExecutionStrategy()` returning `type: 'cli'`.
- Use the existing CLI branch in `AgentRunner` rather than inventing a new execution model.
- Make the Gemini-specific runner edits explicit:
  - resolve the selected provider for the current run before creating the strategy
  - call the CLI strategy and persist Gemini token usage
  - run context-rotation checks using Gemini's normalized `ContextUsage`
  - rely on the existing `strategy.type === 'sdk'` gating so CLI providers already skip session resumption; no Gemini-specific session-resume code is needed
- Add a CLI-provider UX signal before long-running main-runner calls:
  - send a one-shot "Waiting for agent..." channel message for CLI providers before starting the query
  - keep the existing typing indicator behavior where supported
- Keep Claude SDK retry/resume logic unchanged and scoped to `strategy.type === 'sdk'`.

## Chunk 4: Provider affinity and run persistence

**Goal:** isolate the new thread-sticky provider behavior as its own chunk, since it changes runner behavior beyond "add a provider."

**Files likely touched:**
- `src/core/database/migrations/*`
- `src/core/database/repositories/run-repository.ts`
- `src/daemon/agent-runner.ts`

**Implementation**

- Add `provider_name` to `runs`.
- Persist the resolved provider on every run record.
- Add the repository query needed to read the thread's latest persisted provider.
- Resolve main-runner provider in this order:
  1. latest `runs.provider_name` for the thread
  2. persona `provider`
  3. `agentRunner.defaultProvider`
- Keep this logic local to provider selection so the rest of the runner does not branch on provider name.
- If this chunk is later deferred, Gemini main-runner support can still work by using persona/default provider selection only.

## Tests and verification

**Unit tests**

- `GeminiCliProvider`
  - builds the documented Gemini args/env correctly
  - writes `settings.json`, `system.md`, and isolated CLI home into temp storage
  - translates stdio/http/sse MCP servers into Gemini-native config
  - parses JSON output into normalized result and usage values
  - fails cleanly when Gemini returns non-JSON despite `--output-format json`
  - estimates context usage from total input tokens
- Background-agent surface
  - explicit `provider` arg overrides persona/default
  - persona provider overrides config default when tool arg is absent
  - `provider_name` is persisted and returned in task reads
  - env overrides from the provider reach process spawn
- Main runner
  - Gemini CLI strategy executes successfully through the existing CLI branch
  - CLI providers do not attempt session resumption
  - Gemini usage is persisted and forwarded to `ContextRoller`
  - CLI-provider "Waiting for agent..." notification is emitted once
- Persistence
  - migrations add `provider_name` to both `runs` and `background_tasks`
  - repositories read/write those columns correctly
  - provider-affinity resolution uses latest persisted `runs.provider_name`

**Optional integration tests**

- Guard with `commandExists('gemini')`.
- Verify:
  - `gemini --version`
  - one simple headless JSON run
  - one MCP-backed run against host-tools
  - one background-agent smoke run with `provider: gemini-cli`
  - one main-runner smoke run with Gemini as the configured provider

**Fresh verification commands**

- `npx vitest run tests/unit/providers/gemini-cli-provider.test.ts tests/unit/tools/background-agent.test.ts tests/unit/subagents/background/background-agent-manager.test.ts tests/unit/daemon/agent-runner.test.ts`
- `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/daemon/daemon-bootstrap.test.ts`
- optional, when Gemini CLI is installed: the new Gemini integration test file(s)

## Assumptions and researched defaults

- Gemini's headless docs state headless mode is used for non-interactive/non-TTY invocations and when a prompt is supplied on the CLI.
- Gemini's configuration docs document:
  - `GEMINI_CLI_SYSTEM_SETTINGS_PATH`
  - `GEMINI_SYSTEM_MD`
  - `GEMINI_CLI_HOME`
  - `security.folderTrust.enabled`
  - `--approval-mode`
  - `--output-format`
- The same docs mark `--prompt` as deprecated in favor of positional prompt arguments. This plan therefore uses positional prompt args rather than stdin. That is an implementation choice inferred from the docs, not a directly stated Talon-specific recipe.
- `--approval-mode yolo` is preferred over the older `--yolo` shorthand because the config docs explicitly recommend `--approval-mode=yolo` for the unified model.
- Gemini JSON output is expected to remain stable enough for Talon to parse in v1; if live verification shows the installed CLI version still reproduces the historical JSON-output issues, Talon should fail fast with an upgrade-required error rather than silently downgrade to plain-text parsing.

## Sources

- Gemini CLI headless mode docs: https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/headless.md
- Gemini CLI configuration reference: https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md
- Gemini CLI MCP docs: https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/mcp-server.md
- Historical JSON-output issues:
  - https://github.com/google-gemini/gemini-cli/issues/9009
  - https://github.com/google-gemini/gemini-cli/issues/9281
