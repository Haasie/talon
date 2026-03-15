import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
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

  it('creates an SDK execution strategy with session resumption enabled', () => {
    const strategy = provider.createExecutionStrategy();

    expect(strategy.type).toBe('sdk');
    expect(strategy.supportsSessionResumption).toBe(true);
    expect(typeof strategy.run).toBe('function');
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
    expect(readdirSync(dirname(configPath)).sort()).toEqual(['mcp-config.json']);
  });

  it('writes an empty MCP config when no background MCP servers are configured', () => {
    const result = provider.prepareBackgroundInvocation({
      prompt: 'Ping.',
      systemPrompt: 'You are a helpful assistant.',
      mcpServers: {},
      cwd: '/tmp',
      timeoutMs: 60_000,
    });

    expect(result.isOk()).toBe(true);
    const invocation = result._unsafeUnwrap();
    cleanupPaths.push(...invocation.cleanupPaths);

    const configPath = invocation.args[invocation.args.indexOf('--mcp-config') + 1];
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      mcpServers: {},
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

  it('returns err and cleans up the temp dir when writeFileSync throws', async () => {
    // Track whether rmSync was called for our temp dir. We use a wrapper
    // around the real rmSync rather than trying to spy on the non-configurable
    // node:fs named export directly.
    const capturedRmCalls: Array<[string, unknown]> = [];
    const realFs = await import('node:fs');

    // Temporarily replace the module in the registry via doMock + resetModules.
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      let writeCount = 0;
      return {
        ...actual,
        writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
          if (writeCount++ === 0) {
            throw new Error('disk full');
          }
          return actual.writeFileSync(...args);
        },
        rmSync: (path: string, opts: unknown) => {
          capturedRmCalls.push([path, opts]);
          return actual.rmSync(path, opts as Parameters<typeof actual.rmSync>[1]);
        },
      };
    });

    vi.resetModules();

    try {
      const { ClaudeCodeProvider: IsolatedProvider } = await import(
        '../../../src/providers/claude-code-provider.js'
      );
      const isolatedProvider = new IsolatedProvider({
        enabled: true,
        command: 'claude',
        contextWindowTokens: 200000,
        rotationThreshold: 0.4,
      });

      const result = isolatedProvider.prepareBackgroundInvocation({
        prompt: 'Test prompt.',
        systemPrompt: 'System.',
        mcpServers: {},
        cwd: '/tmp',
        timeoutMs: 30_000,
      });

      expect(result.isErr()).toBe(true);
      const error = result._unsafeUnwrapErr();
      expect(error.message).toContain('failed to prepare background invocation');
      expect(error.message).toContain('disk full');

      const talonRmCalls = capturedRmCalls.filter(([p]) =>
        p.includes('talon-provider-claude-code-'),
      );
      expect(talonRmCalls.length).toBeGreaterThanOrEqual(1);
      expect(talonRmCalls[0][1]).toEqual({ recursive: true, force: true });
    } finally {
      vi.doUnmock('node:fs');
      vi.resetModules();
      // Suppress unused-variable lint warning
      void realFs;
    }
  });

  it('createExecutionStrategy returns the correct shape with a run method', () => {
    const strategy = provider.createExecutionStrategy();

    expect(strategy).toMatchObject({
      type: 'sdk',
      supportsSessionResumption: true,
    });
    expect(typeof strategy.run).toBe('function');
    // run must return an async iterable (has Symbol.asyncIterator)
    const iterable = strategy.run({
      prompt: 'hi',
      systemPrompt: '',
      model: 'claude-3-5-sonnet-20241022',
      mcpServers: {},
      cwd: '/tmp',
      maxTurns: 1,
      timeoutMs: 30_000,
    });
    expect(iterable).toBeDefined();
    expect(typeof iterable[Symbol.asyncIterator]).toBe('function');
  });

  it('parseBackgroundResult with timedOut:true preserves the flag and surfaces stderr', () => {
    const result = provider.parseBackgroundResult({
      stdout: '',
      stderr: 'process killed after timeout',
      exitCode: null,
      timedOut: true,
    });

    expect(result.timedOut).toBe(true);
    expect(result.exitCode).toBeNull();
    expect(result.stderr).toBe('process killed after timeout');
    // stdout was empty so output falls back to the raw empty string
    expect(result.output).toBe('');
  });

  it('parseBackgroundResult extracts JSON result even when exitCode is non-zero', () => {
    const result = provider.parseBackgroundResult({
      stdout: JSON.stringify({
        result: 'Partial output before crash.',
        usage: { input_tokens: 50, output_tokens: 10 },
      }),
      stderr: 'something went wrong',
      exitCode: 1,
      timedOut: false,
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe('Partial output before crash.');
    expect(result.usage).toEqual({
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
      totalCostUsd: undefined,
    });
  });

  it('estimateContextUsage returns ratio 0 when all token counts are zero', () => {
    const result = provider.estimateContextUsage({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
    });

    expect(result).toEqual({
      ratio: 0,
      inputTokens: 0,
      rawMetric: 0,
      rawMetricName: 'cache_read_input_tokens',
    });
  });

  it('prepareBackgroundInvocation with empty mcpServers writes a valid empty JSON config', () => {
    const result = provider.prepareBackgroundInvocation({
      prompt: 'Empty servers test.',
      systemPrompt: 'Be brief.',
      mcpServers: {},
      cwd: '/tmp',
      timeoutMs: 10_000,
    });

    expect(result.isOk()).toBe(true);
    const invocation = result._unsafeUnwrap();
    cleanupPaths.push(...invocation.cleanupPaths);

    const configPath = invocation.args[invocation.args.indexOf('--mcp-config') + 1];
    const parsed = JSON.parse(readFileSync(configPath, 'utf8')) as unknown;
    expect(parsed).toEqual({ mcpServers: {} });
    // Confirm the written config is valid JSON (no parse errors would reach here)
    expect(typeof configPath).toBe('string');
    expect(existsSync(configPath)).toBe(true);
  });
});
