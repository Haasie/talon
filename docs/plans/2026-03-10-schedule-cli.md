# Schedule CLI Commands Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace dead config-based schedules with CLI commands that insert directly into the DB.

**Architecture:** Three new CLI commands (`add-schedule`, `list-schedules`, `remove-schedule`) that open the DB directly (like `migrate` command), plus a guided skill. Remove `ScheduleConfigSchema` and `schedules` array from config. Add `findAll()` to `ScheduleRepository`.

**Tech Stack:** TypeScript, Commander.js, better-sqlite3, vitest, cron-parser

---

### Task 1: Remove config schedule schema

**Files:**
- Modify: `src/core/config/config-schema.ts:92-100`
- Modify: `src/core/config/config-schema.ts:148` (remove `schedules` from TalondConfigSchema)
- Modify: `src/core/config/config-types.ts:18,50` (remove ScheduleConfig export)
- Modify: `src/core/config/index.ts:22,38` (remove ScheduleConfig re-export)
- Modify: `src/cli/config-utils.ts:37` (remove `schedules` from YamlDocument)

**Step 1: Remove ScheduleConfigSchema from config-schema.ts**

Delete lines 88-100 (the `// Schedule` comment block and `ScheduleConfigSchema`).

In `TalondConfigSchema` (line 148), remove:
```typescript
schedules: z.array(ScheduleConfigSchema).default([]),
```

**Step 2: Remove ScheduleConfig type export from config-types.ts**

Remove the import of `ScheduleConfigSchema` (line 18) and the type export (line 50):
```typescript
export type ScheduleConfig = z.infer<typeof ScheduleConfigSchema>;
```

**Step 3: Remove from index.ts re-exports**

Remove `ScheduleConfigSchema` from the schema re-export (line 22) and `ScheduleConfig` from the type re-export (around line 38).

**Step 4: Remove from config-utils.ts YamlDocument**

Remove `schedules?: unknown[];` from the `YamlDocument` interface (line 37).

**Step 5: Search for any remaining references**

Run: `rg 'ScheduleConfig[^S]|config\.schedules|config.schedules' src/`

Fix any remaining references.

**Step 6: Verify build**

