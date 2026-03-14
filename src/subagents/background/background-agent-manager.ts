import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import type pino from 'pino';
import { BackgroundAgentError } from '../../core/errors/error-types.js';
import type { QueueManager } from '../../queue/queue-manager.js';
import type { BackgroundTask, BackgroundTaskResult } from './background-agent-types.js';
import { BackgroundAgentProcess, type BackgroundAgentProcessOptions } from './background-agent-process.js';
import { BackgroundAgentConfigBuilder } from './background-agent-config-builder.js';
import type { BackgroundTaskRepository } from '../../core/database/repositories/background-task-repository.js';

export interface SpawnBackgroundAgentInput {
  prompt: string;
  personaPrompt: string;
  threadContext?: string;
  mcpServers: Record<string, unknown>;
  personaId: string;
  threadId: string;
  channelId: string;
  channelName: string;
  workingDirectory?: string;
  timeoutMinutes?: number;
}

interface BackgroundAgentManagerDeps {
  repository: BackgroundTaskRepository;
  queueManager: QueueManager;
  maxConcurrent: number;
  defaultTimeoutMinutes: number;
  claudePath: string;
  logger: pino.Logger;
  configBuilder?: BackgroundAgentConfigBuilder;
  processFactory?: (options: BackgroundAgentProcessOptions) => BackgroundAgentProcess;
  isPidAlive?: (pid: number) => boolean;
  readProcessCommandLine?: (pid: number) => string | null;
}

interface ManagedProcess {
  kill: () => void;
  configPath: string;
}

const MAX_STORED_OUTPUT = 100 * 1024;

export class BackgroundAgentManager {
  private readonly configBuilder: BackgroundAgentConfigBuilder;
  private readonly processFactory: (options: BackgroundAgentProcessOptions) => BackgroundAgentProcess;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly readProcessCommandLine: (pid: number) => string | null;
  private readonly processes = new Map<string, ManagedProcess>();

