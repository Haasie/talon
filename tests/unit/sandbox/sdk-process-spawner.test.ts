/**
 * Unit tests for SdkProcessSpawner and output parsing utilities.
 *
 * All Docker interactions are mocked. No real containers are started.
 * Tests cover:
 *  - Config delivery via stdin JSON
 *  - Sentinel marker parsing (happy path and error cases)
 *  - Output extraction and internal-tag stripping
 *  - Session ID extraction
 *  - Token usage and tool call extraction
 *  - Timeout handling
 *  - Docker error propagation
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  SdkProcessSpawner,
  parseOutput,
  stripMetadataAndInternalTags,
  OUTPUT_START_SENTINEL,
  OUTPUT_END_SENTINEL,
  type SdkSpawnConfig,
} from '../../../src/sandbox/sdk-process-spawner.js';
import { SandboxError } from '../../../src/core/errors/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Silence pino in tests. */
function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as import('pino').Logger;
}

function makeConfig(overrides: Partial<SdkSpawnConfig> = {}): SdkSpawnConfig {
  return {
    personaId: 'test-persona',
    systemPrompt: 'You are a helpful assistant.',
    model: 'claude-sonnet-4-6',
    authMode: 'api_key',
    apiKey: 'test-key-123',
    skills: ['skill-a'],
    allowedTools: ['Read', 'Write'],
    ...overrides,
  };
}

/**
 * Build a valid sentinel-framed stdout string for testing.
 */
function buildValidOutput({
  sessionId = 'ses-abc123',
  tokenUsage = true,
  toolCalls = 0,
  content = 'Hello, world!',
  internal = false,
}: {
  sessionId?: string;
  tokenUsage?: boolean;
  toolCalls?: number;
  content?: string;
  internal?: boolean;
} = {}): string {
  const lines: string[] = [OUTPUT_START_SENTINEL];
  lines.push(`SESSION_ID:${sessionId}`);
  if (tokenUsage) {
    lines.push('TOKEN_USAGE:100,50,20,10');
  }
  for (let i = 0; i < toolCalls; i++) {
    lines.push(`TOOL_CALL:Read,req-${i},success`);
  }
  if (internal) {
    lines.push('<internal>some internal data</internal>');
  }
  lines.push(content);
  lines.push(OUTPUT_END_SENTINEL);
  return lines.join('\n');
}

/**
 * Create a mock exec stream that emits the provided stdout via Docker's
 * multiplexed frame format (8-byte header + payload per chunk).
 *
 * Docker multiplexing format:
 *   byte 0:   stream type (1 = stdout, 2 = stderr)
 *   bytes 1-3: reserved (0)
 *   bytes 4-7: payload size (big-endian uint32)
 *   bytes 8+:  payload
 */
function encodeDockerFrame(streamType: 1 | 2, payload: string): Buffer {
  const payloadBuf = Buffer.from(payload, 'utf8');
  const header = Buffer.alloc(8);
  header[0] = streamType;
  header.writeUInt32BE(payloadBuf.length, 4);
  return Buffer.concat([header, payloadBuf]);
}

/**
 * Create a mock duplex stream that emits `stdout` as a Docker-multiplexed
 * stdout frame and then ends, simulating a completed docker exec.
 *
 * The stream also captures writes to it (stdin delivery) in `writtenData`.
 */
function makeMockExecStream(stdout: string, stderr = ''): {
  stream: NodeJS.ReadWriteStream;
  writtenData: string[];
  endCalled: boolean;
} {
  const emitter = new EventEmitter() as NodeJS.ReadWriteStream;
  const writtenData: string[] = [];
  let endCalled = false;

  (emitter as unknown as { write: Mock }).write = vi.fn(
    (data: string, _encoding?: string, cb?: (err?: Error | null) => void) => {
      writtenData.push(data);
      if (cb) cb();
      return true;
    },
  );

  (emitter as unknown as { end: Mock }).end = vi.fn(() => {
    endCalled = true;
    return emitter;
  });

  // Emit the Docker-framed output asynchronously so the Promise chain
  // has a chance to attach listeners before data arrives.
  setImmediate(() => {
    if (stdout) {
      emitter.emit('data', encodeDockerFrame(1, stdout));
    }
    if (stderr) {
      emitter.emit('data', encodeDockerFrame(2, stderr));
    }
    emitter.emit('end');
  });

  return { stream: emitter, writtenData, endCalled: false };
}

