# Multi-Provider Agent Runner Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple Talon's Claude-specific execution paths behind provider abstractions while keeping Claude Code as the only enabled provider and preserving current behavior.

**Architecture:** Introduce a provider layer that owns Claude-specific SDK and CLI translation, then inject that layer into the background-agent manager and main `AgentRunner`. Normalize context rotation around provider-reported usage ratios so future non-Claude providers can be added without reworking core pipeline logic.

**Tech Stack:** TypeScript, Node.js, neverthrow, Zod, pino, vitest

**Spec:** `specs/2026-03-14-multi-provider-agent-runner.md`

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Create | `src/providers/provider-types.ts` | Shared provider, usage, MCP, and strategy types |
| Create | `src/providers/provider.ts` | `AgentProvider` contract and execution strategy interfaces |
| Create | `src/providers/provider-registry.ts` | Provider lookup/default resolution |
| Create | `src/providers/claude-code-provider.ts` | Claude SDK strategy, background CLI translation, output parsing |
| Create | `src/providers/index.ts` | Public provider exports |
| Modify | `src/core/config/config-schema.ts` | Provider-aware config schemas with backward-compatible defaults |
| Modify | `src/core/config/config-types.ts` | Export new config types |
| Modify | `src/core/config/config-loader.ts` | Map deprecated `backgroundAgent.claudePath` into provider config when needed |
| Modify | `src/personas/persona-runtime-context.ts` | Return typed canonical MCP server maps |
| Modify | `src/personas/persona-types.ts` | Add optional provider selection to persona config consumers |
| Modify | `src/subagents/background/background-agent-manager.ts` | Resolve provider, delegate CLI/config/output handling |
| Delete | `src/subagents/background/background-agent-config-builder.ts` | Replaced by provider-owned config writing |
| Modify | `src/daemon/context-roller.ts` | Use normalized `ContextUsage` ratios instead of raw cache-read tokens |
| Modify | `src/daemon/agent-runner.ts` | Resolve provider strategy and route runner execution through it |
| Modify | `src/daemon/daemon-context.ts` | Expose provider registry for the main runner |
| Modify | `src/daemon/daemon-bootstrap.ts` | Build provider registries and inject Claude provider defaults |
| Modify | `config/talond.example.yaml` | Document provider-based background-agent config |
| Test | `tests/unit/core/config/config-schema.test.ts` | New provider config defaults and compatibility |
| Test | `tests/unit/core/config/config-loader.test.ts` | Deprecated `claudePath` mapping |
| Test | `tests/unit/personas/persona-runtime-context.test.ts` | Canonical MCP typing stays compatible |
| Test | `tests/unit/subagents/background/background-agent-manager.test.ts` | Manager/provider integration |
| Test | `tests/unit/daemon/context-roller.test.ts` | Ratio-based rotation behavior |
| Test | `tests/unit/daemon/agent-runner.test.ts` | Provider strategy execution path |
| Test | `tests/unit/daemon/daemon-bootstrap.test.ts` | Provider registry/bootstrap wiring |
| Test | `tests/unit/providers/provider-registry.test.ts` | Provider lookup/default resolution |
| Test | `tests/unit/providers/claude-code-provider.test.ts` | Claude provider background and SDK behavior |

## Chunk 1: Provider Core and Config

### Task 1: Add provider-aware config and registry primitives

**Files:**
- Create: `src/providers/provider-types.ts`
- Create: `src/providers/provider.ts`
- Create: `src/providers/provider-registry.ts`
- Create: `src/providers/index.ts`
- Modify: `src/core/config/config-schema.ts`
- Modify: `src/core/config/config-types.ts`
- Modify: `src/core/config/config-loader.ts`
- Test: `tests/unit/core/config/config-schema.test.ts`
- Test: `tests/unit/core/config/config-loader.test.ts`
- Test: `tests/unit/providers/provider-registry.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover:
- `BackgroundAgentConfigSchema` defaults `defaultProvider` and `providers['claude-code']`
- deprecated `claudePath` still works and maps to `providers['claude-code'].command`
- provider registry returns the configured default provider and enabled list

- [ ] **Step 2: Run the focused tests to confirm red**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/providers/provider-registry.test.ts`

Expected:
- provider-registry test fails because the module does not exist
- config tests fail because `defaultProvider` / `providers` are missing

- [ ] **Step 3: Implement the minimal production code**

Add:
- provider config schemas/types
- backward-compatible config-loader normalization
- provider registry with `get()`, `getDefault()`, and `listEnabled()`

