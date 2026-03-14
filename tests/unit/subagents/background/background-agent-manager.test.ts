import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { ok, err } from 'neverthrow';
import type { QueueManager } from '../../../../src/queue/queue-manager.js';
import { BackgroundTaskRepository } from '../../../../src/core/database/repositories/background-task-repository.js';
import { BackgroundAgentManager } from '../../../../src/subagents/background/background-agent-manager.js';
import { BackgroundAgentError } from '../../../../src/core/errors/error-types.js';

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE background_tasks (
      id              TEXT PRIMARY KEY,
      persona_id      TEXT NOT NULL,
      thread_id       TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      working_dir     TEXT,
      status          TEXT NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed', 'timed_out', 'cancelled')),
      output          TEXT,
      error           TEXT,
      pid             INTEGER,
      created_at      INTEGER NOT NULL,
      started_at      INTEGER NOT NULL,
      completed_at    INTEGER,
      timeout_minutes INTEGER NOT NULL DEFAULT 30
    );
    CREATE INDEX idx_background_tasks_status ON background_tasks(status);
    CREATE INDEX idx_background_tasks_thread_created ON background_tasks(thread_id, created_at DESC);
  `);
  return db;
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

describe('BackgroundAgentManager', () => {
  let db: Database.Database;
  let repository: BackgroundTaskRepository;
  let queueManager: QueueManager;
  let writeMcpConfig: ReturnType<typeof vi.fn>;
  let cleanup: ReturnType<typeof vi.fn>;
  let processStart: ReturnType<typeof vi.fn>;
  let processKill: ReturnType<typeof vi.fn>;
  let completionResolve: ((value: unknown) => void) | null;

  beforeEach(() => {
    db = createTestDb();
    repository = new BackgroundTaskRepository(db);
    queueManager = {
      enqueue: vi.fn().mockReturnValue(ok({ id: 'queue-1' })),
    } as unknown as QueueManager;

    writeMcpConfig = vi.fn().mockReturnValue(ok('/tmp/bg/mcp-config.json'));
    cleanup = vi.fn();
    completionResolve = null;
    processKill = vi.fn();
    processStart = vi.fn().mockImplementation(() =>
      ok({
        pid: 4242,
        completion: new Promise((resolve) => {
          completionResolve = resolve;
        }),
      }),
    );
  });

  function createManager() {
    return new BackgroundAgentManager({
      repository,
      queueManager,
      maxConcurrent: 2,
      defaultTimeoutMinutes: 30,
      claudePath: 'claude',
      logger: makeLogger(),
      configBuilder: {
        writeMcpConfig,
        cleanup,
      } as any,
      processFactory: vi.fn().mockImplementation(() => ({
        start: processStart,
        kill: processKill,
      })),
      isPidAlive: vi.fn().mockReturnValue(false),
      readProcessCommandLine: vi.fn().mockReturnValue('claude --print'),
    });
  }

  const spawnInput = {
    prompt: 'Refactor the auth module',
    systemPrompt: 'You are helpful.',
    mcpServers: {},
    personaId: 'persona-1',
    threadId: 'thread-1',
    channelId: 'channel-1',
    channelName: 'telegram-main',
    workingDirectory: '/workspace/repo',
    timeoutMinutes: 30,
  };

  it('creates a running task and returns its id', () => {
    const manager = createManager();
    const result = manager.spawn(spawnInput);
    expect(result.isOk()).toBe(true);

    const taskId = result._unsafeUnwrap();
    const task = repository.findById(taskId)._unsafeUnwrap();
    expect(task?.status).toBe('running');
    expect(task?.pid).toBe(4242);
  });

  it('rejects spawn when concurrency limit is reached', () => {
    repository.create({
      id: 'existing-1',
      personaId: 'persona-1',
      threadId: 'thread-1',
      channelId: 'channel-1',
      prompt: 'one',
      workingDirectory: null,
      status: 'running',
      output: null,
      error: null,
      pid: 1111,
      timeoutMinutes: 30,
    });
    repository.create({
      id: 'existing-2',
      personaId: 'persona-1',
      threadId: 'thread-1',
      channelId: 'channel-1',
      prompt: 'two',
      workingDirectory: null,
      status: 'running',
      output: null,
      error: null,
      pid: 2222,
      timeoutMinutes: 30,
    });

    const manager = createManager();
    const result = manager.spawn(spawnInput);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('concurrency');
  });

  it('marks the task failed when process start fails', () => {
    processStart.mockReturnValueOnce(err(new BackgroundAgentError('spawn failed')));
    const manager = createManager();

    const result = manager.spawn(spawnInput);
    expect(result.isErr()).toBe(true);

    const tasks = repository.findByThread('thread-1')._unsafeUnwrap();
    expect(tasks[0]?.status).toBe('failed');
    expect(tasks[0]?.error).toContain('spawn failed');
    expect(cleanup).toHaveBeenCalled();
  });

  it('marks the task completed and enqueues a notification when the process resolves', async () => {
    const manager = createManager();
    const taskId = manager.spawn(spawnInput)._unsafeUnwrap();

    completionResolve?.(
      ok({
        stdout: 'Done!',
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    const task = repository.findById(taskId)._unsafeUnwrap();
    expect(task?.status).toBe('completed');
    expect(task?.output).toBe('Done!');
    expect((queueManager.enqueue as any)).toHaveBeenCalledWith(
      'thread-1',
      'message',
      expect.objectContaining({
        personaId: 'persona-1',
        content: expect.stringContaining('Background Task Complete'),
      }),
    );
  });

  it('cancels a running task and kills the in-memory process', () => {
    const manager = createManager();
    const taskId = manager.spawn(spawnInput)._unsafeUnwrap();

    const result = manager.cancel(taskId);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(true);
    expect(processKill).toHaveBeenCalled();
    expect(repository.findById(taskId)._unsafeUnwrap()?.status).toBe('cancelled');
  });

  it('marks orphaned running tasks as failed when their pid is dead', () => {
    repository.create({
      id: 'orphan-1',
      personaId: 'persona-1',
      threadId: 'thread-1',
      channelId: 'channel-1',
      prompt: 'orphan',
      workingDirectory: null,
      status: 'running',
      output: null,
      error: null,
      pid: 999999,
      timeoutMinutes: 30,
    });

    const manager = createManager();
    manager.recoverOrphanedTasks();

    expect(repository.findById('orphan-1')._unsafeUnwrap()?.status).toBe('failed');
  });

  it('kills active processes during shutdown', () => {
    const manager = createManager();
    const taskId = manager.spawn(spawnInput)._unsafeUnwrap();

    manager.shutdown();

    expect(processKill).toHaveBeenCalled();
    expect(repository.findById(taskId)._unsafeUnwrap()?.status).toBe('cancelled');
  });
});
