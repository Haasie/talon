# Persona Task Prompts Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-persona `prompts/` directories and allow scheduled tasks to reference those files with `promptFile`, resolving file contents only when the schedule fires.

**Architecture:** Keep prompt-path indexing in `PersonaLoader`, not in the scheduler. `LoadedPersona` gains a plain `taskPromptPaths` record keyed by basename, `PersonaLoader` caches loaded personas by both name and persona ID, and the scheduler asks the loader to resolve a `promptFile` at execution time. `schedule.manage` accepts either inline `prompt` or persona-relative `promptFile`, preserves existing payload state on partial updates, and the CLI scaffolds an empty `prompts/` directory for new personas. This intentionally resolves the spec's `Map` vs `Record` mismatch in favor of a plain object that matches the rest of the repo's runtime DTO style.

**Tech Stack:** TypeScript, Node.js `fs/promises`, better-sqlite3, pino, Vitest

**Spec:** `/home/ivo/cf-notes/talon/2026-03-14-codex-prompt-persona-task-prompts.md`

---

## File Map

| Action | Path | Responsibility |
| --- | --- | --- |
| Modify | `src/personas/persona-types.ts` | Add task prompt metadata to `LoadedPersona` |
| Modify | `src/personas/persona-loader.ts` | Scan `prompts/`, cache personas by ID, resolve prompt files on demand |
| Modify | `src/scheduler/schedule-types.ts` | Add a shared schedule payload type for `prompt` / `promptFile` |
| Modify | `src/tools/host-tools/schedule-manage.ts` | Accept `promptFile`, validate mutual exclusivity, merge payload updates safely |
| Modify | `src/tools/host-tools-mcp-server.ts` | Document `promptFile` in the MCP input schema |
| Modify | `src/scheduler/scheduler.ts` | Resolve `promptFile` before enqueue and skip gracefully on errors |
| Modify | `src/daemon/daemon-bootstrap.ts` | Pass `PersonaLoader` into the scheduler |
| Modify | `src/cli/commands/add-persona.ts` | Scaffold `prompts/` and mention it in the template/output |
| Test | `tests/unit/personas/persona-loader.test.ts` | Prompt directory indexing, ID lookup, on-demand reads |
| Test | `tests/unit/tools/host-tools/schedule-manage.test.ts` | `promptFile` validation, payload merge behavior, list output |
| Test | `tests/unit/scheduler/scheduler.test.ts` | Prompt file resolution, inline prompt fallback, missing-file handling |
| Test | `tests/unit/cli/add-persona.test.ts` | `prompts/` scaffold and system template guidance |

---

## Chunk 1: Persona Prompt Indexing and Schedule Payload Contract

### Task 1: Extend `LoadedPersona` and `PersonaLoader` for task prompt files

**Files:**
- Modify: `src/personas/persona-types.ts`
- Modify: `src/personas/persona-loader.ts`
- Test: `tests/unit/personas/persona-loader.test.ts`

- [ ] **Step 1: Add the failing loader tests**

Add focused cases to `tests/unit/personas/persona-loader.test.ts` that cover:
- a sibling `prompts/` directory is scanned when `systemPromptFile` exists
- only `.md` files are indexed
- keys are basenames without extensions
- stored values are absolute file paths
- missing or empty `prompts/` returns `undefined`
- `getById()` returns the loaded persona after upsert
- `resolveTaskPrompt(personaId, promptFile)` reads file contents on demand and does not preload them during `loadFromConfig()`

Example assertions:

```ts
expect(persona.taskPromptPaths).toEqual({
  'morning-briefing': join(tmpDir, 'prompts', 'morning-briefing.md'),
  'weekly-review': join(tmpDir, 'prompts', 'weekly-review.md'),
});

const contentResult = await loader.resolveTaskPrompt(personaRow.id, 'morning-briefing');
expect(contentResult.isOk()).toBe(true);
expect(contentResult._unsafeUnwrap()).toContain('Morning briefing');
```

- [ ] **Step 2: Run the loader tests to confirm the red state**

Run:

```bash
npx vitest run tests/unit/personas/persona-loader.test.ts
```

Expected:
- new prompt-path assertions fail because `LoadedPersona` has no `taskPromptPaths`
- `getById()` / `resolveTaskPrompt()` do not exist yet

- [ ] **Step 3: Implement prompt indexing and on-demand resolution**

Make these production changes:

In `src/personas/persona-types.ts`, add:

```ts
export interface LoadedPersona {
  config: PersonaConfig;
  systemPromptContent?: string;
  personalityContent?: string;
  taskPromptPaths?: Record<string, string>;
  resolvedCapabilities: ResolvedCapabilities;
}
```

