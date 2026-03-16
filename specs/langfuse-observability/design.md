# Langfuse Observability Integration Design

**Status**: Draft  
**Date**: 2026-03-16  
**GitHub Issue**: https://github.com/ivo-toby/talon/issues/38

## 1. Assumptions

- This design targets Langfuse Cloud, not self-hosted Langfuse.
- The MVP is observability only.
- Langfuse Prompt Management remains optional and out of the first implementation slice.
- Talon's existing `runs` table remains the top-level execution record; Langfuse becomes the detailed execution tree.

## 2. Goals

- Trace each foreground agent run end-to-end in Langfuse.
- Show tool calls as child observations.
- Show sub-agent invocations as nested observations.
- Show previous-context assembly as a retriever-style observation.
- Capture latency, model, tokens, and cost for each provider attempt.
- Correlate Langfuse traces with Talon's existing `run_id`, thread, persona, channel, and provider.
- Add essentially no meaningful runtime cost when Langfuse is disabled.

## 3. Non-Goals

- No prompt-source-of-truth migration to Langfuse in phase 1.
- No new Talon database model for per-tool or per-sub-agent child runs.
- No background worker process tracing in phase 1 beyond the foreground `background_agent` host-tool call itself.
- No attempt to trace every SQLite write or channel-connector internals.

## 4. Recommended Approach

Add a Talon-owned observability layer with two implementations:

- `NoopObservabilityService`
- `LangfuseObservabilityService`

The service is created during bootstrap and injected into `DaemonContext`. All call sites use the same internal API regardless of whether Langfuse is enabled.

This keeps the core decision local:

- when disabled: the service returns no-op handles and does not initialize any OTEL/Langfuse machinery
- when enabled: the service creates a tracer provider, installs the Langfuse span processor, and exposes small helpers for run, generation, tool, and retriever observations

## 5. Trace Model

Each Talon foreground run becomes one Langfuse trace with this shape:

| Talon action | Langfuse observation type | Parent |
| --- | --- | --- |
| Queue-item run | `agent` | root |
| Previous-context assembly | `retriever` | root agent |
| Provider attempt | `generation` | root agent |
| Host tool execution | `tool` | provider attempt |
| Sub-agent invocation | `agent` | host tool |

Notes:

- A single Talon run may emit more than one `generation` child if `AgentRunner` retries a failed resume attempt with a fresh session.
- Tool spans are attached to the provider-attempt observation, not directly to the root run. This reflects reality better: tools happen during model execution.
- Sub-agent spans nest under the `subagent.invoke` tool span.

## 6. Correlation Strategy

Use Langfuse trace/session dimensions for compact identifiers and use observation metadata for richer details.

Recommended mapping:

- `sessionId = threadId`
- `traceName = agent:<persona-name>` or `schedule:<persona-name>`
- trace metadata strings:
  - `run_id`
  - `thread_id`
  - `persona_id`
  - `persona_name`
  - `channel_name`
  - `provider`
  - `queue_type`
- trace tags:
  - `persona:<name>`
  - `channel:<name>`
  - `provider:<name>`
  - `queue:<type>`

Root observation metadata can then hold richer JSON:

- `queueItemId`
- `runStatus`
- `sessionId`
- `resultSessionId`
- retry metadata
- context-rotation metadata

This is enough to filter Langfuse dashboards by persona, channel, time period, provider, or thread while preserving a direct `run_id` lookup key.

## 7. Configuration

Add a new top-level config section:

```yaml
langfuse:
  enabled: false
  publicKey: ${LANGFUSE_PUBLIC_KEY}
  secretKey: ${LANGFUSE_SECRET_KEY}
  baseUrl: https://cloud.langfuse.com
  environment: production
  release: ${GIT_SHA}
  exportMode: batched
  flushAt: 20
  flushIntervalSeconds: 5
```

Field semantics:

- `enabled`
  - master switch
- `publicKey` / `secretKey`
  - Langfuse Cloud project credentials
- `baseUrl`
  - `https://cloud.langfuse.com` for EU cloud
  - `https://us.cloud.langfuse.com` for US cloud
- `environment`
  - filterable Langfuse environment label