  constructor(private readonly deps: BackgroundAgentManagerDeps) {
    this.configBuilder = deps.configBuilder ?? new BackgroundAgentConfigBuilder();
    this.processFactory = deps.processFactory ?? ((options) => new BackgroundAgentProcess(options));
    this.isPidAlive = deps.isPidAlive ?? ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    this.readProcessCommandLine = deps.readProcessCommandLine ?? ((pid) => {
      try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      } catch {
        return null;
      }
    });
  }

  spawn(input: SpawnBackgroundAgentInput): Result<string, BackgroundAgentError> {
    const countResult = this.deps.repository.countActive();
    if (countResult.isErr()) {
      return err(new BackgroundAgentError(countResult.error.message, countResult.error));
    }
    if (countResult.value >= this.deps.maxConcurrent) {
      return err(
        new BackgroundAgentError(
          `Background agent concurrency limit reached (${this.deps.maxConcurrent})`,
        ),
      );
    }

    const configResult = this.configBuilder.writeMcpConfig(input.mcpServers);
    if (configResult.isErr()) {
      return err(configResult.error);
    }

    const taskId = randomUUID();
    const timeoutMinutes = input.timeoutMinutes ?? this.deps.defaultTimeoutMinutes;
    const configPath = configResult.value;
    const systemPrompt = this.configBuilder.buildSystemPrompt({
      personaPrompt: input.personaPrompt,
      taskPrompt: input.prompt,
      taskId,
      threadId: input.threadId,
      channelName: input.channelName,
      threadContext: input.threadContext,
    });

    const createResult = this.deps.repository.create({
      id: taskId,
      personaId: input.personaId,
      threadId: input.threadId,
      channelId: input.channelId,
      prompt: input.prompt,
      workingDirectory: input.workingDirectory ?? null,
      status: 'running',
      output: null,
      error: null,
      pid: null,
      timeoutMinutes,
    });

    if (createResult.isErr()) {
      this.configBuilder.cleanup(configPath);
      return err(new BackgroundAgentError(createResult.error.message, createResult.error));
    }

    const processInstance = this.processFactory({
      command: this.deps.claudePath,
      args: [
        '--print',
        '--output-format',
        'json',
        '--append-system-prompt',
        systemPrompt,
        '--mcp-config',
        configPath,
        '--strict-mcp-config',
        '--dangerously-skip-permissions',
        '--no-session-persistence',
      ],
      cwd: input.workingDirectory ?? process.cwd(),
      stdin: input.prompt,
      timeoutMs: timeoutMinutes * 60 * 1000,
    });

    const startResult = processInstance.start();
    if (startResult.isErr()) {
      this.deps.repository.updateStatus(taskId, 'failed', undefined, startResult.error.message);
      this.configBuilder.cleanup(configPath);
      return err(startResult.error);
    }

    const { pid, completion } = startResult.value;
    if (pid !== null) {
      this.deps.repository.updatePid(taskId, pid);
    }

    this.processes.set(taskId, {
      kill: () => processInstance.kill(),
      configPath,
    });

    void completion.then((result) => {
      this.handleCompletion(taskId, result);
    });

    return ok(taskId);
  }

  getTask(taskId: string): Result<BackgroundTask | null, BackgroundAgentError> {
    const result = this.deps.repository.findById(taskId);
    return result.isOk()
      ? ok(result.value)
      : err(new BackgroundAgentError(result.error.message, result.error));
  }

  listTasksForThread(threadId: string, limit = 10): Result<BackgroundTask[], BackgroundAgentError> {
    const result = this.deps.repository.findByThread(threadId, limit);
    return result.isOk()
      ? ok(result.value)
      : err(new BackgroundAgentError(result.error.message, result.error));
  }

  getResult(taskId: string): Result<BackgroundTaskResult | null, BackgroundAgentError> {
    const taskResult = this.getTask(taskId);
    if (taskResult.isErr()) {
      return err(taskResult.error);
    }

    const task = taskResult.value;
    if (!task) {
      return ok(null);
    }

    const durationSeconds =
      task.completedAt && task.startedAt ? Math.max(0, Math.round((task.completedAt - task.startedAt) / 1000)) : 0;

    return ok({
      taskId: task.id,
      status: task.status,
      output: task.output,
      error: task.error,
      durationSeconds,
    });
  }

  cancel(taskId: string): Result<boolean, BackgroundAgentError> {
    const taskResult = this.deps.repository.findById(taskId);
    if (taskResult.isErr()) {
      return err(new BackgroundAgentError(taskResult.error.message, taskResult.error));
    }
    if (!taskResult.value || taskResult.value.status !== 'running') {
      return ok(false);
    }

    const managedProcess = this.processes.get(taskId);
    managedProcess?.kill();
    if (managedProcess) {
      this.configBuilder.cleanup(managedProcess.configPath);
      this.processes.delete(taskId);
    }
    const updateResult = this.deps.repository.updateStatus(
      taskId,
      'cancelled',
      undefined,
      'Cancelled by user',
    );

    return updateResult.isOk()
      ? ok(true)
      : err(new BackgroundAgentError(updateResult.error.message, updateResult.error));
  }

  recoverOrphanedTasks(): void {
    const result = this.deps.repository.findActive();
    if (result.isErr()) {
      this.deps.logger.error({ err: result.error }, 'background-agent: failed to load active tasks');
      return;
    }

    for (const task of result.value) {
      if (!task.pid) {
        this.deps.repository.updateStatus(task.id, 'failed', undefined, 'daemon restarted during execution');
        continue;
      }

      if (!this.isPidAlive(task.pid)) {
        this.deps.repository.updateStatus(task.id, 'failed', undefined, 'daemon restarted during execution');
        continue;
      }

      const commandLine = this.readProcessCommandLine(task.pid);
      if (!commandLine || !commandLine.includes('claude')) {
        this.deps.repository.updateStatus(task.id, 'failed', undefined, 'daemon restarted during execution (pid reused)');
        continue;
      }

      this.deps.repository.updateStatus(
        task.id,
        'failed',
        undefined,
        'daemon restarted during execution (cannot reattach)',
      );
    }
  }

  shutdown(): void {
    for (const [taskId, process] of this.processes) {
      process.kill();
      this.deps.repository.updateStatus(taskId, 'cancelled', undefined, 'Daemon shutting down');
      this.configBuilder.cleanup(process.configPath);
    }
    this.processes.clear();
  }

  private handleCompletion(taskId: string, result: Result<unknown, BackgroundAgentError>): void {
    const currentTaskResult = this.deps.repository.findById(taskId);
    if (currentTaskResult.isErr() || !currentTaskResult.value) {
      this.cleanupTask(taskId);
      return;
    }

    if (currentTaskResult.value.status === 'cancelled') {
      this.cleanupTask(taskId);
      return;
    }

    if (result.isErr()) {
      this.deps.repository.updateStatus(taskId, 'failed', undefined, this.truncate(result.error.message));
      this.enqueueNotification(taskId);
      this.cleanupTask(taskId);
      return;
    }

    const processResult = result.value as {
      stdout: string;
      stderr: string;
      exitCode: number | null;
      timedOut: boolean;
    };

    if (processResult.timedOut) {
      this.deps.repository.updateStatus(
        taskId,
        'timed_out',
        this.truncate(processResult.stdout),
        'Process timed out',
      );
    } else if (processResult.exitCode === 0) {
      this.deps.repository.updateStatus(taskId, 'completed', this.truncate(processResult.stdout));
    } else {
      this.deps.repository.updateStatus(
        taskId,
        'failed',
        this.truncate(processResult.stdout),
        this.truncate(processResult.stderr || `Process exited with code ${processResult.exitCode}`),
      );
    }

    this.enqueueNotification(taskId);
    this.cleanupTask(taskId);
  }

  private enqueueNotification(taskId: string): void {
    const taskResult = this.deps.repository.findById(taskId);
    if (taskResult.isErr() || !taskResult.value) {
      return;
    }

    const task = taskResult.value;
    const title = this.notificationTitle(task.status);
    const preview = task.prompt.length > 80 ? `${task.prompt.slice(0, 77)}...` : task.prompt;
    const summary = this.notificationSummary(task).slice(0, 500);
    const durationSeconds =
      task.completedAt && task.startedAt ? Math.max(0, Math.round((task.completedAt - task.startedAt) / 1000)) : 0;

    const content = [
      `[Background Task ${title}] Task ${task.id}: "${preview}"`,
      `Status: ${task.status}`,
      `Output summary: ${summary}`,
      `Working directory: ${task.workingDirectory ?? 'n/a'}`,
      `Duration: ${durationSeconds}s`,
    ].join('\n');

    this.deps.queueManager.enqueue(task.threadId, 'message', {
      personaId: task.personaId,
      content,
    });
  }

  private cleanupTask(taskId: string): void {
    const managedProcess = this.processes.get(taskId);
    if (managedProcess) {
      this.configBuilder.cleanup(managedProcess.configPath);
      this.processes.delete(taskId);
    }
  }

  private truncate(value?: string): string | undefined {
    return value === undefined ? undefined : value.slice(0, MAX_STORED_OUTPUT);
  }

  private notificationTitle(status: BackgroundTask['status']): string {
    switch (status) {
      case 'completed':
        return 'Complete';
      case 'timed_out':
        return 'Timed Out';
      case 'cancelled':
        return 'Cancelled';
      default:
        return 'Failed';
    }
  }

  private notificationSummary(task: BackgroundTask): string {
    if (task.status === 'completed') {
      return task.output ?? 'No output';
    }

    return task.error ?? task.output ?? 'No output';
  }
}