In `src/personas/persona-loader.ts`:
- add a second in-memory cache keyed by persona ID
- change `upsertPersona()` to return the persisted row or at least the persona ID
- add `getById(id: string): Result<LoadedPersona | undefined, PersonaError>`
- add `readTaskPromptPaths(systemPromptFile, personaName)` that:
  - resolves `dirname(systemPromptFile) + '/prompts'`
  - filters for `.md`
  - strips the extension for the record key
  - stores absolute paths
  - returns `undefined` when the directory is absent or contains no markdown files
- add `resolveTaskPrompt(personaId, promptFile)` that:
  - looks up the loaded persona by ID
  - resolves the prompt alias from `taskPromptPaths`
  - reads the file with `readFile(..., 'utf-8')`
  - returns `Err(PersonaError)` for unknown aliases or unreadable files

- [ ] **Step 4: Re-run the loader tests**

Run:

```bash
npx vitest run tests/unit/personas/persona-loader.test.ts tests/unit/personas/persona-loader-personality.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/personas/persona-types.ts src/personas/persona-loader.ts tests/unit/personas/persona-loader.test.ts
git commit -m "feat(personas): add prompt file indexing for scheduled tasks"
```

### Task 2: Add a shared schedule payload shape and extend `schedule.manage`

**Files:**
- Modify: `src/scheduler/schedule-types.ts`
- Modify: `src/tools/host-tools/schedule-manage.ts`
- Modify: `src/tools/host-tools-mcp-server.ts`
- Test: `tests/unit/tools/host-tools/schedule-manage.test.ts`

- [ ] **Step 1: Add failing schedule-manage tests**

Extend `tests/unit/tools/host-tools/schedule-manage.test.ts` with cases for:
- `create` accepts `promptFile`
- `create` rejects `{ prompt, promptFile }` together
- `update` accepts `promptFile`
- `update` preserves the existing prompt source when only `label` changes
- `update` replaces `prompt` with `promptFile` and clears the old inline prompt
- `update` replaces `promptFile` with `prompt` and clears the old file reference
- `list` includes `promptFile`

Use repository stubs that return an existing row for update-path merge cases.

- [ ] **Step 2: Run the schedule-manage tests to verify failure**

Run:

```bash
npx vitest run tests/unit/tools/host-tools/schedule-manage.test.ts
```

Expected:
- new `promptFile` assertions fail
- update merge expectations fail because current code overwrites payload with empty strings

- [ ] **Step 3: Implement the payload contract**

In `src/scheduler/schedule-types.ts`, add:

```ts
export interface SchedulePayload {
  label: string;
  prompt?: string;
  promptFile?: string;
}
```

In `src/tools/host-tools/schedule-manage.ts`:
- add `promptFile?: string` to `ScheduleManageArgs`
- import and use `SchedulePayload`
- add a small helper that normalizes a payload and rejects `prompt` + `promptFile` together
- on `create`, store either `{ label, prompt }` or `{ label, promptFile }`
- on `update`, fetch the existing row with `findById()` when any payload field changes and merge carefully:
  - if `label` is omitted, preserve the current label
  - if `prompt` is provided, set `prompt` and remove `promptFile`
  - if `promptFile` is provided, set `promptFile` and remove `prompt`
  - if neither is provided, preserve the current prompt source
- include `promptFile` in `handleList()`

In `src/tools/host-tools-mcp-server.ts`:
- add `promptFile` to `schedule_manage.inputSchema.properties`
- update the prompt descriptions to say `prompt` and `promptFile` are mutually exclusive

- [ ] **Step 4: Re-run the schedule-manage tests**

Run:

```bash
npx vitest run tests/unit/tools/host-tools/schedule-manage.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/schedule-types.ts src/tools/host-tools/schedule-manage.ts src/tools/host-tools-mcp-server.ts tests/unit/tools/host-tools/schedule-manage.test.ts
git commit -m "feat(schedule): add promptFile support to schedule.manage"
```

---

## Chunk 2: Scheduler Resolution and Persona Scaffolding

### Task 3: Resolve `promptFile` inside the scheduler at execution time

**Files:**
- Modify: `src/scheduler/scheduler.ts`
- Modify: `src/daemon/daemon-bootstrap.ts`
- Test: `tests/unit/scheduler/scheduler.test.ts`

- [ ] **Step 1: Add failing scheduler tests**