/**
 * Build a mock Dockerode instance where container.exec() resolves with
 * an exec object whose start() returns the provided stream.
 */
function makeDockerMock(stream: NodeJS.ReadWriteStream) {
  const execMock = {
    start: vi.fn().mockResolvedValue(stream),
  };
  const containerMock = {
    exec: vi.fn().mockResolvedValue(execMock),
  };
  const dockerMock = {
    getContainer: vi.fn().mockReturnValue(containerMock),
  };
  return { dockerMock, containerMock, execMock };
}

// ---------------------------------------------------------------------------
// parseOutput()
// ---------------------------------------------------------------------------

describe('parseOutput()', () => {
  it('parses a well-formed output block', () => {
    const stdout = buildValidOutput({ sessionId: 'ses-abc', content: 'The answer is 42.' });
    const result = parseOutput(stdout);
    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.sessionId).toBe('ses-abc');
    expect(value.output).toContain('The answer is 42.');
  });

  it('returns Err when start sentinel is missing', () => {
    const stdout = `SESSION_ID:ses-1\nsome content\n${OUTPUT_END_SENTINEL}`;
    const result = parseOutput(stdout);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(SandboxError);
    expect(result._unsafeUnwrapErr().message).toMatch(/start sentinel/i);
  });

  it('returns Err when end sentinel is missing', () => {
    const stdout = `${OUTPUT_START_SENTINEL}\nSESSION_ID:ses-1\nsome content`;
    const result = parseOutput(stdout);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/end sentinel/i);
  });

  it('returns Err when end sentinel appears before start sentinel', () => {
    const stdout = `${OUTPUT_END_SENTINEL}\n${OUTPUT_START_SENTINEL}\nSESSION_ID:ses-1`;
    const result = parseOutput(stdout);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/before start/i);
  });

  it('returns Err when SESSION_ID is missing', () => {
    const stdout = `${OUTPUT_START_SENTINEL}\nsome content\n${OUTPUT_END_SENTINEL}`;
    const result = parseOutput(stdout);
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/SESSION_ID/);
  });

  it('extracts token usage when present', () => {
    const stdout = buildValidOutput({ tokenUsage: true });
    const result = parseOutput(stdout);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    });
  });

  it('returns undefined tokenUsage when TOKEN_USAGE line is absent', () => {
    const stdout = buildValidOutput({ tokenUsage: false });
    const result = parseOutput(stdout);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().tokenUsage).toBeUndefined();
  });

  it('extracts multiple tool calls', () => {
    const stdout = buildValidOutput({ toolCalls: 3 });
    const result = parseOutput(stdout);
    expect(result.isOk()).toBe(true);
    const { toolCalls } = result._unsafeUnwrap();
    expect(toolCalls).toHaveLength(3);
    expect(toolCalls[0]).toEqual({ tool: 'Read', requestId: 'req-0', status: 'success' });
    expect(toolCalls[1]).toEqual({ tool: 'Read', requestId: 'req-1', status: 'success' });
    expect(toolCalls[2]).toEqual({ tool: 'Read', requestId: 'req-2', status: 'success' });
  });

  it('returns empty toolCalls array when no TOOL_CALL lines present', () => {
    const stdout = buildValidOutput({ toolCalls: 0 });
    const result = parseOutput(stdout);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().toolCalls).toEqual([]);
  });

  it('handles error status in tool calls', () => {
    const inner = [
      `${OUTPUT_START_SENTINEL}`,
      'SESSION_ID:ses-x',
      'TOOL_CALL:Write,req-99,error',
      'some output',
      `${OUTPUT_END_SENTINEL}`,
    ].join('\n');
    const result = parseOutput(inner);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().toolCalls[0]).toEqual({
      tool: 'Write',
      requestId: 'req-99',
      status: 'error',
    });
  });

  it('strips <internal> tags from the returned output', () => {
    const stdout = buildValidOutput({ internal: true, content: 'Visible content here.' });
    const result = parseOutput(stdout);
    expect(result.isOk()).toBe(true);
    const { output } = result._unsafeUnwrap();
    expect(output).not.toContain('<internal>');
    expect(output).toContain('Visible content here.');
  });

  it('does not include metadata lines in output', () => {
    const stdout = buildValidOutput({ sessionId: 'ses-meta', tokenUsage: true, toolCalls: 1 });
    const result = parseOutput(stdout);
    expect(result.isOk()).toBe(true);
    const { output } = result._unsafeUnwrap();
    expect(output).not.toContain('SESSION_ID:');
    expect(output).not.toContain('TOKEN_USAGE:');
    expect(output).not.toContain('TOOL_CALL:');
  });

  it('ignores preamble before the start sentinel', () => {
    const stdout = `preamble junk\n${buildValidOutput({ sessionId: 'ses-pre', content: 'clean output' })}`;
    const result = parseOutput(stdout);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().sessionId).toBe('ses-pre');
    expect(result._unsafeUnwrap().output).toContain('clean output');
  });

  it('ignores trailing data after end sentinel', () => {
    const stdout = `${buildValidOutput({ sessionId: 'ses-trail' })}\nsome trailing garbage`;
    const result = parseOutput(stdout);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().sessionId).toBe('ses-trail');
  });
});

