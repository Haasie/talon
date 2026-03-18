# Langfuse Observability Research

**Date**: 2026-03-16  
**Issue**: https://github.com/ivo-toby/talon/issues/38  
**Scope**: Langfuse Cloud research for Talon's tracing, cost visibility, and optional prompt-management follow-up

## 1. Restated Problem

Issue #38 asks Talon to add end-to-end LLM observability:

- one trace per agent run
- nested visibility for tool calls, sub-agent invocations, and memory retrieval
- token, latency, and cost visibility
- correlation back to Talon's existing `run_id`
- near-zero overhead when disabled

Talon already persists top-level run usage in SQLite and logs operational details with pino, but it does not currently emit a structured trace tree.

## 2. Relevant Talon Seams

The current codebase already has clean instrumentation boundaries:

- `src/daemon/agent-runner.ts`
  - owns top-level queue-item execution
  - chooses provider, creates `run_id`, invokes the provider, persists usage, and sends replies
- `src/tools/host-tools-mcp-server.ts`
  - is the child MCP process used during a foreground agent run
  - every host-tool request already carries `runId`, `threadId`, `personaId`, and a `requestId`
- `src/tools/host-tools-bridge.ts`
  - is the daemon-side choke point for all host tool execution
- `src/subagents/subagent-runner.ts`
  - is the single boundary for sub-agent execution
- `src/daemon/context-assembler.ts`
  - is the one place where Talon assembles "previous context" from memory and message history

Those boundaries are enough to build a useful trace tree without redesigning Talon's execution model.

## 3. Langfuse Cloud Findings

### 3.1 JS/TS tracing is OpenTelemetry-based

Langfuse's TypeScript observability stack is built on OpenTelemetry:

- `@langfuse/tracing` provides `startObservation(...)` / `startActiveObservation(...)`
- `@langfuse/otel` provides `LangfuseSpanProcessor`
- the JS SDK supports observation types that map well to Talon:
  - `agent`
  - `generation`
  - `tool`
  - `retriever`
  - `span`

This is a better fit than a custom event model because Talon needs a nested trace tree, not just flat logs.

### 3.2 Export path and lifecycle match a daemon process

From the Langfuse JS sources:

- the OTLP exporter targets `${baseUrl}/api/public/otel/v1/traces`
- auth is public key + secret key
- the base URL defaults to `https://cloud.langfuse.com`
- the README documents `https://us.cloud.langfuse.com` as the US cloud base URL
- the span processor supports:
  - `exportMode: "batched"` for long-running services
  - `exportMode: "immediate"` for short-lived/serverless processes

For Talon, `batched` is the correct default. It minimizes runtime overhead and matches the daemon lifecycle. Graceful shutdown still needs a final flush/shutdown call.

### 3.3 Generation observations can hold Talon's usage and cost data

Langfuse generation attributes support:

- `model`
- `modelParameters`
- `usageDetails`
- `costDetails`
- `input`
- `output`

This aligns with Talon's provider result shape:

- `inputTokens`
- `outputTokens`
- `cacheReadTokens`
- `cacheWriteTokens`
- `totalCostUsd`

Conclusion: Talon does not need a second cost pipeline for Langfuse. It can attach the usage/cost data it already computes to the generation observation and let Langfuse visualize it.

### 3.4 Trace-level correlation is available, but should be used carefully

Langfuse's tracing utilities expose `propagateAttributes(...)` for trace-wide dimensions such as:

- `sessionId`
- `userId`
- `metadata`
- `version`
- `tags`
- `traceName`

Important constraint from the Langfuse propagation implementation:

- propagated metadata is intended for small string values
- richer JSON belongs on observation metadata instead

Practical implication for Talon:

- use trace/session dimensions for compact identifiers:
  - `sessionId = threadId`
  - metadata strings: `run_id`, `thread_id`, `persona_id`, `channel_name`, `provider`
- keep detailed JSON on the root observation or child observations

### 3.5 Prompt management is good, but not a phase-1 fit

Langfuse's prompt client supports:

- `prompt.get(name, { version | label, cacheTtlSeconds, fallback, maxRetries, fetchTimeoutMs })`
- default cache TTL of 60 seconds
- stale-while-revalidate behavior
- fallback prompt content when fetch fails
- label-based lookup, with the cache key defaulting to the `production` label when no version/label is specified

This is strong infrastructure for remote prompt assets, but Talon's current prompt model is not a single remote prompt:

- persona prompts come from local files
- skill prompt fragments are merged at runtime
- channel context, time context, and previous context are appended dynamically
- sub-agent prompts are read from local prompt fragment folders

Conclusion: Langfuse Prompt Management should be treated as an opt-in follow-up, not bundled into the tracing MVP.

## 4. Integration Options

### Option A: Native Langfuse tracing packages inside a Talon abstraction

Use:

- `@langfuse/tracing`
- `@langfuse/otel`
- OpenTelemetry tracer provider/context manager

Wrap them behind a Talon-owned `ObservabilityService` interface with a no-op implementation when disabled.

Pros:

- Langfuse-native observation types map directly to Talon concepts
- minimal custom protocol work
- supports rich metadata, costs, retries, errors, and nested spans
- keeps Langfuse-specific code out of `AgentRunner` and `HostToolsBridge`

Cons:

- introduces OpenTelemetry runtime dependencies
- cross-process MCP tool tracing needs explicit context propagation

Verdict: best fit.

### Option B: Vanilla OpenTelemetry only, exporting to Langfuse OTLP

Use generic OTel instrumentation and point the exporter at Langfuse's OTLP endpoint.

Pros:

- lower vendor coupling
- easier future backend swaps

Cons:

- Talon would need to define its own semantic mapping for agent/tool/generation/retriever
- prompt-management and Langfuse-specific helper APIs stay separate
- more custom translation code for less benefit in the current scope

Verdict: viable, but unnecessary for this issue.

### Option C: Manual Langfuse API ingestion

Skip OTel and call Langfuse APIs directly for trace/span/generation events.

Pros:

- no OTel context manager
- Talon has complete control over payload shapes

Cons:

- Talon must manually manage parent/child relationships, timing, batching, retries, and shutdown semantics
- more code than the SDK path
- harder to keep tool/sub-agent nesting correct

Verdict: worst tradeoff.

## 5. Recommendation

Use Option A, but keep the vendor boundary inside a new Talon observability module.

Recommended scope split:

- Phase 1
  - Langfuse tracing for foreground agent runs
  - root run trace
  - generation span per provider attempt
  - tool spans
  - sub-agent spans
  - context-retrieval span
  - token/cost capture
- Phase 2
  - optional Langfuse Prompt Management integration
  - remote prompt references with local fallback
  - prompt name/version attachment on generation observations

Recommended phase-1 scoping decisions:

- do not redesign Talon's `runs` table around child tool/sub-agent runs
- do not move persona/sub-agent prompt sources to Langfuse yet
- do not include background-agent worker process tracing in the MVP

## 6. Key Risks And Constraints

### 6.1 Cloud data exposure

Langfuse Cloud means trace content leaves Talon. That is acceptable for this issue's assumption set, but it should still be explicit in the spec.

### 6.2 MCP tracing needs explicit propagation

The daemon and the host-tools MCP process are separate processes. The root agent observation context will not magically be active inside the daemon-side bridge callback for a tool request. Talon needs to propagate a parent context explicitly, most likely as a W3C `traceparent` string.

### 6.3 Prompt management should not be smuggled into the MVP

The prompt-management APIs are attractive, but folding them into phase 1 would turn a tracing task into a prompt-source-of-truth migration. That is a different problem.

## 7. Sources

- GitHub issue: https://github.com/ivo-toby/talon/issues/38
- Langfuse JS/TS SDK overview: https://langfuse.com/docs/observability/sdk/typescript/overview
- Langfuse token and cost tracking: https://langfuse.com/docs/observability/features/token-and-cost-tracking
- Langfuse prompt management overview/get started: https://langfuse.com/docs/prompt-management/get-started
- Langfuse main README: https://github.com/langfuse/langfuse
- Langfuse JS tracing source:
  - https://github.com/langfuse/langfuse-js/blob/main/packages/tracing/src/index.ts
  - https://github.com/langfuse/langfuse-js/blob/main/packages/tracing/src/types.ts
  - https://github.com/langfuse/langfuse-js/blob/main/packages/core/src/propagation.ts
- Langfuse JS OTEL source:
  - https://github.com/langfuse/langfuse-js/blob/main/packages/otel/src/span-processor.ts
- Langfuse prompt client source:
  - https://github.com/langfuse/langfuse-js/blob/main/packages/client/src/prompt/promptManager.ts
  - https://github.com/langfuse/langfuse-js/blob/main/packages/client/src/prompt/promptCache.ts
