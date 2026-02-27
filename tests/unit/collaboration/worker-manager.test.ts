/**
 * Unit tests for WorkerManager.
 *
 * Uses a mocked RunRepository so no SQLite is involved.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { WorkerManager } from '../../../src/collaboration/worker-manager.js';
import { DbError } from '../../../src/core/errors/index.js';
import type { RunRepository, RunRow } from '../../../src/core/database/repositories/run-repository.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uuid(): string {
  return uuidv4();
}

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function makeMockRepo(): RunRepository {
  return {
    insert: vi.fn().mockImplementation((input) =>
      ok({ ...input, created_at: Date.now() } as RunRow),
    ),
    findById: vi.fn().mockReturnValue(ok(null)),
    findByThread: vi.fn().mockReturnValue(ok([])),
    findByParent: vi.fn().mockReturnValue(ok([])),
    updateStatus: vi.fn().mockReturnValue(ok(null)),
    updateTokens: vi.fn().mockReturnValue(ok(null)),
  } as unknown as RunRepository;
}

// ---------------------------------------------------------------------------
// trackChildRun
// ---------------------------------------------------------------------------

describe('WorkerManager.trackChildRun', () => {
  let manager: WorkerManager;

  beforeEach(() => {
    manager = new WorkerManager(makeMockRepo(), silentLogger());
  });

  it('returns a ChildRunInfo with status pending', () => {
    const parentId = uuid();
    const childId = uuid();

    const info = manager.trackChildRun(parentId, childId, 'worker-a');

    expect(info.id).toBe(childId);
    expect(info.parentRunId).toBe(parentId);
    expect(info.workerPersonaName).toBe('worker-a');
    expect(info.status).toBe('pending');
    expect(info.endedAt).toBeNull();
    expect(info.result).toBeNull();
    expect(info.error).toBeNull();
  });

  it('records a startedAt timestamp', () => {
    const before = Date.now();
    const info = manager.trackChildRun(uuid(), uuid(), 'worker-a');
    const after = Date.now();

    expect(info.startedAt).toBeGreaterThanOrEqual(before);
    expect(info.startedAt).toBeLessThanOrEqual(after);
  });

  it('allows tracking multiple children under the same parent', () => {
    const parentId = uuid();

    manager.trackChildRun(parentId, uuid(), 'worker-a');
    manager.trackChildRun(parentId, uuid(), 'worker-b');

    expect(manager.getChildRuns(parentId)).toHaveLength(2);
  });

  it('tracks children of different parents independently', () => {
    const p1 = uuid();
    const p2 = uuid();

    manager.trackChildRun(p1, uuid(), 'worker-a');
    manager.trackChildRun(p2, uuid(), 'worker-b');

    expect(manager.getChildRuns(p1)).toHaveLength(1);
    expect(manager.getChildRuns(p2)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// getChildRuns
// ---------------------------------------------------------------------------

describe('WorkerManager.getChildRuns', () => {
  it('returns an empty array for an unknown parent', () => {
    const manager = new WorkerManager(makeMockRepo(), silentLogger());
    expect(manager.getChildRuns(uuid())).toEqual([]);
  });

  it('returns all tracked children for a parent', () => {
    const manager = new WorkerManager(makeMockRepo(), silentLogger());
    const parentId = uuid();

    const c1 = manager.trackChildRun(parentId, uuid(), 'worker-a');
    const c2 = manager.trackChildRun(parentId, uuid(), 'worker-b');

    const children = manager.getChildRuns(parentId);
    expect(children).toHaveLength(2);
    expect(children).toContain(c1);
    expect(children).toContain(c2);
  });
});

// ---------------------------------------------------------------------------
// updateChildStatus
// ---------------------------------------------------------------------------

describe('WorkerManager.updateChildStatus', () => {
  let repo: RunRepository;
  let manager: WorkerManager;
  let parentId: string;
  let childId: string;

  beforeEach(() => {
    repo = makeMockRepo();
    manager = new WorkerManager(repo, silentLogger());
    parentId = uuid();
    childId = uuid();
    manager.trackChildRun(parentId, childId, 'worker-a');
  });

  it('updates the in-memory status', () => {
    manager.updateChildStatus(childId, 'running');

    const child = manager.getChildRuns(parentId)[0]!;
    expect(child.status).toBe('running');
  });

  it('sets endedAt when status is terminal (completed)', () => {
    manager.updateChildStatus(childId, 'completed');

    const child = manager.getChildRuns(parentId)[0]!;
    expect(child.endedAt).not.toBeNull();
  });

  it('sets endedAt when status is terminal (failed)', () => {
    manager.updateChildStatus(childId, 'failed', undefined, 'boom');

    const child = manager.getChildRuns(parentId)[0]!;
    expect(child.endedAt).not.toBeNull();
    expect(child.error).toBe('boom');
  });

  it('sets endedAt when status is terminal (cancelled)', () => {
    manager.updateChildStatus(childId, 'cancelled');

    const child = manager.getChildRuns(parentId)[0]!;
    expect(child.endedAt).not.toBeNull();
  });

  it('does not set endedAt for non-terminal statuses', () => {
    manager.updateChildStatus(childId, 'running');

    const child = manager.getChildRuns(parentId)[0]!;
    expect(child.endedAt).toBeNull();
  });

  it('stores the result string on success', () => {
    manager.updateChildStatus(childId, 'completed', 'output text');

    const child = manager.getChildRuns(parentId)[0]!;
    expect(child.result).toBe('output text');
  });

  it('calls runRepo.updateStatus with the given status', () => {
    manager.updateChildStatus(childId, 'running');

    expect(repo.updateStatus).toHaveBeenCalledWith(
      childId,
      'running',
      expect.any(Object),
    );
  });

  it('returns CollaborationError for unknown child run id', () => {
    const result = manager.updateChildStatus(uuid(), 'completed');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('COLLABORATION_ERROR');
    expect(result._unsafeUnwrapErr().message).toContain('Child run not found');
  });

  it('returns CollaborationError when repo update fails', () => {
    vi.mocked(repo.updateStatus).mockReturnValueOnce(
      err(new DbError('update failed')),
    );

    const result = manager.updateChildStatus(childId, 'completed');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Failed to update child run status');
  });
});

// ---------------------------------------------------------------------------
// canSendChannelMessage
// ---------------------------------------------------------------------------

describe('WorkerManager.canSendChannelMessage', () => {
  let manager: WorkerManager;
  let parentId: string;
  let childId: string;

  beforeEach(() => {
    manager = new WorkerManager(makeMockRepo(), silentLogger());
    parentId = uuid();
    childId = uuid();
    manager.trackChildRun(parentId, childId, 'worker-a');
  });

  it('returns true when the persona is in the allowed list', () => {
    expect(manager.canSendChannelMessage(childId, ['worker-a', 'supervisor'])).toBe(true);
  });

  it('returns false when the persona is not in the allowed list', () => {
    expect(manager.canSendChannelMessage(childId, ['supervisor'])).toBe(false);
  });

  it('returns false for an empty allowed list', () => {
    expect(manager.canSendChannelMessage(childId, [])).toBe(false);
  });

  it('returns false for an unknown child run id', () => {
    expect(manager.canSendChannelMessage(uuid(), ['worker-a'])).toBe(false);
  });

  it('is case-sensitive when comparing persona names', () => {
    expect(manager.canSendChannelMessage(childId, ['Worker-A'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRunSummary
// ---------------------------------------------------------------------------

describe('WorkerManager.getRunSummary', () => {
  let repo: RunRepository;
  let manager: WorkerManager;
  let parentId: string;

  beforeEach(() => {
    repo = makeMockRepo();
    manager = new WorkerManager(repo, silentLogger());
    parentId = uuid();
  });

  it('returns all-zero summary for unknown parent', () => {
    expect(manager.getRunSummary(uuid())).toEqual({
      total: 0,
      completed: 0,
      failed: 0,
      running: 0,
    });
  });

  it('counts a single pending worker as running', () => {
    manager.trackChildRun(parentId, uuid(), 'worker-a');

    expect(manager.getRunSummary(parentId)).toEqual({
      total: 1,
      completed: 0,
      failed: 0,
      running: 1,
    });
  });

  it('counts running status workers in running', () => {
    const childId = uuid();
    manager.trackChildRun(parentId, childId, 'worker-a');
    manager.updateChildStatus(childId, 'running');

    expect(manager.getRunSummary(parentId).running).toBe(1);
  });

  it('correctly tallies mixed statuses', () => {
    const c1 = manager.trackChildRun(parentId, uuid(), 'worker-a').id;
    const c2 = manager.trackChildRun(parentId, uuid(), 'worker-b').id;
    const c3 = manager.trackChildRun(parentId, uuid(), 'worker-c').id;
    const c4 = manager.trackChildRun(parentId, uuid(), 'worker-d').id;

    manager.updateChildStatus(c1, 'completed');
    manager.updateChildStatus(c2, 'completed');
    manager.updateChildStatus(c3, 'failed');
    // c4 stays pending

    const summary = manager.getRunSummary(parentId);
    expect(summary.total).toBe(4);
    expect(summary.completed).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.running).toBe(1);
  });
});