- [ ] **Step 4: Re-run the focused tests to green**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/providers/provider-registry.test.ts`

Expected: PASS

## Chunk 2: Claude Provider and Background Agents

### Task 2: Extract Claude CLI behavior into a provider and inject it into the background manager

**Files:**
- Create: `src/providers/claude-code-provider.ts`
- Modify: `src/personas/persona-runtime-context.ts`
- Modify: `src/subagents/background/background-agent-manager.ts`
- Delete: `src/subagents/background/background-agent-config-builder.ts`
- Test: `tests/unit/personas/persona-runtime-context.test.ts`
- Test: `tests/unit/providers/claude-code-provider.test.ts`
- Test: `tests/unit/subagents/background/background-agent-manager.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover:
- Claude provider writes provider-native MCP/system-prompt temp files
- Claude provider builds CLI args and parses JSON/plain-text output
- background manager calls provider methods instead of a config builder
- runtime context keeps later MCP definitions winning with typed canonical objects

- [ ] **Step 2: Run the focused tests to confirm red**

Run: `npx vitest run tests/unit/personas/persona-runtime-context.test.ts tests/unit/providers/claude-code-provider.test.ts tests/unit/subagents/background/background-agent-manager.test.ts`

Expected:
- Claude provider test fails because the provider does not exist
- manager test fails because it still expects the old builder shape

- [ ] **Step 3: Implement the minimal production code**

Add a Claude provider that:
- creates the SDK execution strategy for the main runner
- prepares background CLI invocations and cleanup paths
- parses provider output into normalized usage/result data
- estimates context usage from Claude token metrics

Update the background manager to:
- resolve the configured default provider
- build the background system prompt inline
- delegate config-file writing, args, parsing, and cleanup to the provider

- [ ] **Step 4: Re-run the focused tests to green**

Run: `npx vitest run tests/unit/personas/persona-runtime-context.test.ts tests/unit/providers/claude-code-provider.test.ts tests/unit/subagents/background/background-agent-manager.test.ts`

Expected: PASS

## Chunk 3: Context Usage and Main Runner Strategy

### Task 3: Normalize context usage and route AgentRunner through provider strategies

**Files:**
- Modify: `src/daemon/context-roller.ts`
- Modify: `src/daemon/agent-runner.ts`
- Modify: `src/daemon/daemon-context.ts`
- Test: `tests/unit/daemon/context-roller.test.ts`
- Test: `tests/unit/daemon/agent-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover:
- `ContextRoller.checkAndRotate()` gates on `ContextUsage.ratio`
- `AgentRunner` resolves the configured provider and runs via its strategy
- Claude SDK retries fresh-session runs through the provider strategy exactly as today

- [ ] **Step 2: Run the focused tests to confirm red**

Run: `npx vitest run tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts`

Expected:
- context-roller test fails because the signature still expects raw tokens
- agent-runner test fails because provider registry/strategy is not wired yet

- [ ] **Step 3: Implement the minimal production code**

Refactor:
- `ContextRoller` to accept `ContextUsage`
- `AgentRunner` to resolve the provider, call its execution strategy, and pass normalized usage into the roller

- [ ] **Step 4: Re-run the focused tests to green**

Run: `npx vitest run tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts`

Expected: PASS

## Chunk 4: Bootstrap, Docs, and Regression Verification

### Task 4: Wire provider registries through bootstrap and verify the full slice

**Files:**
- Modify: `src/daemon/daemon-bootstrap.ts`
- Modify: `config/talond.example.yaml`
- Test: `tests/unit/daemon/daemon-bootstrap.test.ts`

- [ ] **Step 1: Write the failing bootstrap/doc tests**

Cover:
- bootstrap constructs the provider registry and passes the configured Claude provider into runtime consumers
- background manager receives provider-aware config instead of `claudePath`

- [ ] **Step 2: Run the focused tests to confirm red**

Run: `npx vitest run tests/unit/daemon/daemon-bootstrap.test.ts`

Expected: FAIL because bootstrap still passes only `claudePath`

- [ ] **Step 3: Implement the minimal production code**

Wire provider registries into bootstrap and update the example config to the provider-based form while preserving deprecated `claudePath` compatibility.

- [ ] **Step 4: Run targeted and broader regression suites**

Run: `npx vitest run tests/unit/core/config/config-schema.test.ts tests/unit/core/config/config-loader.test.ts tests/unit/providers/provider-registry.test.ts tests/unit/providers/claude-code-provider.test.ts tests/unit/personas/persona-runtime-context.test.ts tests/unit/subagents/background/background-agent-manager.test.ts tests/unit/daemon/context-roller.test.ts tests/unit/daemon/agent-runner.test.ts tests/unit/daemon/daemon-bootstrap.test.ts`

Expected: PASS

- [ ] **Step 5: Run the broader package regression**

Run: `npm test`

Expected: PASS
