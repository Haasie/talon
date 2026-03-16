# Langfuse Observability Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Langfuse Cloud-backed observability to Talon's foreground execution path with a zero-friction no-op fallback when disabled.

**Architecture:** Introduce a Talon-owned observability service that wraps Langfuse's OpenTelemetry-based tracing and exposes stable helpers for root runs, generation attempts, tool calls, retriever operations, and sub-agent spans. Push cross-process context over the existing host-tools MCP bridge using `traceparent`, keep all Langfuse-specific code isolated under `src/observability/langfuse/`, and degrade to a no-op service if config is disabled or initialization fails.

**Tech Stack:** TypeScript, Node.js, Langfuse JS SDK, OpenTelemetry, pino, neverthrow, Zod, vitest

**Spec:** `specs/langfuse-observability/design.md`

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Modify | `package.json` | Add Langfuse and OpenTelemetry dependencies |
| Create | `src/observability/langfuse/observability-types.ts` | Talon-owned interfaces for observations and service lifecycle |
| Create | `src/observability/langfuse/noop-observability.ts` | Disabled-mode implementation with no-op handles |
| Create | `src/observability/langfuse/traceparent.ts` | W3C `traceparent` serialization/parsing helpers |
| Create | `src/observability/langfuse/langfuse-observability.ts` | Langfuse/OTel-backed implementation and provider setup |
| Create | `src/observability/langfuse/index.ts` | Public exports for bootstrap/runtime callers |
| Modify | `src/core/config/config-schema.ts` | Add `langfuse` config section with defaults |
| Modify | `src/core/config/config-types.ts` | Export `LangfuseConfig` type |
| Modify | `src/daemon/daemon-context.ts` | Expose `observability` on runtime context |
| Modify | `src/daemon/daemon-bootstrap.ts` | Create no-op or Langfuse observability service during bootstrap |
| Modify | `src/daemon/daemon.ts` | Flush/shutdown observability during daemon stop |
| Modify | `src/daemon/context-assembler.ts` | Expose assembly metadata needed for retriever observations |
| Modify | `src/daemon/agent-runner.ts` | Emit root run, retriever, generation, retry, and traceparent env instrumentation |
| Modify | `src/tools/host-tools/channel-send.ts` | Extend shared `ToolExecutionContext` with propagated trace context |
| Modify | `src/tools/host-tools-mcp-server.ts` | Forward `traceparent` from env into bridge request context |
| Modify | `src/tools/host-tools-bridge.ts` | Start tool observations under remote parent context and record results |
| Modify | `src/subagents/subagent-runner.ts` | Emit nested sub-agent observations under tool spans |
| Modify | `talond.yaml.example` | Document Langfuse Cloud config and disabled default |
| Create | `tests/unit/observability/langfuse/noop-observability.test.ts` | Verify no-op handles and shutdown behavior |
| Create | `tests/unit/observability/langfuse/traceparent.test.ts` | Verify `traceparent` encode/decode helpers |
| Create | `tests/unit/observability/langfuse/langfuse-observability.test.ts` | Verify Langfuse-backed service behavior using in-memory exporter |
| Modify | `tests/unit/core/config/config-schema.test.ts` | Config defaults and validation |
| Modify | `tests/unit/daemon/daemon-bootstrap.test.ts` | Observability service bootstrap wiring and fallback |
| Modify | `tests/unit/daemon/daemon.test.ts` | Daemon stop flush/shutdown behavior |
| Modify | `tests/unit/daemon/context-assembler.test.ts` | Assembly metadata for retriever spans |
| Modify | `tests/unit/daemon/agent-runner.test.ts` | Root/generation/retry/traceparent instrumentation |
| Modify | `tests/unit/tools/host-tools-bridge.test.ts` | Tool span creation and bridge error behavior |
| Modify | `tests/unit/subagents/subagent-runner.test.ts` | Nested sub-agent span behavior |
| Create | `tests/integration/langfuse-observability.test.ts` | End-to-end observation tree with fake exporter |

## Chunk 1: Config, Dependencies, and Service Boundary

### Task 1: Add Langfuse config, dependencies, and Talon observability interfaces

