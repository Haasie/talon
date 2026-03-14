import { describe, expect, it, vi } from 'vitest';
import { ok } from 'neverthrow';
import { BackgroundAgentHandler } from '../../../src/tools/host-tools/background-agent.js';
import type { BackgroundTask, BackgroundTaskResult } from '../../../src/subagents/background/background-agent-types.js';

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any;
}

function makeTask(overrides: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: 'task-1',
    personaId: 'persona-1',
    threadId: 'thread-1',
    channelId: 'channel-1',
    prompt: 'Refactor the auth module',
    workingDirectory: '/workspace/repo',
    status: 'running',
    output: null,
    error: null,
    pid: 4242,
    createdAt: 1_000,
    startedAt: 1_000,
    completedAt: null,
    timeoutMinutes: 30,
    ...overrides,
  };
}

function makeResult(overrides: Partial<BackgroundTaskResult> = {}): BackgroundTaskResult {
  return {
    taskId: 'task-1',
    status: 'completed',
    output: 'Done!',
    error: null,
    durationSeconds: 12,
    ...overrides,
  };
}

function createHandler() {
  const backgroundAgentManager = {
    spawn: vi.fn().mockReturnValue(ok('task-1')),
    listTasksForThread: vi.fn().mockReturnValue(ok([makeTask()])),
    getTask: vi.fn().mockReturnValue(ok(makeTask())),
    cancel: vi.fn().mockReturnValue(ok(true)),
    getResult: vi.fn().mockReturnValue(ok(makeResult())),
  };

  const handler = new BackgroundAgentHandler({
    backgroundAgentManager: backgroundAgentManager as any,
    personaRepository: {
      findById: vi.fn().mockReturnValue(ok({ id: 'persona-1', name: 'TestBot' })),
    } as any,
    personaLoader: {
      getByName: vi.fn().mockReturnValue(
        ok({
          config: { skills: ['search-skill'] },
          systemPromptContent: 'Base system prompt.',
          personalityContent: 'Friendly personality.',
          resolvedCapabilities: { allow: ['subagent.background'], requireApproval: [] },
        }),
      ),
    } as any,
    threadRepository: {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'thread-1',
          channel_id: 'channel-1',
          external_id: 'telegram-thread-1',
        }),
      ),
    } as any,
    channelRepository: {
      findById: vi.fn().mockReturnValue(
        ok({
          id: 'channel-1',
          name: 'telegram-main',
        }),
      ),
    } as any,
    skillResolver: {
      mergePromptFragments: vi.fn().mockReturnValue('Skill instructions.'),
      collectMcpServers: vi.fn().mockReturnValue([
        {
          name: 'perplexity',
          config: {
            transport: 'stdio',
            command: 'npx',
            args: ['perplexity-mcp'],
            env: {
              API_KEY: '${PERPLEXITY_API_KEY}',
            },
          },
        },
      ]),
    } as any,
    contextAssembler: {
      assemble: vi.fn().mockReturnValue('Previous thread summary.'),
    } as any,
    loadedSkills: [
      {
        manifest: { name: 'search-skill' },
        resolvedMcpServers: [],
      },
    ] as any,
    logger: makeLogger(),
  });

  return { handler, backgroundAgentManager };
}

describe('BackgroundAgentHandler', () => {
  it('has the correct manifest', () => {
    expect(BackgroundAgentHandler.manifest.name).toBe('subagent.background');
    expect(BackgroundAgentHandler.manifest.capabilities).toContain('subagent.background');
    expect(BackgroundAgentHandler.manifest.executionLocation).toBe('host');
  });

  it('spawns a background task using current persona and thread context', async () => {
    process.env.PERPLEXITY_API_KEY = 'secret';
    const { handler, backgroundAgentManager } = createHandler();

    const result = await handler.execute(
      {
        action: 'spawn',
        prompt: 'Refactor the auth module',
        workingDirectory: '/workspace/repo',
        timeoutMinutes: 45,
      },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ taskId: 'task-1' });
    expect(backgroundAgentManager.spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: 'Refactor the auth module',
        personaId: 'persona-1',
        threadId: 'thread-1',
        channelId: 'channel-1',
        channelName: 'telegram-main',
        workingDirectory: '/workspace/repo',
        timeoutMinutes: 45,
        mcpServers: {
          perplexity: {
            type: 'stdio',
            command: 'npx',
            args: ['perplexity-mcp'],
            env: { API_KEY: 'secret' },
          },
        },
        systemPrompt: expect.stringContaining('Base system prompt.'),
      }),
    );
    expect(backgroundAgentManager.spawn.mock.calls[0][0].systemPrompt).toContain(
      'Friendly personality.',
    );
    expect(backgroundAgentManager.spawn.mock.calls[0][0].systemPrompt).toContain(
      'Skill instructions.',
    );
    expect(backgroundAgentManager.spawn.mock.calls[0][0].systemPrompt).toContain(
      'Previous thread summary.',
    );
  });

  it('returns current-thread history when status is called without taskId', async () => {
    const { handler, backgroundAgentManager } = createHandler();

    const result = await handler.execute(
      { action: 'status' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ tasks: [makeTask()] });
    expect(backgroundAgentManager.listTasksForThread).toHaveBeenCalledWith('thread-1');
  });

  it('rejects status for a task owned by another thread', async () => {
    const { handler, backgroundAgentManager } = createHandler();
    backgroundAgentManager.getTask.mockReturnValueOnce(ok(makeTask({ threadId: 'thread-2' })));

    const result = await handler.execute(
      { action: 'status', taskId: 'task-1' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('does not belong to the current thread');
  });

  it('rejects cancel for a task owned by another thread', async () => {
    const { handler, backgroundAgentManager } = createHandler();
    backgroundAgentManager.getTask.mockReturnValueOnce(ok(makeTask({ threadId: 'thread-2' })));

    const result = await handler.execute(
      { action: 'cancel', taskId: 'task-1' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('does not belong to the current thread');
    expect(backgroundAgentManager.cancel).not.toHaveBeenCalled();
  });

  it('rejects result for a task owned by another thread', async () => {
    const { handler, backgroundAgentManager } = createHandler();
    backgroundAgentManager.getTask.mockReturnValueOnce(ok(makeTask({ threadId: 'thread-2' })));

    const result = await handler.execute(
      { action: 'result', taskId: 'task-1' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('does not belong to the current thread');
    expect(backgroundAgentManager.getResult).not.toHaveBeenCalled();
  });

  it('returns validation errors for missing required fields', async () => {
    const { handler } = createHandler();

    const spawnResult = await handler.execute(
      { action: 'spawn' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );
    expect(spawnResult.status).toBe('error');
    expect(spawnResult.error).toContain('prompt');

    const cancelResult = await handler.execute(
      { action: 'cancel' },
      {
        runId: 'run-1',
        threadId: 'thread-1',
        personaId: 'persona-1',
        requestId: 'req-1',
      },
    );
    expect(cancelResult.status).toBe('error');
    expect(cancelResult.error).toContain('taskId');
  });
});
