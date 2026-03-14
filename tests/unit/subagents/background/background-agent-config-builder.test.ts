import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { BackgroundAgentConfigBuilder } from '../../../../src/subagents/background/background-agent-config-builder.js';

describe('BackgroundAgentConfigBuilder', () => {
  const builder = new BackgroundAgentConfigBuilder();
  const cleanupPaths: string[] = [];

  afterEach(() => {
    for (const path of cleanupPaths) {
      if (existsSync(path)) {
        rmSync(path, { recursive: true, force: true });
      }
    }
    cleanupPaths.length = 0;
  });

  it('builds a system prompt with persona, task, and thread context', () => {
    const prompt = builder.buildSystemPrompt({
      personaPrompt: 'You are a helpful coding assistant.',
      taskPrompt: 'Refactor the auth module.',
      taskId: 'task-1',
      threadId: 'thread-1',
      channelName: 'telegram-main',
      threadContext: 'Prior summary: user wants a safe refactor.',
    });

    expect(prompt).toContain('You are a helpful coding assistant.');
    expect(prompt).toContain('Refactor the auth module.');
    expect(prompt).toContain('task-1');
    expect(prompt).toContain('telegram-main');
    expect(prompt).toContain('Prior summary');
    expect(prompt.toLowerCase()).toContain('autonomous');
  });

  it('writes MCP config and system prompt files', () => {
    const result = builder.writeSpawnFiles(
      {
        perplexity: {
          type: 'stdio',
          command: 'npx',
          args: ['perplexity-mcp'],
          env: { API_KEY: 'secret' },
        },
      },
      'You are a helpful assistant.',
    );

    expect(result.isOk()).toBe(true);
    const { configPath, promptPath } = result._unsafeUnwrap();
    cleanupPaths.push(configPath);

    const mcpContents = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(mcpContents).toEqual({
      mcpServers: {
        perplexity: {
          type: 'stdio',
          command: 'npx',
          args: ['perplexity-mcp'],
          env: { API_KEY: 'secret' },
        },
      },
    });

    const promptContents = readFileSync(promptPath, 'utf8');
    expect(promptContents).toBe('You are a helpful assistant.');
  });

  it('creates temp files with restrictive permissions', () => {
    const { configPath, promptPath } = builder.writeSpawnFiles({}, 'test')._unsafeUnwrap();
    cleanupPaths.push(configPath);

    const dirStats = statSync(dirname(configPath));
    const configStats = statSync(configPath);
    const promptStats = statSync(promptPath);
    // Owner-only permissions (0o700 for dir, 0o600 for files)
    expect(dirStats.mode & 0o777).toBe(0o700);
    expect(configStats.mode & 0o777).toBe(0o600);
    expect(promptStats.mode & 0o777).toBe(0o600);
  });

  it('removes the temp directory on cleanup', () => {
    const { configPath } = builder.writeSpawnFiles({}, 'test')._unsafeUnwrap();
    expect(existsSync(configPath)).toBe(true);

    builder.cleanup(configPath);
    expect(existsSync(configPath)).toBe(false);
  });
});