**Files:**
- Modify: `package.json`
- Create: `src/observability/langfuse/observability-types.ts`
- Create: `src/observability/langfuse/noop-observability.ts`
- Create: `src/observability/langfuse/traceparent.ts`
- Create: `src/observability/langfuse/langfuse-observability.ts`
- Create: `src/observability/langfuse/index.ts`
- Modify: `src/core/config/config-schema.ts`
- Modify: `src/core/config/config-types.ts`
- Modify: `src/daemon/daemon-context.ts`
- Modify: `src/daemon/daemon-bootstrap.ts`
- Modify: `src/daemon/daemon.ts`
- Modify: `talond.yaml.example`
- Create: `tests/unit/observability/langfuse/noop-observability.test.ts`
- Create: `tests/unit/observability/langfuse/traceparent.test.ts`
- Create: `tests/unit/observability/langfuse/langfuse-observability.test.ts`
- Modify: `tests/unit/core/config/config-schema.test.ts`
- Modify: `tests/unit/daemon/daemon-bootstrap.test.ts`
- Modify: `tests/unit/daemon/daemon.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover:
- `langfuse.enabled` defaults to `false`
- `langfuse.baseUrl` defaults to `https://cloud.langfuse.com`
- missing `publicKey` / `secretKey` is valid while disabled and invalid when enabled
- `NoopObservabilityService.shutdown()` resolves cleanly and all observation handles are inert
- `traceparent` helper round-trips valid values and rejects malformed input
- bootstrap falls back to no-op service if Langfuse initialization throws
- `TalondDaemon.stop()` calls `ctx.observability.shutdown()`

- [ ] **Step 2: Run the focused tests to confirm red**

Run:

```bash
npx vitest run \
  tests/unit/core/config/config-schema.test.ts \
  tests/unit/daemon/daemon-bootstrap.test.ts \
  tests/unit/daemon/daemon.test.ts \
  tests/unit/observability/langfuse/noop-observability.test.ts \
  tests/unit/observability/langfuse/traceparent.test.ts \
  tests/unit/observability/langfuse/langfuse-observability.test.ts
```

Expected:
- FAIL because `src/observability/langfuse/*` modules do not exist
- FAIL because config and daemon context do not include `langfuse` / `observability`

- [ ] **Step 3: Implement the minimal production code**

Add runtime dependencies:

```json
{
  "@langfuse/otel": "^5.0.1",
  "@langfuse/tracing": "^5.0.1",
  "@opentelemetry/api": "^1.9.0",
  "@opentelemetry/context-async-hooks": "^2.0.1",
  "@opentelemetry/exporter-trace-otlp-http": "^0.204.0",
  "@opentelemetry/sdk-trace-base": "^2.0.1",
  "@opentelemetry/sdk-trace-node": "^2.0.1"
}
```

Create the service boundary:

```ts
export interface ObservationHandle {
  readonly enabled: boolean;
  getTraceparent(): string | undefined;
  update(input: { input?: unknown; output?: unknown; metadata?: Record<string, unknown> }): void;
  markSuccess(output?: unknown, metadata?: Record<string, unknown>): void;
  markError(error: unknown, metadata?: Record<string, unknown>): void;
}

export interface ObservabilityService {
  readonly enabled: boolean;
  startRun(input: RunObservationInput): ObservationHandle;
  startChild(input: ChildObservationInput): ObservationHandle;
  shutdown(): Promise<void>;
}
```

Create:
- a no-op implementation that returns inert handles
- a Langfuse-backed implementation with:
  - tracer provider construction
  - async-hooks context manager
  - `LangfuseSpanProcessor`
  - `shutdown()` calling provider force-flush plus processor/provider shutdown

Wire config/bootstrap:
- add `langfuse` schema and type
- initialize `ctx.observability`
- log and fall back to no-op on init failure
- shut down the service during daemon stop
- document the new config block in `talond.yaml.example`

- [ ] **Step 4: Re-run the focused tests to green**

Run:

```bash
npx vitest run \
  tests/unit/core/config/config-schema.test.ts \
  tests/unit/daemon/daemon-bootstrap.test.ts \
  tests/unit/daemon/daemon.test.ts \
  tests/unit/observability/langfuse/noop-observability.test.ts \
  tests/unit/observability/langfuse/traceparent.test.ts \
  tests/unit/observability/langfuse/langfuse-observability.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add package.json talond.yaml.example src/observability/langfuse src/core/config/config-schema.ts src/core/config/config-types.ts src/daemon/daemon-context.ts src/daemon/daemon-bootstrap.ts src/daemon/daemon.ts tests/unit/core/config/config-schema.test.ts tests/unit/daemon/daemon-bootstrap.test.ts tests/unit/daemon/daemon.test.ts tests/unit/observability/langfuse
git commit -m "feat(obs): add langfuse service boundary and config"
```