Run: `npx tsc --noEmit`
Expected: 0 errors

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: remove dead ScheduleConfigSchema from config"
```

---

### Task 2: Add findAll() to ScheduleRepository

**Files:**
- Modify: `src/core/database/repositories/schedule-repository.ts`
- Create: `tests/unit/cli/schedule-commands.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/cli/schedule-commands.test.ts` with a test that calls `ScheduleRepository.findAll()`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { runMigrations } from '../../../src/core/database/migrations/runner.js';
import { v4 as uuidv4 } from 'uuid';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const migrationsDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../src/core/database/migrations',
);

let db: Database.Database;
let repo: ScheduleRepository;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db, migrationsDir);
  repo = new ScheduleRepository(db);
});

afterEach(() => {
  db.close();
});

describe('ScheduleRepository.findAll()', () => {
  it('returns empty array when no schedules exist', () => {
    const result = repo.findAll();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('returns all schedules across personas', () => {
    // Insert two personas first (FK requirement)
    db.prepare(`INSERT INTO personas (id, name, model, system_prompt_file, skills, capabilities, mounts, max_concurrent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('p1', 'bot-a', 'claude-sonnet-4-6', null, '[]', '{}', '[]', null, Date.now(), Date.now());
    db.prepare(`INSERT INTO personas (id, name, model, system_prompt_file, skills, capabilities, mounts, max_concurrent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('p2', 'bot-b', 'claude-sonnet-4-6', null, '[]', '{}', '[]', null, Date.now(), Date.now());

    repo.insert({ id: uuidv4(), persona_id: 'p1', thread_id: null, type: 'cron', expression: '0 9 * * *', payload: '{}', enabled: 1, last_run_at: null, next_run_at: Date.now() + 60000 });
    repo.insert({ id: uuidv4(), persona_id: 'p2', thread_id: null, type: 'cron', expression: '0 21 * * *', payload: '{}', enabled: 1, last_run_at: null, next_run_at: Date.now() + 60000 });

    const result = repo.findAll();
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(2);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/schedule-commands.test.ts`
Expected: FAIL — `findAll is not a function`

**Step 3: Add findAll() to ScheduleRepository**

In `schedule-repository.ts`, add a prepared statement in the constructor:

```typescript
private readonly findAllStmt: Database.Statement;
// in constructor:
this.findAllStmt = db.prepare(`SELECT * FROM schedules ORDER BY created_at ASC`);
```

Add the method:

```typescript
/** Returns all schedules. */
findAll(): Result<ScheduleRow[], DbError> {
  try {
    const rows = this.findAllStmt.all() as ScheduleRow[];
    return ok(rows);
  } catch (cause) {
    return err(new DbError(`Failed to list all schedules: ${String(cause)}`, cause instanceof Error ? cause : undefined));
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/cli/schedule-commands.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/core/database/repositories/schedule-repository.ts tests/unit/cli/schedule-commands.test.ts
git commit -m "feat: add findAll() to ScheduleRepository"
```

---

### Task 3: Implement add-schedule command

**Files:**
- Create: `src/cli/commands/add-schedule.ts`
- Modify: `tests/unit/cli/schedule-commands.test.ts`

**Step 1: Write the failing tests**

Add to `schedule-commands.test.ts`:

```typescript
import { addSchedule, type AddScheduleOptions } from '../../../src/cli/commands/add-schedule.js';

describe('addSchedule()', () => {
  // Helper: insert persona + channel + binding into test DB
  function seedPersonaAndChannel(personaName: string, channelName: string) {
    const personaId = uuidv4();
    const channelId = uuidv4();
    db.prepare(`INSERT INTO personas (id, name, model, system_prompt_file, skills, capabilities, mounts, max_concurrent, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(personaId, personaName, 'claude-sonnet-4-6', null, '[]', '{}', '[]', null, Date.now(), Date.now());
    db.prepare(`INSERT INTO channels (id, name, type, enabled, config, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(channelId, channelName, 'telegram', 1, '{}', Date.now(), Date.now());
    return { personaId, channelId };
  }

  it('creates a schedule with correct fields', async () => {
    seedPersonaAndChannel('assistant', 'TalonMain');
    const result = await addSchedule({
      persona: 'assistant',
      channel: 'TalonMain',
      cron: '0 9 * * *',
      label: 'morning-check',
      prompt: 'Good morning!',
      db,
    });
    expect(result.id).toBeDefined();
    expect(result.expression).toBe('0 9 * * *');
    expect(result.nextRunAt).toBeDefined();
  });

  it('reuses existing schedule thread for same persona+channel', async () => {
    seedPersonaAndChannel('assistant', 'TalonMain');
    const r1 = await addSchedule({ persona: 'assistant', channel: 'TalonMain', cron: '0 9 * * *', label: 'a', prompt: 'a', db });
    const r2 = await addSchedule({ persona: 'assistant', channel: 'TalonMain', cron: '0 21 * * *', label: 'b', prompt: 'b', db });
    expect(r1.threadId).toBe(r2.threadId);
  });

  it('throws for unknown persona', async () => {
    await expect(addSchedule({ persona: 'ghost', channel: 'TalonMain', cron: '0 9 * * *', label: 'x', prompt: 'x', db })).rejects.toThrow(/persona.*not found/i);
  });

  it('throws for unknown channel', async () => {
    seedPersonaAndChannel('assistant', 'TalonMain');
    await expect(addSchedule({ persona: 'assistant', channel: 'nope', cron: '0 9 * * *', label: 'x', prompt: 'x', db })).rejects.toThrow(/channel.*not found/i);
  });

  it('throws for invalid cron expression', async () => {
    seedPersonaAndChannel('assistant', 'TalonMain');
    await expect(addSchedule({ persona: 'assistant', channel: 'TalonMain', cron: 'not-a-cron', label: 'x', prompt: 'x', db })).rejects.toThrow(/invalid cron/i);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/schedule-commands.test.ts`
Expected: FAIL — cannot import `addSchedule`

**Step 3: Implement add-schedule.ts**

Create `src/cli/commands/add-schedule.ts`:

```typescript
/**
 * `talonctl add-schedule` command.
 *
 * Inserts a schedule directly into the database.
 * Creates/reuses a "schedule thread" for the persona+channel combo.
 */

import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';

import { ScheduleRepository } from '../../core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../core/database/repositories/channel-repository.js';
import { ThreadRepository } from '../../core/database/repositories/thread-repository.js';
import { getNextCronTime, isValidCronExpression } from '../../scheduler/cron-evaluator.js';

export interface AddScheduleOptions {
  persona: string;
  channel: string;
  cron: string;
  label: string;
  prompt: string;
  db: Database.Database;
}

export interface AddScheduleResult {
  id: string;
  threadId: string;
  expression: string;
  label: string;
  nextRunAt: number;
}

/**
 * Core logic: validates inputs, finds/creates schedule thread, inserts schedule.
 */
export async function addSchedule(options: AddScheduleOptions): Promise<AddScheduleResult> {
  const { db, persona, channel, cron, label, prompt } = options;

  // Validate cron expression.
  if (!isValidCronExpression(cron)) {
    throw new Error(`Invalid cron expression "${cron}". Expected 5-field cron format (minute hour day month weekday).`);
  }

  // Look up persona.
  const personaRepo = new PersonaRepository(db);
  const personaResult = personaRepo.findByName(persona);
  if (personaResult.isErr() || personaResult.value === null) {
    throw new Error(`Persona "${persona}" not found in database. Is the daemon running?`);
  }
  const personaRow = personaResult.value;

  // Look up channel.
  const channelRepo = new ChannelRepository(db);
  const channelResult = channelRepo.findByName(channel);
  if (channelResult.isErr() || channelResult.value === null) {
    throw new Error(`Channel "${channel}" not found in database. Is the daemon running?`);
  }
  const channelRow = channelResult.value;

  // Find or create schedule thread.
  const threadRepo = new ThreadRepository(db);
  const scheduleExternalId = `schedule:${persona}:${channel}`;
  const existingThread = threadRepo.findByExternalId(channelRow.id, scheduleExternalId);
  let threadId: string;

  if (existingThread.isOk() && existingThread.value !== null) {
    threadId = existingThread.value.id;
  } else {
    threadId = uuidv4();
    const threadInsert = threadRepo.insert({
      id: threadId,
      channel_id: channelRow.id,
      external_id: scheduleExternalId,
      metadata: JSON.stringify({ type: 'schedule', persona, channel }),
    });
    if (threadInsert.isErr()) {
      throw new Error(`Failed to create schedule thread: ${threadInsert.error.message}`);
    }
  }

  // Compute next run time.
  const nextRunResult = getNextCronTime(cron);
  if (nextRunResult.isErr()) {
    throw new Error(`Failed to compute next run time: ${nextRunResult.error.message}`);
  }

  // Insert schedule.
  const scheduleId = uuidv4();
  const scheduleRepo = new ScheduleRepository(db);
  const payload = JSON.stringify({ label, prompt });

  const insertResult = scheduleRepo.insert({
    id: scheduleId,
    persona_id: personaRow.id,
    thread_id: threadId,
    type: 'cron',
    expression: cron,
    payload,
    enabled: 1,
    last_run_at: null,
    next_run_at: nextRunResult.value,
  });

  if (insertResult.isErr()) {
    throw new Error(`Failed to insert schedule: ${insertResult.error.message}`);
  }

  return {
    id: scheduleId,
    threadId,
    expression: cron,
    label,
    nextRunAt: nextRunResult.value,
  };
}

/**
 * CLI wrapper — opens DB, calls addSchedule, prints result.
 */
export async function addScheduleCommand(options: {
  persona: string;
  channel: string;
  cron: string;
  label: string;
  prompt: string;
  configPath: string;
}): Promise<void> {
  const { loadConfig } = await import('../../core/config/config-loader.js');
  const { createDatabase } = await import('../../core/database/connection.js');

  const configResult = loadConfig(options.configPath);
  if (configResult.isErr()) {
    console.error(`Error: ${configResult.error.message}`);
    process.exit(1);
    return;
  }

  const dbResult = createDatabase(configResult.value.storage.path);
  if (dbResult.isErr()) {
    console.error(`Error: ${dbResult.error.message}`);
    process.exit(1);
    return;
  }

  const db = dbResult.value;
  try {
    const result = await addSchedule({ ...options, db });
    console.log(`Schedule created: ${result.id}`);
    console.log(`  Label:    ${result.label}`);
    console.log(`  Cron:     ${result.expression}`);
    console.log(`  Next run: ${new Date(result.nextRunAt).toISOString()}`);
    console.log(`  Thread:   ${result.threadId}`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
```

**Step 4: Run tests**

Run: `npx vitest run tests/unit/cli/schedule-commands.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/commands/add-schedule.ts tests/unit/cli/schedule-commands.test.ts
git commit -m "feat(cli): add-schedule command with thread reuse"
```

---

### Task 4: Implement list-schedules and remove-schedule commands

**Files:**
- Create: `src/cli/commands/list-schedules.ts`
- Create: `src/cli/commands/remove-schedule.ts`
- Modify: `tests/unit/cli/schedule-commands.test.ts`

**Step 1: Write tests for listSchedules**

Add to test file:

```typescript
import { listSchedules } from '../../../src/cli/commands/list-schedules.js';

describe('listSchedules()', () => {
  it('returns empty array when no schedules', () => {
    const result = listSchedules({ db });
    expect(result).toEqual([]);
  });

  it('returns schedules with persona names', async () => {
    seedPersonaAndChannel('assistant', 'TalonMain');
    await addSchedule({ persona: 'assistant', channel: 'TalonMain', cron: '0 9 * * *', label: 'test', prompt: 'hello', db });
    const result = listSchedules({ db });
    expect(result).toHaveLength(1);
    expect(result[0].label).toBe('test');
    expect(result[0].personaName).toBe('assistant');
  });
});
```

**Step 2: Write tests for removeSchedule**

```typescript
import { removeSchedule } from '../../../src/cli/commands/remove-schedule.js';

describe('removeSchedule()', () => {
  it('disables a schedule by ID', async () => {
    seedPersonaAndChannel('assistant', 'TalonMain');
    const s = await addSchedule({ persona: 'assistant', channel: 'TalonMain', cron: '0 9 * * *', label: 'rm-test', prompt: 'x', db });
    removeSchedule({ scheduleId: s.id, db });
    const schedules = listSchedules({ db });
    expect(schedules[0].enabled).toBe(false);
  });

  it('throws for unknown schedule ID', () => {
    expect(() => removeSchedule({ scheduleId: 'nonexistent', db })).toThrow(/not found/i);
  });
});
```

**Step 3: Implement list-schedules.ts**

```typescript
/**
 * `talonctl list-schedules` command.
 */
import type Database from 'better-sqlite3';
import { ScheduleRepository } from '../../core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../core/database/repositories/persona-repository.js';

export interface ScheduleInfo {
  id: string;
  personaName: string;
  expression: string;
  label: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
}

export function listSchedules(options: { db: Database.Database; persona?: string }): ScheduleInfo[] {
  const scheduleRepo = new ScheduleRepository(options.db);
  const personaRepo = new PersonaRepository(options.db);

  const allPersonas = personaRepo.findAll();
  const personaMap = new Map<string, string>();
  if (allPersonas.isOk()) {
    for (const p of allPersonas.value) {
      personaMap.set(p.id, p.name);
    }
  }

  let rows;
  if (options.persona) {
    const pRow = personaRepo.findByName(options.persona);
    if (pRow.isErr() || pRow.value === null) return [];
    const result = scheduleRepo.findByPersona(pRow.value.id);
    rows = result.isOk() ? result.value : [];
  } else {
    const result = scheduleRepo.findAll();
    rows = result.isOk() ? result.value : [];
  }

  return rows.map((row) => {
    let label = '';
    let prompt = '';
    try {
      const p = JSON.parse(row.payload) as { label?: string; prompt?: string };
      label = p.label ?? '';
      prompt = p.prompt ?? '';
    } catch { /* ignore */ }

    return {
      id: row.id,
      personaName: personaMap.get(row.persona_id) ?? row.persona_id,
      expression: row.expression,
      label,
      prompt,
      enabled: row.enabled === 1,
      nextRunAt: row.next_run_at ? new Date(row.next_run_at).toISOString() : null,
      lastRunAt: row.last_run_at ? new Date(row.last_run_at).toISOString() : null,
    };
  });
}

export async function listSchedulesCommand(options: { configPath: string; persona?: string }): Promise<void> {
  const { loadConfig } = await import('../../core/config/config-loader.js');
  const { createDatabase } = await import('../../core/database/connection.js');

  const configResult = loadConfig(options.configPath);
  if (configResult.isErr()) { console.error(`Error: ${configResult.error.message}`); process.exit(1); return; }
  const dbResult = createDatabase(configResult.value.storage.path);
  if (dbResult.isErr()) { console.error(`Error: ${dbResult.error.message}`); process.exit(1); return; }

  const db = dbResult.value;
  try {
    const schedules = listSchedules({ db, persona: options.persona });
    if (schedules.length === 0) { console.log('No schedules found.'); return; }

    console.log(`${'ID'.padEnd(10)} ${'PERSONA'.padEnd(15)} ${'LABEL'.padEnd(20)} ${'CRON'.padEnd(18)} ${'ENABLED'.padEnd(8)} NEXT RUN`);
    console.log(`${'─'.repeat(10)} ${'─'.repeat(15)} ${'─'.repeat(20)} ${'─'.repeat(18)} ${'─'.repeat(8)} ${'─'.repeat(24)}`);
    for (const s of schedules) {
      console.log(`${s.id.slice(0, 8).padEnd(10)} ${s.personaName.padEnd(15)} ${s.label.padEnd(20)} ${s.expression.padEnd(18)} ${(s.enabled ? 'yes' : 'no').padEnd(8)} ${s.nextRunAt ?? 'n/a'}`);
    }
  } catch (error) { console.error(`Error: ${(error as Error).message}`); process.exit(1); }
  finally { db.close(); }
}
```

**Step 4: Implement remove-schedule.ts**

```typescript
/**
 * `talonctl remove-schedule` command.
 */
import type Database from 'better-sqlite3';
import { ScheduleRepository } from '../../core/database/repositories/schedule-repository.js';

export function removeSchedule(options: { scheduleId: string; db: Database.Database }): void {
  const repo = new ScheduleRepository(options.db);
  const existing = repo.findById(options.scheduleId);
  // findById isn't exposed yet — use findAll and filter, or add it
  // Actually it exists as a private stmt. We need to expose it. See step below.

  const disableResult = repo.disable(options.scheduleId);
  if (disableResult.isErr()) {
    throw new Error(`Schedule "${options.scheduleId}" not found or could not be disabled.`);
  }
}
```

Note: `findById` is a prepared statement but not exposed as a public method. We need to add a public `findById()` method to `ScheduleRepository` (same pattern as other repos).

**Step 5: Run tests, verify pass**

Run: `npx vitest run tests/unit/cli/schedule-commands.test.ts`

**Step 6: Commit**

```bash
git add src/cli/commands/list-schedules.ts src/cli/commands/remove-schedule.ts tests/unit/cli/schedule-commands.test.ts
git commit -m "feat(cli): list-schedules and remove-schedule commands"
```

---

### Task 5: Register commands in CLI entry point

**Files:**
- Modify: `src/cli/index.ts`

**Step 1: Add imports and command registrations**

Add imports:
```typescript
import { addScheduleCommand } from './commands/add-schedule.js';
import { listSchedulesCommand } from './commands/list-schedules.js';
import { removeScheduleCommand } from './commands/remove-schedule.js';
```

Add commander registrations (after the `config-show` command):

```typescript
program
  .command('add-schedule')
  .description('Create a scheduled task for a persona')
  .requiredOption('--persona <name>', 'Persona name')
  .requiredOption('--channel <name>', 'Channel to bind the schedule thread to')
  .requiredOption('--cron <expr>', 'Cron expression (5-field)')
  .requiredOption('--label <label>', 'Human-readable label')
  .requiredOption('--prompt <prompt>', 'Prompt text for the agent')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts) => {
    await addScheduleCommand({
      persona: opts.persona,
      channel: opts.channel,
      cron: opts.cron,
      label: opts.label,
      prompt: opts.prompt,
      configPath: opts.config,
    });
  });

program
  .command('list-schedules')
  .description('List all scheduled tasks')
  .option('--persona <name>', 'Filter by persona name')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts) => {
    await listSchedulesCommand({ configPath: opts.config, persona: opts.persona });
  });

program
  .command('remove-schedule')
  .description('Disable a scheduled task')
  .argument('<schedule-id>', 'Schedule ID to remove')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (scheduleId, opts) => {
    await removeScheduleCommand({ scheduleId, configPath: opts.config });
  });
```

**Step 2: Verify build**

Run: `npx tsc --noEmit`

**Step 3: Commit**

```bash
git add src/cli/index.ts
git commit -m "feat(cli): register schedule commands in talonctl"
```

---

### Task 6: Create manage-schedules skill

**Files:**
- Create: `.claude/skills/manage-schedules/SKILL.md`

**Step 1: Write the skill**

```markdown
---
name: manage-schedules
description: |
  Manage scheduled tasks for Talon personas. Use when the user says
  "add schedule", "create schedule", "list schedules", "remove schedule",
  "scheduled task", or "cron job".
triggers:
  - "add schedule"
  - "create schedule"
  - "list schedules"
  - "remove schedule"
  - "scheduled task"
  - "cron job"
---

# Manage Schedules

Guide the user through creating, listing, or removing scheduled tasks.

## Phase 1: Determine Action

Ask what they want to do:
1. **Create** a new scheduled task
2. **List** existing schedules
3. **Remove** a schedule

## Phase 2a: Create Schedule

1. Run `npx talonctl list-personas` to show available personas.
2. Ask which persona should run the task.
3. Run `npx talonctl list-channels` to show available channels.
4. Ask which channel to bind the schedule to (this creates a thread for the schedule on that channel).
5. Ask for the cron expression. Offer common presets:
   - Every hour: `0 * * * *`
   - Twice daily (9am, 9pm): `0 9,21 * * *`
   - Daily at 9am: `0 9 * * *`
   - Every Monday at 9am: `0 9 * * 1`
   - Every 30 minutes: `*/30 * * * *`
6. Ask for a label (short name like `memory-grooming` or `git-pull-notes`).
7. Ask for the prompt (what the agent should do when triggered).
8. Run: `npx talonctl add-schedule --persona <name> --channel <channel> --cron "<expr>" --label "<label>" --prompt "<prompt>" --config talond.yaml`
9. Confirm with schedule ID and next run time.

## Phase 2b: List Schedules

Run: `npx talonctl list-schedules --config talond.yaml`
Optionally filter: `--persona <name>`

## Phase 2c: Remove Schedule

1. Run `npx talonctl list-schedules` to show existing schedules.
2. Ask which schedule to remove (by ID).
3. Run: `npx talonctl remove-schedule <id> --config talond.yaml`

## Notes

- Schedules fire in system local time (CET on the VM).
- Schedule output is silent — the agent only sends messages if it explicitly uses channel.send.
- The daemon must be running for schedules to fire (they live in the DB, not the config).
- After creating schedules, remind the user: schedules require a running daemon to execute.
```

**Step 2: Commit**

```bash
git add .claude/skills/manage-schedules/SKILL.md
git commit -m "feat: add manage-schedules skill"
```

---

### Task 7: Build, test full suite, clean up

**Step 1: Run full test suite for schedule tests**

Run: `npx vitest run tests/unit/cli/schedule-commands.test.ts`
Expected: All tests pass.

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: 0 errors.

**Step 3: Build**

Run: `npm run build`
Expected: Clean build.

**Step 4: Remove schedules from VM config if still present**

Verify `talond.yaml` on VM has `schedules: []` (already done).

**Step 5: Final commit if needed, push**

```bash
git push -u origin feat/schedule-cli
```