Extend `tests/unit/scheduler/scheduler.test.ts` with cases for:
- a due schedule with `payload.promptFile` resolves file contents through the persona loader and enqueues that content
- a due schedule with inline `payload.prompt` still enqueues unchanged
- a missing prompt alias or unreadable prompt file logs/skips and does not advance `next_run_at`
- a schedule that references an unloaded persona logs/skips and does not advance `next_run_at`

For these tests, inject a stub persona loader with:

```ts
{
  resolveTaskPrompt: vi.fn(),
}
```

and assert that `queueStub.enqueue` receives:

```ts
{
  label: 'Morning briefing',
  promptFile: 'morning-briefing',
  personaId,
  content: 'Rendered prompt file contents',
}
```

- [ ] **Step 2: Run the scheduler tests to confirm failure**

Run:

```bash
npx vitest run tests/unit/scheduler/scheduler.test.ts
```

Expected:
- constructor/type errors until the scheduler accepts the loader dependency
- new prompt-file execution assertions fail

- [ ] **Step 3: Implement async prompt resolution in the scheduler**

In `src/scheduler/scheduler.ts`:
- add `PersonaLoader` as a constructor dependency
- make `tick()` and `processSchedule()` `async`
- parse `SchedulePayload` instead of using an untyped record
- resolve execution content with this priority:
  1. if `payload.promptFile` exists, call `personaLoader.resolveTaskPrompt(schedule.persona_id, payload.promptFile)`
  2. else use `payload.prompt ?? ''`
- if prompt-file resolution fails:
  - log an error with `scheduleId`, `personaId`, and `promptFile`
  - return before enqueue
  - do not update `last_run_at` or `next_run_at`, so the schedule can be retried after the persona prompt file is fixed
- keep the existing invalid-JSON fallback path for malformed payloads

In `src/daemon/daemon-bootstrap.ts`, update the scheduler wiring:

```ts
const scheduler = new Scheduler(
  repos.schedule,
  queueManager,
  personaLoader,
  config.scheduler,
  logger,
);
```

- [ ] **Step 4: Re-run the scheduler tests**

Run:

```bash
npx vitest run tests/unit/scheduler/scheduler.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scheduler.ts src/daemon/daemon-bootstrap.ts tests/unit/scheduler/scheduler.test.ts
git commit -m "feat(scheduler): resolve persona prompt files at fire time"
```

### Task 4: Scaffold `prompts/` in `add-persona` and run focused regressions

**Files:**
- Modify: `src/cli/commands/add-persona.ts`
- Test: `tests/unit/cli/add-persona.test.ts`

- [ ] **Step 1: Add the failing CLI tests**

Extend `tests/unit/cli/add-persona.test.ts` with cases for:
- brand-new personas get an empty `prompts/` directory
- the generated `system.md` mentions the `prompts/` directory for scheduled-task prompts
- CLI success output mentions the created prompts folder
- existing persona directories still do not get scaffold folders retroactively unless the persona is brand new

- [ ] **Step 2: Run the CLI tests to confirm failure**

Run:

```bash
npx vitest run tests/unit/cli/add-persona.test.ts
```

Expected:
- `prompts/` directory assertions fail
- template/output assertions fail

- [ ] **Step 3: Implement prompts scaffolding**

In `src/cli/commands/add-persona.ts`:
- create `prompts/` alongside `personality/` when `isNewPersona` is true
- add a short note in `buildSystemPromptTemplate()` such as:

```md
<!-- Add task-specific prompt files under prompts/*.md and reference them from scheduled tasks via promptFile. -->
```

- update CLI success output to mention the prompts folder

- [ ] **Step 4: Re-run the CLI test and the end-to-end focused regression suite**

Run:

```bash
npx vitest run tests/unit/cli/add-persona.test.ts tests/unit/personas/persona-loader.test.ts tests/unit/personas/persona-loader-personality.test.ts tests/unit/tools/host-tools/schedule-manage.test.ts tests/unit/scheduler/scheduler.test.ts
```

Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/add-persona.ts tests/unit/cli/add-persona.test.ts
git commit -m "feat(cli): scaffold persona prompt directories"
```

---

## Notes for the Implementer

- Keep prompt-file contents out of persona startup. Only paths belong in `LoadedPersona`.
- Do not change system prompt assembly in `agent-runner.ts`; `promptFile` replaces the scheduled user message, not the system prompt.
- Preserve backward compatibility for existing inline `prompt` schedules.
- Treat missing `promptFile` the same way the current scheduler treats enqueue failure: log it, skip that fire, and leave the schedule eligible for retry.
- Do not let `schedule.manage update` silently erase an existing prompt source when only `label` changes.
