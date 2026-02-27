/**
 * Unit tests for ScheduleManageHandler.
 *
 * Tests cover:
 *   - create: success with valid cron, invalid cron rejected, missing cronExpr
 *   - update: success with fields, missing scheduleId, invalid cron, no fields provided
 *   - cancel: success, missing scheduleId
 *   - invalid action
 *   - repository error propagation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';
import { ScheduleManageHandler } from '../../../../src/tools/host-tools/schedule-manage.js';
import type { ScheduleManageArgs } from '../../../../src/tools/host-tools/schedule-manage.js';
import type { ToolExecutionContext } from '../../../../src/tools/host-tools/channel-send.js';
import { DbError } from '../../../../src/core/errors/error-types.js';
import type { ScheduleRepository, ScheduleRow } from '../../../../src/core/database/repositories/schedule-repository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeContext(overrides: Partial<ToolExecutionContext> = {}): ToolExecutionContext {
  return {
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    requestId: 'req-001',
    ...overrides,
  };
}

function makeScheduleRow(overrides: Partial<ScheduleRow> = {}): ScheduleRow {
  return {
    id: 'sched-001',
    persona_id: 'persona-001',
    thread_id: 'thread-001',
    type: 'cron',
    expression: '0 9 * * 1',
    payload: '{"label":"Daily standup","prompt":"What should I focus on today?"}',
    enabled: 1,
    last_run_at: null,
    next_run_at: null,
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

function makeRepo(overrides: Partial<ScheduleRepository> = {}): ScheduleRepository {
  return {
    insert: vi.fn().mockReturnValue(ok(makeScheduleRow())),
    update: vi.fn().mockReturnValue(ok(makeScheduleRow())),
    disable: vi.fn().mockReturnValue(ok(undefined)),
    enable: vi.fn().mockReturnValue(ok(undefined)),
    findByPersona: vi.fn().mockReturnValue(ok([])),
    findDue: vi.fn().mockReturnValue(ok([])),
    updateNextRun: vi.fn().mockReturnValue(ok(null)),
    ...overrides,
  } as unknown as ScheduleRepository;
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — manifest', () => {
  it('has the correct tool name', () => {
    expect(ScheduleManageHandler.manifest.name).toBe('schedule.manage');
  });

  it('has executionLocation set to host', () => {
    expect(ScheduleManageHandler.manifest.executionLocation).toBe('host');
  });

  it('declares schedule.write:own capability', () => {
    expect(ScheduleManageHandler.manifest.capabilities).toContain('schedule.write:own');
  });
});

// ---------------------------------------------------------------------------
// Action: create
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — create', () => {
  it('creates a schedule with valid cron expression', async () => {
    const insertFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const repo = makeRepo({ insert: insertFn });
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 9 * * 1', label: 'Standup', prompt: 'What to do?' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect(result.tool).toBe('schedule.manage');
    expect((result.result as { action: string }).action).toBe('create');
    expect((result.result as { created: boolean }).created).toBe(true);
    expect((result.result as { scheduleId: string }).scheduleId).toBeTruthy();
  });

  it('inserts schedule with correct fields', async () => {
    const insertFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const repo = makeRepo({ insert: insertFn });
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    await handler.execute(
      { action: 'create', cronExpr: '*/5 * * * *', label: 'Poll', prompt: 'Check status' },
      makeContext({ personaId: 'persona-abc', threadId: 'thread-xyz' }),
    );

    const insertArg = insertFn.mock.calls[0][0];
    expect(insertArg.persona_id).toBe('persona-abc');
    expect(insertArg.thread_id).toBe('thread-xyz');
    expect(insertArg.expression).toBe('*/5 * * * *');
    expect(insertArg.type).toBe('cron');
    expect(insertArg.enabled).toBe(1);
    expect(JSON.parse(insertArg.payload)).toEqual({ label: 'Poll', prompt: 'Check status' });
  });

  it('returns error when cronExpr is missing', async () => {
    const repo = makeRepo();
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'create' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/cronExpr is required/);
  });

  it('returns error for invalid cron expression', async () => {
    const repo = makeRepo();
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'create', cronExpr: 'not-a-cron' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid cron expression/);
  });

  it('propagates insert repository errors', async () => {
    const repo = makeRepo({
      insert: vi.fn().mockReturnValue(err(new DbError('db locked'))),
    });
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 * * * *' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/create failed/);
  });

  it('handles missing label and prompt gracefully', async () => {
    const insertFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const repo = makeRepo({ insert: insertFn });
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'create', cronExpr: '0 0 * * *' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    const payload = JSON.parse(insertFn.mock.calls[0][0].payload);
    expect(payload).toEqual({ label: '', prompt: '' });
  });
});