- `release`
  - Talon build or git SHA for deployment correlation
- `exportMode`
  - default `batched` for the daemon
- `flushAt` / `flushIntervalSeconds`
  - batch tuning knobs

No prompt-management config is needed for phase 1.

## 8. Runtime Architecture

### 8.1 New module

Add a new folder:

- `src/observability/langfuse/`

Proposed files:

- `src/observability/langfuse/observability-types.ts`
- `src/observability/langfuse/noop-observability.ts`
- `src/observability/langfuse/langfuse-observability.ts`
- `src/observability/langfuse/traceparent.ts`
- `src/observability/langfuse/index.ts`

Responsibilities:

- own Langfuse and OTEL dependencies
- create spans/observations through a small Talon API
- serialize and parse cross-process `traceparent`
- hide no-op vs real instrumentation from callers

### 8.2 Bootstrap and shutdown

Modify:

- `src/core/config/config-schema.ts`
- `src/core/config/config-types.ts`
- `src/daemon/daemon-bootstrap.ts`
- `src/daemon/daemon-context.ts`
- `src/daemon/daemon.ts`
- `talond.yaml.example`

Bootstrap behavior:

- if `langfuse.enabled` is false:
  - create `NoopObservabilityService`
- if true:
  - create OTEL tracer provider
  - install `LangfuseSpanProcessor`
  - install async context propagation
  - return `LangfuseObservabilityService`

Shutdown behavior:

- `TalondDaemon.stop()` must ask the observability service to flush and shut down before process exit
- exporter failures should be logged, never treated as daemon-fatal

## 9. Foreground Run Instrumentation

Modify `src/daemon/agent-runner.ts`.

### 9.1 Root run observation

Wrap the body of `AgentRunner.run()` in a root `agent` observation.

Root observation input:

- queue-item content
- queue-item type
- persona name
- provider name

Root observation output:

- final outbound text, or
- background notification content, or
- schedule output if no message is sent

Root observation status:

- success on completed run
- error on failed run

### 9.2 Previous-context retrieval observation

When `ContextAssembler.assemble()` is used for a fresh session, create a `retriever` child observation around that call.

Capture:

- `threadId`
- whether a summary was found
- how many recent messages were included
- total assembled character count

Do not create this observation on resumed provider sessions where Talon does not assemble previous context.

### 9.3 Provider attempt observation

Inside the root run observation, create one `generation` observation per provider query attempt.

Capture:

- `model`
- `provider`
- `resumeSessionId`
- `attemptNumber`
- input:
  - user prompt
  - assembled system prompt
- output:
  - model output text
- usage details:
  - input tokens
  - output tokens
  - cache read tokens
  - cache write tokens
- cost details:
  - total cost in USD

If a resume attempt fails before any events and Talon retries fresh-session execution:

- mark the first generation observation as an error
- attach retry metadata
- start a second generation observation for the fresh-session attempt

## 10. Tool Span Propagation Across MCP

This is the most important design detail.

### 10.1 Problem

`AgentRunner` starts the provider attempt in the daemon process, but host-tool requests flow through:

1. provider runtime
2. spawned `host-tools-mcp-server` child process
3. daemon-side `HostToolsBridge`

The active OTEL context from `AgentRunner` is not automatically available inside the bridge callback.

### 10.2 Solution

Pass a W3C `traceparent` string from the provider-attempt observation to the MCP child process and then to each bridge request.

Implementation shape:

- `AgentRunner` computes a `traceparent` string for the active generation observation
- inject it into the `host-tools` MCP server env, for example:
  - `TALOND_TRACEPARENT`
- `src/tools/host-tools-mcp-server.ts` reads that env var and includes it in every bridge request context
- `src/tools/host-tools-bridge.ts` parses the `traceparent` and starts an active `tool` observation under that remote parent context

This avoids a daemon-global span registry and keeps the propagation explicit.

### 10.3 Bridge instrumentation

Modify:

- `src/tools/host-tools-mcp-server.ts`
- `src/tools/host-tools-bridge.ts`
- shared tool context types if needed

Wrap each request in a `tool` observation that captures:

- tool name
- request ID
- validated args
- success/error/timeout status
- result payload on success
- error message on failure

Rejected tool calls should still be recorded as error observations when a valid `traceparent` is present.

## 11. Sub-Agent Instrumentation

Modify `src/subagents/subagent-runner.ts`.

Inside the active tool context for `subagent.invoke`, create an `agent` child observation for the sub-agent run.

Capture:

- sub-agent name
- manifest version
- provider/model
- input payload
- summary/result payload
- duration
- optional usage/cost from `SubAgentResult.usage`

This keeps sub-agents visible in Langfuse without changing Talon's `runs` table semantics.

## 12. Disabled Mode And Error Handling

### 12.1 Disabled mode

When disabled:

- no tracer provider is created
- no exporter is created
- no extra network calls happen
- call sites still execute through a no-op service

The per-call overhead should collapse to a few in-process method calls and branches.

### 12.2 Export failures

Langfuse export problems must not fail Talon runs.

Rules:

- observability initialization failure at bootstrap:
  - log error
  - fall back to no-op service
- export failure during a run:
  - log warning/error
  - do not fail the queue item
- flush failure on shutdown:
  - log warning
  - continue shutdown

### 12.3 Data hygiene

Do not export:

- API keys
- MCP env blocks
- socket paths
- raw auth headers

Tool args/results and prompt content are in scope because the issue explicitly wants observability of the LLM lifecycle, but secret-bearing infrastructure metadata is not.

## 13. File Surface

Expected new files:

- `src/observability/langfuse/observability-types.ts`
- `src/observability/langfuse/noop-observability.ts`
- `src/observability/langfuse/langfuse-observability.ts`
- `src/observability/langfuse/traceparent.ts`
- `src/observability/langfuse/index.ts`

Expected modified files:

- `src/core/config/config-schema.ts`
- `src/core/config/config-types.ts`
- `src/daemon/daemon-bootstrap.ts`
- `src/daemon/daemon-context.ts`
- `src/daemon/daemon.ts`
- `src/daemon/agent-runner.ts`
- `src/tools/host-tools-mcp-server.ts`
- `src/tools/host-tools-bridge.ts`
- `src/subagents/subagent-runner.ts`
- `talond.yaml.example`

## 14. Testing Strategy

### 14.1 Unit tests

- config schema defaults and validation for `langfuse`
- `traceparent` encode/decode helpers
- no-op service behavior
- bootstrap fallback to no-op if Langfuse init fails

### 14.2 Agent runner tests

- creates root observation with expected correlation metadata
- emits retriever observation for fresh-session context assembly
- emits generation observation with usage/cost details
- emits two generation observations on resume-failure retry
- does not fail the run when telemetry export fails

### 14.3 Tool bridge tests

- propagates `traceparent` from MCP env to bridge request
- creates child tool observation on success
- marks error/timeout correctly
- keeps sub-agent spans nested under the tool observation

### 14.4 Integration tests

Use an in-memory or fake span exporter instead of live Langfuse Cloud. Assert the resulting OTEL spans/attributes for:

- one normal foreground run
- one tool call
- one `subagent.invoke`
- one retry path

### 14.5 Manual verification

Run Talon against a real Langfuse Cloud project and verify:

- trace tree shape
- tokens and cost on generations
- filters by persona/channel/provider
- search by `run_id`

## 15. Rollout Plan

### Phase 1: Observability MVP

- root run trace
- generation attempt spans
- tool spans
- sub-agent spans
- retriever span for previous-context assembly
- config, graceful shutdown, and tests

### Phase 2: Optional prompt management

Separate follow-up design:

- add Langfuse prompt references to personas and sub-agents
- fetch prompt assets with `label` and local fallback
- keep local prompt files as safety fallback
- attach prompt name/version to generation observations

## 16. Open Questions

1. Should Talon add a simple `captureContent` boolean for metadata-only tracing in cloud environments with stricter privacy needs?
2. Is it worth persisting `langfuse_trace_id` on the `runs` table, or is searching Langfuse by `run_id` metadata good enough for the MVP?
3. Should the `background_agent` host-tool call be the only background-related span in phase 1, or do we want actual detached worker traces in the same project later?
