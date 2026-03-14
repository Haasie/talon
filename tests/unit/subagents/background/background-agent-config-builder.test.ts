import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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

  it('writes an MCP config file for the provided server map', () => {
    const result = builder.writeMcpConfig({
      perplexity: {
        type: 'stdio',
        command: 'npx',
        args: ['perplexity-mcp'],
        env: { API_KEY: 'secret' },
      },
    });

    expect(result.isOk()).toBe(true);
    const configPath = result._unsafeUnwrap();
    cleanupPaths.push(configPath);

    const contents = JSON.parse(readFileSync(configPath, 'utf8'));
    expect(contents).toEqual({
      mcpServers: {
        perplexity: {
          type: 'stdio',
          command: 'npx',
          args: ['perplexity-mcp'],
          env: { API_KEY: 'secret' },
        },
      },
    });
  });

  it('removes the temp config directory on cleanup', () => {
    const configPath = builder.writeMcpConfig({})._unsafeUnwrap();
    expect(existsSync(configPath)).toBe(true);

    builder.cleanup(configPath);
    expect(existsSync(configPath)).toBe(false);
  });
});
