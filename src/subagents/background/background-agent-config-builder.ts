import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { err, ok, type Result } from 'neverthrow';
import { BackgroundAgentError } from '../../core/errors/error-types.js';

interface BuildSystemPromptOptions {
  personaPrompt: string;
  taskPrompt: string;
  taskId: string;
  threadId: string;
  channelName: string;
  threadContext?: string;
}

export class BackgroundAgentConfigBuilder {
  buildSystemPrompt(options: BuildSystemPromptOptions): string {
    return [
      options.personaPrompt,
      '## Background Task Context',
      `Task ID: ${options.taskId}`,
      `Thread ID: ${options.threadId}`,
      `Channel: ${options.channelName}`,
      options.threadContext ? `Thread summary:\n${options.threadContext}` : '',
      '## Background Task Instructions',
      'You are running as an autonomous background agent.',
      'No human is watching this session, so make reasonable decisions and continue.',
      'Finish the task and leave a concise final summary of what you changed or learned.',
      '## Task',
      options.taskPrompt,
    ]
      .filter(Boolean)
      .join('\n\n');
  }

  writeMcpConfig(mcpServers: Record<string, unknown>): Result<string, BackgroundAgentError> {
    try {
      const dir = join(tmpdir(), `talon-background-agent-${randomUUID()}`);
      mkdirSync(dir, { recursive: true });
      const configPath = join(dir, 'mcp-config.json');
      writeFileSync(configPath, JSON.stringify({ mcpServers }, null, 2), 'utf8');
      return ok(configPath);
    } catch (cause) {
      return err(
        new BackgroundAgentError(
          `Failed to write MCP config: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  cleanup(configPath: string): void {
    rmSync(dirname(configPath), { recursive: true, force: true });
  }
}