## Chunk 2: Root Run, Retriever, and Generation Instrumentation

### Task 2: Instrument `AgentRunner` and `ContextAssembler` for root runs and provider attempts

**Files:**
- Modify: `src/daemon/context-assembler.ts`
- Modify: `src/daemon/agent-runner.ts`
- Modify: `tests/unit/daemon/context-assembler.test.ts`
- Modify: `tests/unit/daemon/agent-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover:
- `ContextAssembler` exposes enough metadata to report:
  - `summaryFound`
  - `recentMessageCount`
  - `charCount`
- `AgentRunner.run()` creates a root `agent` observation with `run_id`, thread, persona, channel, provider, and queue-type correlation metadata
- fresh-session runs emit one `retriever` child around previous-context assembly
- each provider attempt emits one `generation` child with:
  - `model`
  - usage tokens
  - cost
  - input/output
- session-resume failure plus fresh-session retry produces two generation observations, with the first marked as error
- the active generation observation exports a `traceparent` value for downstream tool calls

- [ ] **Step 2: Run the focused tests to confirm red**

Run:

```bash
npx vitest run \
  tests/unit/daemon/context-assembler.test.ts \
  tests/unit/daemon/agent-runner.test.ts
```

Expected:
- FAIL because `ContextAssembler` only returns a string
- FAIL because `AgentRunner` does not call `ctx.observability`

- [ ] **Step 3: Implement the minimal production code**

Refactor `ContextAssembler` to expose metadata alongside the assembled string:

```ts
export interface AssembledContext {
  text: string;
  summaryFound: boolean;
  recentMessageCount: number;
  charCount: number;
}
```

Update `AgentRunner` to:
- start a root `agent` observation immediately after run creation
- wrap previous-context assembly in a `retriever` observation for fresh sessions only
- start one `generation` observation per provider attempt
- attach `usageDetails` and `costDetails` after provider completion
- mark failed resume attempts as errors before retrying
- inject the active generation's `traceparent` into the host-tools MCP env:

```ts
env: {
  ...process.env,
  TALOND_TRACEPARENT: generationObservation.getTraceparent() ?? "",
}
```

- [ ] **Step 4: Re-run the focused tests to green**

Run:

```bash
npx vitest run \
  tests/unit/daemon/context-assembler.test.ts \
  tests/unit/daemon/agent-runner.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/daemon/context-assembler.ts src/daemon/agent-runner.ts tests/unit/daemon/context-assembler.test.ts tests/unit/daemon/agent-runner.test.ts
git commit -m "feat(obs): instrument agent runner and context assembly"
```

## Chunk 3: MCP Tool Trace Propagation

### Task 3: Propagate `traceparent` through the host-tools MCP bridge and record tool observations

**Files:**
- Modify: `src/tools/host-tools/channel-send.ts`
- Modify: `src/tools/host-tools-mcp-server.ts`
- Modify: `src/tools/host-tools-bridge.ts`
- Modify: `tests/unit/tools/host-tools-bridge.test.ts`
- Modify: `tests/unit/daemon/agent-runner.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover:
- `host-tools-mcp-server` includes `TALOND_TRACEPARENT` in outbound bridge request context
- `HostToolsBridge` starts a `tool` observation when `context.traceparent` is present
- tool observations record:
  - tool name
  - request ID
  - args
  - success/error/timeout status
  - result or error payload
- disallowed tool calls still produce error observations when a propagated parent exists
- bridge behavior is unchanged when `traceparent` is absent

- [ ] **Step 2: Run the focused tests to confirm red**

Run:

```bash
npx vitest run \
  tests/unit/tools/host-tools-bridge.test.ts \
  tests/unit/daemon/agent-runner.test.ts
```

Expected:
- FAIL because the tool execution context has no `traceparent`
- FAIL because the bridge never calls `ctx.observability`

- [ ] **Step 3: Implement the minimal production code**

Extend the shared tool execution context:

```ts
export interface ToolExecutionContext {
  runId: string;
  threadId: string;
  personaId: string;
  requestId?: string;
  traceparent?: string;
}
```

Then:
- read `TALOND_TRACEPARENT` in `host-tools-mcp-server.ts`
- include it in every `BridgeRequest.context`
- in `HostToolsBridge.handleRequest()`:
  - parse `traceparent`
  - start a `tool` observation under the remote parent if parsing succeeds
  - update/close the observation around handler execution
  - mark timeout and policy rejections explicitly

