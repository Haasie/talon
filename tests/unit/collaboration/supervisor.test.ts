/**
 * Unit tests for the Supervisor collaboration orchestrator.
 *
 * Uses a mocked RunRepository so we never touch SQLite; all assertions
 * are against the in-memory session state and Result values.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import { Supervisor } from '../../../src/collaboration/supervisor.js';
import { DbError } from '../../../src/core/errors/index.js';
import type { RunRepository, RunRow } from '../../../src/core/database/repositories/run-repository.js';
import type {
  SupervisorConfig,
  WorkerConfig,
  WorkerResult,
} from '../../../src/collaboration/collaboration-types.js';

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

function makeDefaultSupervisorConfig(overrides: Partial<SupervisorConfig> = {}): SupervisorConfig {
  return {
    supervisorPersonaName: 'lead',
    workerPersonaNames: ['worker-a', 'worker-b'],
    maxWorkers: 3,
    retryPolicy: { maxRetries: 2, backoffBaseMs: 100 },
    ...overrides,
  };
}

function makeWorkerConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    personaName: 'worker-a',
    taskDescription: 'Do something useful',
    payload: { key: 'value' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// createSession
// ---------------------------------------------------------------------------

describe('Supervisor.createSession', () => {
  let repo: RunRepository;
  let supervisor: Supervisor;

  beforeEach(() => {
    repo = makeMockRepo();
    supervisor = new Supervisor(repo, silentLogger());
  });

  it('returns a CollaborationSession with status active', () => {
    const supervisorRunId = uuid();
    const config = makeDefaultSupervisorConfig();

    const result = supervisor.createSession(supervisorRunId, config);

    expect(result.isOk()).toBe(true);
    const session = result._unsafeUnwrap();
    expect(session.supervisorRunId).toBe(supervisorRunId);
    expect(session.status).toBe('active');
    expect(session.workers).toHaveLength(0);
  });

  it('assigns a unique id to each session', () => {
    const runId = uuid();
    const config = makeDefaultSupervisorConfig();

    const s1 = supervisor.createSession(runId, config)._unsafeUnwrap();
    const s2 = supervisor.createSession(runId, config)._unsafeUnwrap();

    expect(s1.id).not.toBe(s2.id);
  });

  it('returns CollaborationError when supervisorRunId is empty', () => {
    const result = supervisor.createSession('', makeDefaultSupervisorConfig());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('COLLABORATION_ERROR');
  });

  it('stores the session so getSession can retrieve it', () => {
    const runId = uuid();
    const session = supervisor.createSession(runId, makeDefaultSupervisorConfig())._unsafeUnwrap();

    expect(supervisor.getSession(session.id)).toBe(session);
  });
});

// ---------------------------------------------------------------------------
// spawnWorker
// ---------------------------------------------------------------------------

describe('Supervisor.spawnWorker', () => {
  let repo: RunRepository;
  let supervisor: Supervisor;
  let sessionId: string;
  let supervisorConfig: SupervisorConfig;

  beforeEach(() => {
    repo = makeMockRepo();
    supervisor = new Supervisor(repo, silentLogger());
    supervisorConfig = makeDefaultSupervisorConfig({ maxWorkers: 2 });
    const s = supervisor
      .createSession(uuid(), supervisorConfig)
      ._unsafeUnwrap();
    sessionId = s.id;
  });

  it('returns a ChildRunInfo with status pending', () => {
    const result = supervisor.spawnWorker(sessionId, makeWorkerConfig(), supervisorConfig);

    expect(result.isOk()).toBe(true);
    const child = result._unsafeUnwrap();
    expect(child.status).toBe('pending');
    expect(child.workerPersonaName).toBe('worker-a');
    expect(child.endedAt).toBeNull();
    expect(child.result).toBeNull();
    expect(child.error).toBeNull();
  });

  it('inserts a run record in the repository', () => {
    supervisor.spawnWorker(sessionId, makeWorkerConfig(), supervisorConfig);

    expect(repo.insert).toHaveBeenCalledOnce();
  });

  it('appends the worker to the session workers list', () => {
    supervisor.spawnWorker(sessionId, makeWorkerConfig(), supervisorConfig);

    const session = supervisor.getSession(sessionId)!;
    expect(session.workers).toHaveLength(1);
  });

  it('returns CollaborationError for unknown session', () => {
    const result = supervisor.spawnWorker(uuid(), makeWorkerConfig(), supervisorConfig);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('COLLABORATION_ERROR');
    expect(result._unsafeUnwrapErr().message).toContain('Session not found');
  });

  it('returns CollaborationError when maxWorkers is exceeded', () => {
    const cfg = makeDefaultSupervisorConfig({ maxWorkers: 1 });
    const s = supervisor.createSession(uuid(), cfg)._unsafeUnwrap();

    // Spawn the first (allowed) worker.
    supervisor.spawnWorker(s.id, makeWorkerConfig({ personaName: 'worker-a' }), cfg);

    // Spawn a second one — should fail.
    const result = supervisor.spawnWorker(
      s.id,
      makeWorkerConfig({ personaName: 'worker-b' }),
      cfg,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Worker limit reached');
  });

  it('returns CollaborationError for a persona not in the allowed list', () => {
    const result = supervisor.spawnWorker(
      sessionId,
      makeWorkerConfig({ personaName: 'rogue-persona' }),
      supervisorConfig,
    );

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('not in the allowed worker list');
  });

  it('returns CollaborationError when repository insert fails', () => {
    vi.mocked(repo.insert).mockReturnValueOnce(
      err(new DbError('insert failed')),
    );

    const result = supervisor.spawnWorker(sessionId, makeWorkerConfig(), supervisorConfig);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Failed to create child run record');
  });

  it('returns CollaborationError when spawning on a completed session', () => {
    const cfg = makeDefaultSupervisorConfig({ maxWorkers: 1 });
    const s = supervisor.createSession(uuid(), cfg)._unsafeUnwrap();
    // Force session to completed without workers.
    supervisor.completeSession(s.id);

    const result = supervisor.spawnWorker(s.id, makeWorkerConfig(), cfg);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('completed session');
  });
});

// ---------------------------------------------------------------------------
// completeWorker
// ---------------------------------------------------------------------------

describe('Supervisor.completeWorker', () => {
  let repo: RunRepository;
  let supervisor: Supervisor;
  let sessionId: string;
  let workerId: string;

  beforeEach(() => {
    repo = makeMockRepo();
    supervisor = new Supervisor(repo, silentLogger());
    const cfg = makeDefaultSupervisorConfig();
    const session = supervisor.createSession(uuid(), cfg)._unsafeUnwrap();
    sessionId = session.id;
    const worker = supervisor.spawnWorker(sessionId, makeWorkerConfig(), cfg)._unsafeUnwrap();
    workerId = worker.id;
  });

  it('marks the worker as completed on success', () => {
    const result: WorkerResult = {
      workerId,
      success: true,
      output: 'done',
      error: null,
    };

    supervisor.completeWorker(sessionId, workerId, result);

    const session = supervisor.getSession(sessionId)!;
    const worker = session.workers.find((w) => w.id === workerId)!;
    expect(worker.status).toBe('completed');
    expect(worker.result).toBe('done');
    expect(worker.error).toBeNull();
    expect(worker.endedAt).not.toBeNull();
  });

  it('marks the worker as failed on failure', () => {
    const result: WorkerResult = {
      workerId,
      success: false,
      output: null,
      error: 'something went wrong',
    };

    supervisor.completeWorker(sessionId, workerId, result);

    const session = supervisor.getSession(sessionId)!;
    const worker = session.workers.find((w) => w.id === workerId)!;
    expect(worker.status).toBe('failed');
    expect(worker.error).toBe('something went wrong');
  });

  it('calls runRepo.updateStatus with the correct terminal status', () => {
    supervisor.completeWorker(sessionId, workerId, {
      workerId,
      success: true,
      output: null,
      error: null,
    });

    expect(repo.updateStatus).toHaveBeenCalledWith(
      workerId,
      'completed',
      expect.objectContaining({ ended_at: expect.any(Number) }),
    );
  });

  it('returns CollaborationError for unknown session', () => {
    const result = supervisor.completeWorker(uuid(), workerId, {
      workerId,
      success: true,
      output: null,
      error: null,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Session not found');
  });

  it('returns CollaborationError for unknown worker', () => {
    const result = supervisor.completeWorker(sessionId, uuid(), {
      workerId: 'fake',
      success: true,
      output: null,
      error: null,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Worker not found');
  });

  it('returns CollaborationError when updateStatus fails', () => {
    vi.mocked(repo.updateStatus).mockReturnValueOnce(
      err(new DbError('update failed')),
    );

    const result = supervisor.completeWorker(sessionId, workerId, {
      workerId,
      success: true,
      output: null,
      error: null,
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Failed to update worker run status');
  });
});

// ---------------------------------------------------------------------------
// completeSession
// ---------------------------------------------------------------------------

describe('Supervisor.completeSession', () => {
  let repo: RunRepository;
  let supervisor: Supervisor;

  beforeEach(() => {
    repo = makeMockRepo();
    supervisor = new Supervisor(repo, silentLogger());
  });

  it('marks session as completed when all workers succeeded', () => {
    const cfg = makeDefaultSupervisorConfig();
    const session = supervisor.createSession(uuid(), cfg)._unsafeUnwrap();

    const w = supervisor.spawnWorker(session.id, makeWorkerConfig(), cfg)._unsafeUnwrap();
    supervisor.completeWorker(session.id, w.id, {
      workerId: w.id,
      success: true,
      output: 'ok',
      error: null,
    });

    const result = supervisor.completeSession(session.id);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().status).toBe('completed');
  });

  it('marks session as failed when any worker failed', () => {
    const cfg = makeDefaultSupervisorConfig();
    const session = supervisor.createSession(uuid(), cfg)._unsafeUnwrap();

    const w = supervisor.spawnWorker(session.id, makeWorkerConfig(), cfg)._unsafeUnwrap();
    supervisor.completeWorker(session.id, w.id, {
      workerId: w.id,
      success: false,
      output: null,
      error: 'oops',
    });

    const result = supervisor.completeSession(session.id);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().status).toBe('failed');
  });

  it('marks session as completed with no workers', () => {
    const session = supervisor
      .createSession(uuid(), makeDefaultSupervisorConfig())
      ._unsafeUnwrap();

    const result = supervisor.completeSession(session.id);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().status).toBe('completed');
  });

  it('returns CollaborationError for unknown session', () => {
    const result = supervisor.completeSession(uuid());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('COLLABORATION_ERROR');
  });

  it('returns CollaborationError when workers are still active', () => {
    const cfg = makeDefaultSupervisorConfig();
    const session = supervisor.createSession(uuid(), cfg)._unsafeUnwrap();

    supervisor.spawnWorker(session.id, makeWorkerConfig(), cfg);

    const result = supervisor.completeSession(session.id);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('active worker');
  });

  it('returns the final session state', () => {
    const cfg = makeDefaultSupervisorConfig();
    const session = supervisor.createSession(uuid(), cfg)._unsafeUnwrap();

    const finalSession = supervisor.completeSession(session.id)._unsafeUnwrap();

    expect(finalSession.id).toBe(session.id);
    expect(finalSession.supervisorRunId).toBe(session.supervisorRunId);
  });
});

// ---------------------------------------------------------------------------
// getSession
// ---------------------------------------------------------------------------

describe('Supervisor.getSession', () => {
  it('returns undefined for an unknown session', () => {
    const supervisor = new Supervisor(makeMockRepo(), silentLogger());
    expect(supervisor.getSession(uuid())).toBeUndefined();
  });

  it('returns the session object after creation', () => {
    const supervisor = new Supervisor(makeMockRepo(), silentLogger());
    const session = supervisor
      .createSession(uuid(), makeDefaultSupervisorConfig())
      ._unsafeUnwrap();

    expect(supervisor.getSession(session.id)).toStrictEqual(session);
  });
});
