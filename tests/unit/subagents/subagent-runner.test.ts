import { describe, it, expect, vi } from 'vitest';
import { ok, err } from 'neverthrow';
import { SubAgentRunner, type SubAgentInvokeContext } from '../../../src/subagents/subagent-runner.js';
import type { LoadedSubAgent, SubAgentServices } from '../../../src/subagents/subagent-types.js';
import type { ModelResolver } from '../../../src/subagents/model-resolver.js';
import { SubAgentError } from '../../../src/core/errors/index.js';
import type pino from 'pino';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAgent(overrides: Partial<LoadedSubAgent> = {}): LoadedSubAgent {
  return {
    manifest: {
      name: 'test-agent',
      version: '0.1.0',
      description: 'A test sub-agent',
      model: { provider: 'anthropic', name: 'claude-haiku-4-5', maxTokens: 2048 },
      requiredCapabilities: ['memory.access'],
      rootPaths: [],
      timeoutMs: 30_000,
    },
    promptContents: ['You are a test agent.', 'Be helpful.'],
    run: vi.fn().mockResolvedValue(ok({ summary: 'Done', data: {} })),
    rootDir: '/tmp/subagents/test-agent',
    ...overrides,
  };
}

function makeContext(overrides: Partial<SubAgentInvokeContext> = {}): SubAgentInvokeContext {
  return {
    threadId: 'thread-1',
    personaId: 'assistant',
    personaSubagents: ['test-agent'],
    personaCapabilities: {
      allow: ['memory.access'],
      requireApproval: [],
    },
    ...overrides,
  };
}

const mockResolver = {
  resolve: vi.fn().mockResolvedValue(ok({} as any)),
} as unknown as ModelResolver;

const mockLogger = {
  child: vi.fn().mockReturnThis(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  fatal: vi.fn(),
} as unknown as pino.Logger;

const mockServices = {
  memory: {},
  schedules: {},
  personas: {},
  channels: {},
  threads: {},
  messages: {},
  runs: {},
  queue: {},
  logger: mockLogger,
} as unknown as SubAgentServices;

function makeRunner(
  agents: Map<string, LoadedSubAgent> = new Map(),
  resolver: ModelResolver = mockResolver,
): SubAgentRunner {
  return new SubAgentRunner(agents, resolver, mockServices, mockLogger);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SubAgentRunner', () => {
  it('executes a sub-agent and returns its result (happy path)', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const result = await runner.execute('test-agent', { key: 'value' }, makeContext());

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.summary).toBe('Done');
    expect(value.data).toEqual({});
    expect(agent.run).toHaveBeenCalledOnce();

    // Verify the context passed to run has the assembled system prompt
    const callArgs = (agent.run as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[0].systemPrompt).toBe('You are a test agent.\n\nBe helpful.');
    expect(callArgs[1]).toEqual({ key: 'value' });
  });

  it('rejects unknown sub-agent name', async () => {
    const runner = makeRunner(new Map());

    const result = await runner.execute('nonexistent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Unknown sub-agent "nonexistent"');
  });

  it('rejects sub-agent not in persona assignment list', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const ctx = makeContext({ personaSubagents: ['other-agent'] });
    const result = await runner.execute('test-agent', {}, ctx);

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('not assigned to persona');
  });

  it('rejects sub-agent with unsatisfied capabilities', async () => {
    const agent = makeAgent({
      manifest: {
        ...makeAgent().manifest,
        requiredCapabilities: ['memory.access', 'net.http'],
      },
    });
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    // Persona only has memory.access, not net.http
    const ctx = makeContext({
      personaCapabilities: { allow: ['memory.access'], requireApproval: [] },
    });
    const result = await runner.execute('test-agent', {}, ctx);

    expect(result.isErr()).toBe(true);
    const errorMsg = result._unsafeUnwrapErr().message;
    expect(errorMsg).toContain('lacks capabilities');
    expect(errorMsg).toContain('net.http');
  });

  it('accepts capabilities from requireApproval list', async () => {
    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    // Capability is in requireApproval, not allow
    const ctx = makeContext({
      personaCapabilities: { allow: [], requireApproval: ['memory.access'] },
    });
    const result = await runner.execute('test-agent', {}, ctx);

    expect(result.isOk()).toBe(true);
  });

  it('respects timeout on slow sub-agents', async () => {
    const slowRun = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(ok({ summary: 'late' })), 10_000)),
    );
    const agent = makeAgent({
      manifest: { ...makeAgent().manifest, timeoutMs: 100 },
      run: slowRun,
    });
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('timed out after 100ms');
  });

  it('wraps sub-agent run errors in ToolError', async () => {
    const failingRun = vi.fn().mockResolvedValue(
      err(new SubAgentError('Something went wrong')),
    );
    const agent = makeAgent({ run: failingRun });
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    const toolErr = result._unsafeUnwrapErr();
    expect(toolErr.code).toBe('TOOL_ERROR');
    expect(toolErr.message).toContain('Something went wrong');
  });

  it('returns error when model resolution fails', async () => {
    const { ConfigError } = await import('../../../src/core/errors/index.js');
    const failingResolver = {
      resolve: vi.fn().mockResolvedValue(err(new ConfigError('No credentials'))),
    } as unknown as ModelResolver;

    const agent = makeAgent();
    const agents = new Map([['test-agent', agent]]);
    const runner = makeRunner(agents, failingResolver);

    const result = await runner.execute('test-agent', {}, makeContext());

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Failed to resolve model');
  });
});