- [ ] **Step 4: Re-run the focused tests to green**

Run:

```bash
npx vitest run \
  tests/unit/tools/host-tools-bridge.test.ts \
  tests/unit/daemon/agent-runner.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/host-tools/channel-send.ts src/tools/host-tools-mcp-server.ts src/tools/host-tools-bridge.ts tests/unit/tools/host-tools-bridge.test.ts tests/unit/daemon/agent-runner.test.ts
git commit -m "feat(obs): propagate trace context across host tools"
```

## Chunk 4: Sub-Agent Nesting, Shutdown, and Integration Verification

### Task 4: Emit nested sub-agent observations and verify the end-to-end trace tree

**Files:**
- Modify: `src/subagents/subagent-runner.ts`
- Modify: `tests/unit/subagents/subagent-runner.test.ts`
- Create: `tests/integration/langfuse-observability.test.ts`
- Modify: `tests/unit/daemon/daemon.test.ts`

- [ ] **Step 1: Write the failing tests**

Cover:
- `SubAgentRunner.execute()` starts a child `agent` observation under the active tool span
- the sub-agent observation captures:
  - sub-agent name
  - manifest version
  - model provider/name
  - input payload
  - summary/data output
  - usage/cost when returned
- sub-agent failures and timeouts mark the observation as errors
- integration run produces the expected hierarchy:
  - root `agent`
  - child `retriever`
  - child `generation`
  - child `tool`
  - grandchild `agent` for the sub-agent
- `TalondDaemon.stop()` still shuts down cleanly with pending observability state

- [ ] **Step 2: Run the focused tests to confirm red**

Run:

```bash
npx vitest run \
  tests/unit/subagents/subagent-runner.test.ts \
  tests/unit/daemon/daemon.test.ts \
  tests/integration/langfuse-observability.test.ts
```

Expected:
- FAIL because `SubAgentRunner` has no observability dependency
- FAIL because the integration test file does not exist yet

- [ ] **Step 3: Implement the minimal production code**

Inject observability into `SubAgentRunner` and wrap `execute()` in a nested `agent` observation.

For the integration test:
- use an in-memory/fake exporter rather than live Langfuse Cloud
- build a minimal daemon context with fake provider/tool/sub-agent behavior
- assert the exported observation tree shape and critical attributes

- [ ] **Step 4: Re-run the focused tests to green**

Run:

```bash
npx vitest run \
  tests/unit/subagents/subagent-runner.test.ts \
  tests/unit/daemon/daemon.test.ts \
  tests/integration/langfuse-observability.test.ts
```

Expected: PASS

- [ ] **Step 5: Run the full verification set**

Run:

```bash
npx vitest run \
  tests/unit/core/config/config-schema.test.ts \
  tests/unit/daemon/context-assembler.test.ts \
  tests/unit/daemon/agent-runner.test.ts \
  tests/unit/daemon/daemon-bootstrap.test.ts \
  tests/unit/daemon/daemon.test.ts \
  tests/unit/tools/host-tools-bridge.test.ts \
  tests/unit/subagents/subagent-runner.test.ts \
  tests/unit/observability/langfuse/noop-observability.test.ts \
  tests/unit/observability/langfuse/traceparent.test.ts \
  tests/unit/observability/langfuse/langfuse-observability.test.ts \
  tests/integration/langfuse-observability.test.ts
```

Expected: PASS

- [ ] **Step 6: Run the broader regression and build**

Run:

```bash
npm test
npm run build
```

Expected:
- `npm test`: PASS
- `npm run build`: exit code 0

- [ ] **Step 7: Commit**

```bash
git add src/subagents/subagent-runner.ts tests/unit/subagents/subagent-runner.test.ts tests/integration/langfuse-observability.test.ts tests/unit/daemon/daemon.test.ts
git commit -m "feat(obs): add nested subagent tracing"
```

## Execution Notes

- Keep prompt-management work out of this implementation. It is a separate follow-up plan.
- Do not add `langfuse_trace_id` to the database in this slice unless execution proves metadata lookup is insufficient.
- If `host-tools-mcp-server.ts` becomes too awkward to test directly, extract only the request-context construction into a tiny pure helper and test that helper. Do not broaden the refactor beyond what the tracing change needs.
- If Langfuse initialization proves noisy in tests, allow injecting a fake tracer provider/exporter into `LangfuseObservabilityService` rather than mocking the SDK wholesale.

Plan complete and saved to `specs/langfuse-observability/plan.md`. Ready to execute?