// ---------------------------------------------------------------------------
// stripMetadataAndInternalTags()
// ---------------------------------------------------------------------------

describe('stripMetadataAndInternalTags()', () => {
  it('removes SESSION_ID line', () => {
    const result = stripMetadataAndInternalTags('SESSION_ID:abc\nHello!');
    expect(result).not.toContain('SESSION_ID:');
    expect(result).toContain('Hello!');
  });

  it('removes TOKEN_USAGE line', () => {
    const result = stripMetadataAndInternalTags('TOKEN_USAGE:1,2,3,4\nContent');
    expect(result).not.toContain('TOKEN_USAGE:');
    expect(result).toContain('Content');
  });

  it('removes TOOL_CALL lines', () => {
    const result = stripMetadataAndInternalTags('TOOL_CALL:Read,req-1,success\nOutput');
    expect(result).not.toContain('TOOL_CALL:');
    expect(result).toContain('Output');
  });

  it('removes single-line <internal> block', () => {
    const result = stripMetadataAndInternalTags('Before <internal>secret</internal> after');
    expect(result).not.toContain('<internal>');
    expect(result).toContain('Before');
    expect(result).toContain('after');
  });

  it('removes multi-line <internal> block', () => {
    const content = 'Line 1\n<internal>\nfoo\nbar\n</internal>\nLine 2';
    const result = stripMetadataAndInternalTags(content);
    expect(result).not.toContain('foo');
    expect(result).toContain('Line 1');
    expect(result).toContain('Line 2');
  });

  it('trims leading and trailing whitespace', () => {
    const result = stripMetadataAndInternalTags('\n\nSESSION_ID:x\nHello\n\n');
    expect(result).toBe('Hello');
  });

  it('returns empty string when only metadata is present', () => {
    const result = stripMetadataAndInternalTags('SESSION_ID:abc\nTOKEN_USAGE:1,2,3,4\n');
    expect(result).toBe('');
  });
});

// ---------------------------------------------------------------------------
// SdkProcessSpawner.spawn()
// ---------------------------------------------------------------------------

