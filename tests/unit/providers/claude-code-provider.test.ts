import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { ClaudeCodeProvider } from '../../../src/providers/claude-code-provider.js';

describe('ClaudeCodeProvider', () => {
  const cleanupPaths: string[] = [];
  const provider = new ClaudeCodeProvider({
    enabled: true,
    command: 'claude',
    contextWindowTokens: 200000,
    rotationThreshold: 0.4,
  });

  afterEach(() => {
    for (const path of cleanupPaths) {
      rmSync(path, { recursive: true, force: true });
    }
    cleanupPaths.length = 0;
  });

  it('prepares background CLI invocations with provider-native config files', () => {
    const result = provider.prepareBackgroundInvocation({
      prompt: 'Refactor the auth module.',
      systemPrompt: 'You are a helpful assistant.',
      mcpServers: {
        hostTools: {
          transport: 'stdio',
          command: 'node',
          args: ['dist/tools/host-tools-mcp-server.js'],
          env: { TALOND_SOCKET: '/tmp/talond.sock' },
        },
        remoteBrowser: {
          transport: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer token' },
        },
      },
      cwd: '/tmp',
      timeoutMs: 60_000,
    });

    expect(result.isOk()).toBe(true);
    const invocation = result._unsafeUnwrap();
    cleanupPaths.push(...invocation.cleanupPaths);

    expect(invocation.command).toBe('claude');
    expect(invocation.stdin).toBe('Refactor the auth module.');
    expect(invocation.cwd).toBe('/tmp');
    expect(invocation.args).toContain('--append-system-prompt');
    expect(invocation.args).toContain('You are a helpful assistant.');
    expect(invocation.args).toContain('--mcp-config');

    const configPath = invocation.args[invocation.args.indexOf('--mcp-config') + 1];
    expect(existsSync(configPath)).toBe(true);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: {
        hostTools: {
          type: 'stdio',
          command: 'node',
          args: ['dist/tools/host-tools-mcp-server.js'],
          env: { TALOND_SOCKET: '/tmp/talond.sock' },
        },
        remoteBrowser: {
          type: 'http',
          url: 'https://mcp.example.test',
          headers: { Authorization: 'Bearer token' },
        },
      },
    });
  });

  it('parses Claude JSON output into normalized usage and text', () => {
    const result = provider.parseBackgroundResult({
      stdout: JSON.stringify({
        result: 'Finished successfully.',
        total_cost_usd: 0.002,
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          cache_read_input_tokens: 40,
          cache_creation_input_tokens: 10,
        },
      }),
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    expect(result).toEqual({
      output: 'Finished successfully.',
      stderr: '',
      exitCode: 0,
      timedOut: false,
      usage: {
        inputTokens: 100,
        outputTokens: 25,
        cacheReadTokens: 40,
        cacheWriteTokens: 10,
        totalCostUsd: 0.002,
      },
    });
  });

  it('falls back to raw stdout when the provider output is not JSON', () => {
    const result = provider.parseBackgroundResult({
      stdout: 'plain text output',
      stderr: '',
      exitCode: 0,
      timedOut: false,
    });

    expect(result.output).toBe('plain text output');
    expect(result.usage).toBeUndefined();
  });

  it('estimates context usage from cache-read tokens', () => {
    expect(
      provider.estimateContextUsage({
        inputTokens: 1000,
        outputTokens: 200,
        cacheReadTokens: 50000,
      }),
    ).toEqual({
      ratio: 0.25,
      inputTokens: 1000,
      rawMetric: 50000,
      rawMetricName: 'cache_read_input_tokens',
    });
  });
});