// ---------------------------------------------------------------------------
// Action: update
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — update', () => {
  it('updates an existing schedule', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const repo = makeRepo({ update: updateFn });
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001', cronExpr: '0 10 * * *', label: 'New label' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect((result.result as { updated: boolean }).updated).toBe(true);
  });

  it('calls update with correct persona_id for ownership enforcement', async () => {
    const updateFn = vi.fn().mockReturnValue(ok(makeScheduleRow()));
    const repo = makeRepo({ update: updateFn });
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    await handler.execute(
      { action: 'update', scheduleId: 'sched-001', cronExpr: '0 10 * * *' },
      makeContext({ personaId: 'persona-xyz' }),
    );

    expect(updateFn).toHaveBeenCalledWith('sched-001', 'persona-xyz', expect.any(Object));
  });

  it('returns error when scheduleId is missing', async () => {
    const repo = makeRepo();
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'update', cronExpr: '0 * * * *' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/scheduleId is required/);
  });

  it('returns error for invalid cron expression in update', async () => {
    const repo = makeRepo();
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001', cronExpr: 'bad cron here' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid cron expression/);
  });

  it('returns error when no update fields are provided', async () => {
    const repo = makeRepo();
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/no fields provided to update/);
  });

  it('propagates update repository errors', async () => {
    const repo = makeRepo({
      update: vi.fn().mockReturnValue(err(new DbError('not found'))),
    });
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'update', scheduleId: 'sched-001', label: 'Updated label' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/update failed/);
  });
});

// ---------------------------------------------------------------------------
// Action: cancel
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — cancel', () => {
  it('cancels a schedule by disabling it', async () => {
    const disableFn = vi.fn().mockReturnValue(ok(undefined));
    const repo = makeRepo({ disable: disableFn });
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'cancel', scheduleId: 'sched-001' },
      makeContext(),
    );

    expect(result.status).toBe('success');
    expect((result.result as { cancelled: boolean }).cancelled).toBe(true);
    expect(disableFn).toHaveBeenCalledWith('sched-001');
  });

  it('returns error when scheduleId is missing', async () => {
    const repo = makeRepo();
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'cancel' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/scheduleId is required/);
  });

  it('returns error when scheduleId is empty string', async () => {
    const repo = makeRepo();
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'cancel', scheduleId: '' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/scheduleId is required/);
  });

  it('propagates disable repository errors', async () => {
    const repo = makeRepo({
      disable: vi.fn().mockReturnValue(err(new DbError('row not found'))),
    });
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'cancel', scheduleId: 'sched-001' },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/cancel failed/);
  });
});

// ---------------------------------------------------------------------------
// Invalid action
// ---------------------------------------------------------------------------

describe('ScheduleManageHandler — invalid action', () => {
  it('returns error for unknown action', async () => {
    const repo = makeRepo();
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: 'pause' as ScheduleManageArgs['action'] },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid action/);
  });

  it('returns error for missing action', async () => {
    const repo = makeRepo();
    const handler = new ScheduleManageHandler({ scheduleRepository: repo, logger: makeLogger() });

    const result = await handler.execute(
      { action: undefined as unknown as ScheduleManageArgs['action'] },
      makeContext(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toMatch(/invalid action/);
  });
});