describe('SdkProcessSpawner.spawn()', () => {
  let logger: ReturnType<typeof makeLogger>;

  beforeEach(() => {
    logger = makeLogger();
  });

  afterEach(() => {
    // Ensure fake timers are always restored so they do not bleed into other tests.
    vi.useRealTimers();
  });

  it('returns Ok<SdkProcessResult> for valid output', async () => {
    const stdout = buildValidOutput({ sessionId: 'ses-ok', content: 'Done!' });
    const { stream } = makeMockExecStream(stdout);
    const { dockerMock } = makeDockerMock(stream);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    const result = await spawner.spawn('cid-123', makeConfig(), '/ipc/in', '/ipc/out');

    expect(result.isOk()).toBe(true);
    const value = result._unsafeUnwrap();
    expect(value.sessionId).toBe('ses-ok');
    expect(value.output).toContain('Done!');
  });

  it('delivers config as JSON to stdin', async () => {
    const stdout = buildValidOutput({ sessionId: 'ses-stdin' });
    const { stream, writtenData } = makeMockExecStream(stdout);
    const { dockerMock } = makeDockerMock(stream);

    const config = makeConfig({ apiKey: 'secret-key-xyz' });
    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    await spawner.spawn('cid-abc', config, '/in', '/out');

    // At least one write should have happened containing the JSON config.
    expect(writtenData.length).toBeGreaterThan(0);
    const combinedWritten = writtenData.join('');
    const parsed = JSON.parse(combinedWritten.trim());
    expect(parsed.personaId).toBe(config.personaId);
    expect(parsed.apiKey).toBe('secret-key-xyz');
  });

  it('passes IPC directories as environment variables to exec', async () => {
    const stdout = buildValidOutput({ sessionId: 'ses-env' });
    const { stream } = makeMockExecStream(stdout);
    const { dockerMock, containerMock } = makeDockerMock(stream);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    await spawner.spawn('cid-env', makeConfig(), '/data/ipc/in', '/data/ipc/out');

    expect(containerMock.exec).toHaveBeenCalledOnce();
    const execOpts = (containerMock.exec as Mock).mock.calls[0][0] as { Env: string[] };
    expect(execOpts.Env).toContain('TALON_IPC_INPUT_DIR=/data/ipc/in');
    expect(execOpts.Env).toContain('TALON_IPC_OUTPUT_DIR=/data/ipc/out');
  });

  it('includes additional env vars from config in the exec environment', async () => {
    const stdout = buildValidOutput({ sessionId: 'ses-extraenv' });
    const { stream } = makeMockExecStream(stdout);
    const { dockerMock, containerMock } = makeDockerMock(stream);

    const config = makeConfig({ env: { MY_VAR: 'hello', OTHER: 'world' } });
    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    await spawner.spawn('cid-ev', config, '/in', '/out');

    const execOpts = (containerMock.exec as Mock).mock.calls[0][0] as { Env: string[] };
    expect(execOpts.Env).toContain('MY_VAR=hello');
    expect(execOpts.Env).toContain('OTHER=world');
  });

  it('calls container.exec with AttachStdin, AttachStdout, AttachStderr all true', async () => {
    const stdout = buildValidOutput({ sessionId: 'ses-attach' });
    const { stream } = makeMockExecStream(stdout);
    const { dockerMock, containerMock } = makeDockerMock(stream);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    await spawner.spawn('cid-at', makeConfig(), '/in', '/out');

    const execOpts = (containerMock.exec as Mock).mock.calls[0][0] as {
      AttachStdin: boolean;
      AttachStdout: boolean;
      AttachStderr: boolean;
    };
    expect(execOpts.AttachStdin).toBe(true);
    expect(execOpts.AttachStdout).toBe(true);
    expect(execOpts.AttachStderr).toBe(true);
  });

  it('uses container ID from the containerId argument', async () => {
    const stdout = buildValidOutput({ sessionId: 'ses-cid' });
    const { stream } = makeMockExecStream(stdout);
    const { dockerMock } = makeDockerMock(stream);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    await spawner.spawn('specific-container-id', makeConfig(), '/in', '/out');

    expect((dockerMock.getContainer as Mock)).toHaveBeenCalledWith('specific-container-id');
  });

  it('returns Err<SandboxError> when output is missing the start sentinel', async () => {
    const badOutput = `SESSION_ID:ses-1\nsome content\n${OUTPUT_END_SENTINEL}`;
    const { stream } = makeMockExecStream(badOutput);
    const { dockerMock } = makeDockerMock(stream);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    const result = await spawner.spawn('cid-bad', makeConfig(), '/in', '/out');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(SandboxError);
    expect(result._unsafeUnwrapErr().message).toMatch(/start sentinel/i);
  });

  it('returns Err<SandboxError> when docker.getContainer().exec() throws', async () => {
    const dockerMock = {
      getContainer: vi.fn().mockReturnValue({
        exec: vi.fn().mockRejectedValue(new Error('Docker exec failed')),
      }),
    };

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    const result = await spawner.spawn('cid-err', makeConfig(), '/in', '/out');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(SandboxError);
    expect(result._unsafeUnwrapErr().message).toContain('Docker exec failed');
  });

  it('returns Err<SandboxError> on stream error event', async () => {
    const emitter = new EventEmitter() as NodeJS.ReadWriteStream;
    (emitter as unknown as { write: Mock }).write = vi.fn((_: unknown, __: unknown, cb?: (e?: Error | null) => void) => {
      if (cb) cb();
      return true;
    });
    (emitter as unknown as { end: Mock }).end = vi.fn(() => emitter);

    setImmediate(() => {
      emitter.emit('error', new Error('stream broken'));
    });

    const { dockerMock } = makeDockerMock(emitter);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    const result = await spawner.spawn('cid-streamerr', makeConfig(), '/in', '/out');

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('stream broken');
  });

  it('returns Err<SandboxError> when the run exceeds timeoutMs', async () => {
    vi.useFakeTimers();

    const emitter = new EventEmitter() as NodeJS.ReadWriteStream;
    (emitter as unknown as { write: Mock }).write = vi.fn((_: unknown, __: unknown, cb?: (e?: Error | null) => void) => {
      if (cb) cb();
      return true;
    });
    (emitter as unknown as { end: Mock }).end = vi.fn(() => emitter);
    // Deliberately never emit 'end' so the process hangs until timeout.

    const { dockerMock } = makeDockerMock(emitter);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
      500, // 500ms timeout for the test
    );

    // Start the spawn (does not await yet — we need to advance timers first).
    const promise = spawner.spawn('cid-timeout', makeConfig(), '/in', '/out');

    // Use advanceTimersByTimeAsync so that microtasks (including the awaited
    // writeToStream Promise) are flushed between each timer tick.  This ensures
    // the collectOutput() timeout timer is registered before we fire it.
    await vi.advanceTimersByTimeAsync(600);

    const result = await promise;

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toMatch(/timed out/i);
  });

  it('extracts session ID from output for conversation resumption', async () => {
    const stdout = buildValidOutput({ sessionId: 'ses-resume-42' });
    const { stream } = makeMockExecStream(stdout);
    const { dockerMock } = makeDockerMock(stream);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    const result = await spawner.spawn('cid-resume', makeConfig(), '/in', '/out');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().sessionId).toBe('ses-resume-42');
  });

  it('passes existing sessionId in config JSON for resumption', async () => {
    const stdout = buildValidOutput({ sessionId: 'ses-continued' });
    const { stream, writtenData } = makeMockExecStream(stdout);
    const { dockerMock } = makeDockerMock(stream);

    const config = makeConfig({ sessionId: 'ses-prev-session' });
    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    await spawner.spawn('cid-cont', config, '/in', '/out');

    const combined = writtenData.join('');
    const parsed = JSON.parse(combined.trim());
    expect(parsed.sessionId).toBe('ses-prev-session');
  });

  it('logs stderr as a warning when the process emits it', async () => {
    const stdout = buildValidOutput({ sessionId: 'ses-stderr' });
    const { stream } = makeMockExecStream(stdout, 'warning: something happened');
    const { dockerMock } = makeDockerMock(stream);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    await spawner.spawn('cid-se', makeConfig(), '/in', '/out');

    expect(logger.warn).toHaveBeenCalled();
  });

  it('extracts token usage from the output', async () => {
    const stdout = buildValidOutput({ tokenUsage: true });
    const { stream } = makeMockExecStream(stdout);
    const { dockerMock } = makeDockerMock(stream);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    const result = await spawner.spawn('cid-tokens', makeConfig(), '/in', '/out');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().tokenUsage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
    });
  });

  it('extracts tool calls from the output', async () => {
    const stdout = buildValidOutput({ toolCalls: 2 });
    const { stream } = makeMockExecStream(stdout);
    const { dockerMock } = makeDockerMock(stream);

    const spawner = new SdkProcessSpawner(
      dockerMock as unknown as import('dockerode').default,
      logger,
    );
    const result = await spawner.spawn('cid-tools', makeConfig(), '/in', '/out');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().toolCalls).toHaveLength(2);
  });
});
