/**
 * Unit tests for ApprovalGate.
 *
 * Tests cover:
 *   - Approval prompt is sent to the correct channel
 *   - Operator approves (y, yes, approve, ok — case insensitive)
 *   - Operator denies (n, no, deny, reject)
 *   - Timeout auto-denies
 *   - Concurrent approvals for different threads
 *   - resolveApproval returns false for unknown thread
 *   - Unrecognised responses leave approval pending
 *   - Audit log is written for each decision (approved / denied / timeout)
 *   - Channel not found: prompt send is skipped, gate still waits
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ok, err } from 'neverthrow';
import { ApprovalGate } from '../../../src/tools/approval-gate.js';
import type { ToolCallRequest } from '../../../src/tools/tool-types.js';
import type { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import type { ChannelConnector } from '../../../src/channels/channel-types.js';
import type { AuditRepository } from '../../../src/core/database/repositories/audit-repository.js';
import { ChannelError } from '../../../src/core/errors/error-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Flush all pending microtasks by yielding to the event loop multiple times.
 * Needed when using vi.useFakeTimers() which doesn't drain microtasks.
 */
async function flushPromises(): Promise<void> {
  // Multiple passes to handle chains of awaits inside the implementation
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

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

function makeRequest(overrides: Partial<ToolCallRequest> = {}): ToolCallRequest {
  return {
    requestId: 'req-001',
    tool: 'fs.write:workspace',
    args: { path: '/workspace/file.txt', content: 'hello' },
    runId: 'run-001',
    threadId: 'thread-001',
    personaId: 'persona-001',
    ...overrides,
  };
}

function makeConnector(
  sendResult: ReturnType<typeof ok> | ReturnType<typeof err> = ok(undefined),
): ChannelConnector {
  return {
    type: 'telegram',
    name: 'my-telegram',
    start: vi.fn(),
    stop: vi.fn(),
    onMessage: vi.fn(),
    send: vi.fn().mockResolvedValue(sendResult),
    format: vi.fn((s: string) => s),
  };
}

function makeRegistry(connector?: ChannelConnector): ChannelRegistry {
  return {
    get: vi.fn().mockReturnValue(connector),
    register: vi.fn(),
    unregister: vi.fn(),
    getByType: vi.fn(),
    listAll: vi.fn(),
    startAll: vi.fn(),
    stopAll: vi.fn(),
  } as unknown as ChannelRegistry;
}

function makeAuditRepo(): AuditRepository {
  return {
    insert: vi.fn().mockReturnValue(ok({ id: 'audit-1', created_at: Date.now() })),
    findByRun: vi.fn(),
    findByThread: vi.fn(),
    findByAction: vi.fn(),
  } as unknown as AuditRepository;
}

function makeGate(
  connector?: ChannelConnector,
  timeoutMs = 5_000,
): { gate: ApprovalGate; connector: ChannelConnector; registry: ChannelRegistry; auditRepo: AuditRepository; logger: ReturnType<typeof makeLogger> } {
  const conn = connector ?? makeConnector();
  const registry = makeRegistry(conn);
  const auditRepo = makeAuditRepo();
  const logger = makeLogger();

  const gate = new ApprovalGate({
    channelRegistry: registry,
    auditRepo,
    logger,
    defaultTimeoutMs: timeoutMs,
  });

  return { gate, connector: conn, registry, auditRepo, logger };
}

// ---------------------------------------------------------------------------
// Approval prompt is sent to the correct channel
// ---------------------------------------------------------------------------

describe('ApprovalGate — approval prompt sending', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sends the approval prompt to the named channel connector', async () => {
    const { gate, connector } = makeGate();
    const request = makeRequest();

    // Kick off approval; we'll resolve it from outside
    const approvalPromise = gate.requestApproval(request, 'thread-001', 'my-telegram');

    // Flush microtasks so the send is called before we resolve
    await flushPromises();

    expect(connector.send).toHaveBeenCalledTimes(1);
    expect(connector.send).toHaveBeenCalledWith(
      'thread-001',
      expect.objectContaining({ body: expect.stringContaining('fs.write:workspace') }),
    );

    // Resolve the gate to avoid dangling promise
    gate.resolveApproval('thread-001', 'y');
    await approvalPromise;
  });

  it('includes the tool name and args in the approval prompt body', async () => {
    const { gate, connector } = makeGate();
    const request = makeRequest({ tool: 'net.http:egress', args: { url: 'https://example.com' } });

    const approvalPromise = gate.requestApproval(request, 'thread-001', 'my-telegram');
    await flushPromises();

    const sentBody: string = (connector.send as ReturnType<typeof vi.fn>).mock.calls[0][1].body;
    expect(sentBody).toContain('net.http:egress');
    expect(sentBody).toContain('https://example.com');
    expect(sentBody).toContain('Approve?');

    gate.resolveApproval('thread-001', 'y');
    await approvalPromise;
  });

  it('logs a warning but does not throw when the channel connector is not found', async () => {
    const registry = makeRegistry(undefined); // no connector
    const auditRepo = makeAuditRepo();
    const logger = makeLogger();
    const gate = new ApprovalGate({ channelRegistry: registry, auditRepo, logger, defaultTimeoutMs: 5_000 });

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'nonexistent-channel');
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ channelId: 'nonexistent-channel' }),
      expect.stringContaining('channel connector not found'),
    );

    // Gate should still be waiting — resolve manually
    gate.resolveApproval('thread-001', 'n');
    const outcome = await approvalPromise;
    expect(outcome).toBe('denied');
  });

  it('logs a warning when the channel send fails but does not throw', async () => {
    const channelErr = new ChannelError('network error');
    const connector = makeConnector(err(channelErr));
    const { gate, logger } = makeGate(connector);

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: channelErr }),
      expect.stringContaining('failed to send approval prompt'),
    );

    gate.resolveApproval('thread-001', 'approve');
    const outcome = await approvalPromise;
    expect(outcome).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Operator approves
// ---------------------------------------------------------------------------

describe('ApprovalGate — operator approves', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const approveInputs = ['y', 'Y', 'yes', 'YES', 'Yes', 'approve', 'APPROVE', 'Approve', 'ok', 'OK', 'Ok'];

  for (const input of approveInputs) {
    it(`resolves as 'approved' when operator responds with "${input}"`, async () => {
      const { gate } = makeGate();
      const request = makeRequest();

      const approvalPromise = gate.requestApproval(request, 'thread-001', 'my-telegram');
      await flushPromises();

      const resolved = gate.resolveApproval('thread-001', input);
      expect(resolved).toBe(true);

      const outcome = await approvalPromise;
      expect(outcome).toBe('approved');
    });
  }

  it('resolves as approved for "approve" with surrounding whitespace', async () => {
    const { gate } = makeGate();

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    gate.resolveApproval('thread-001', '  approve  ');
    const outcome = await approvalPromise;
    expect(outcome).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Operator denies
// ---------------------------------------------------------------------------

describe('ApprovalGate — operator denies', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  const denyInputs = ['n', 'N', 'no', 'NO', 'No', 'deny', 'DENY', 'Deny', 'reject', 'REJECT', 'Reject'];

  for (const input of denyInputs) {
    it(`resolves as 'denied' when operator responds with "${input}"`, async () => {
      const { gate } = makeGate();
      const request = makeRequest();

      const approvalPromise = gate.requestApproval(request, 'thread-001', 'my-telegram');
      await flushPromises();

      const resolved = gate.resolveApproval('thread-001', input);
      expect(resolved).toBe(true);

      const outcome = await approvalPromise;
      expect(outcome).toBe('denied');
    });
  }

  it('resolves as denied for "no" with surrounding whitespace', async () => {
    const { gate } = makeGate();

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    gate.resolveApproval('thread-001', '  no  ');
    const outcome = await approvalPromise;
    expect(outcome).toBe('denied');
  });
});

// ---------------------------------------------------------------------------
// Unrecognised responses
// ---------------------------------------------------------------------------

describe('ApprovalGate — unrecognised responses', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('returns false and leaves the approval pending for unrecognised text', async () => {
    const { gate } = makeGate();

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    const resolved = gate.resolveApproval('thread-001', 'maybe');
    expect(resolved).toBe(false);

    // Resolve properly to avoid dangling promise
    gate.resolveApproval('thread-001', 'y');
    await approvalPromise;
  });

  it('returns false and leaves the approval pending for empty string', async () => {
    const { gate } = makeGate();

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    const resolved = gate.resolveApproval('thread-001', '');
    expect(resolved).toBe(false);

    gate.resolveApproval('thread-001', 'y');
    await approvalPromise;
  });
});

// ---------------------------------------------------------------------------
// Timeout auto-denies
// ---------------------------------------------------------------------------

describe('ApprovalGate — timeout', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('auto-resolves as timeout when the deadline passes with no operator response', async () => {
    const { gate } = makeGate(undefined, 1_000);

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    // Advance past the timeout
    await vi.advanceTimersByTimeAsync(1_001);

    const outcome = await approvalPromise;
    expect(outcome).toBe('timeout');
  });

  it('resolves as timeout even when operator responds after the deadline', async () => {
    const { gate } = makeGate(undefined, 1_000);

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    await vi.advanceTimersByTimeAsync(1_001);

    // Late response — gate is already resolved
    const lateResolved = gate.resolveApproval('thread-001', 'y');
    expect(lateResolved).toBe(false); // thread no longer in pending map

    const outcome = await approvalPromise;
    expect(outcome).toBe('timeout');
  });

  it('does not auto-deny when operator responds before the deadline', async () => {
    const { gate } = makeGate(undefined, 5_000);

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    // Respond well before timeout
    gate.resolveApproval('thread-001', 'yes');

    // Advancing timers now should not re-resolve the promise
    await vi.advanceTimersByTimeAsync(6_000);

    const outcome = await approvalPromise;
    expect(outcome).toBe('approved');
  });
});

// ---------------------------------------------------------------------------
// Concurrent approvals for different threads
// ---------------------------------------------------------------------------

describe('ApprovalGate — concurrent approvals', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('handles two concurrent approval requests on different threads independently', async () => {
    const { gate } = makeGate();

    const requestA = makeRequest({ threadId: 'thread-A', requestId: 'req-A' });
    const requestB = makeRequest({ threadId: 'thread-B', requestId: 'req-B' });

    const promiseA = gate.requestApproval(requestA, 'thread-A', 'my-telegram');
    const promiseB = gate.requestApproval(requestB, 'thread-B', 'my-telegram');

    await flushPromises();

    // Resolve in different order with different outcomes
    gate.resolveApproval('thread-B', 'n');
    gate.resolveApproval('thread-A', 'y');

    const [outcomeA, outcomeB] = await Promise.all([promiseA, promiseB]);
    expect(outcomeA).toBe('approved');
    expect(outcomeB).toBe('denied');
  });

  it('resolveApproval for thread-A does not affect pending approval on thread-B', async () => {
    const { gate } = makeGate(undefined, 1_000);

    const requestA = makeRequest({ threadId: 'thread-A', requestId: 'req-A' });
    const requestB = makeRequest({ threadId: 'thread-B', requestId: 'req-B' });

    const promiseA = gate.requestApproval(requestA, 'thread-A', 'my-telegram');
    const promiseB = gate.requestApproval(requestB, 'thread-B', 'my-telegram');

    await flushPromises();

    gate.resolveApproval('thread-A', 'yes');
    // B still pending — let it timeout
    await vi.advanceTimersByTimeAsync(1_001);

    const outcomeA = await promiseA;
    const outcomeB = await promiseB;
    expect(outcomeA).toBe('approved');
    expect(outcomeB).toBe('timeout');
  });
});

// ---------------------------------------------------------------------------
// resolveApproval returns false for unknown thread
// ---------------------------------------------------------------------------

describe('ApprovalGate — resolveApproval with no pending approval', () => {
  it('returns false when there is no pending approval for the given threadId', () => {
    const { gate } = makeGate();
    const resolved = gate.resolveApproval('nonexistent-thread', 'y');
    expect(resolved).toBe(false);
  });

  it('returns false after the approval has already been resolved', async () => {
    vi.useFakeTimers();
    const { gate } = makeGate();

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    gate.resolveApproval('thread-001', 'y');
    await approvalPromise;

    // Second call — should return false (no longer pending)
    const second = gate.resolveApproval('thread-001', 'y');
    expect(second).toBe(false);
    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Audit log is written for each decision
// ---------------------------------------------------------------------------

describe('ApprovalGate — audit log', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('writes an audit log entry when the operator approves', async () => {
    const { gate, auditRepo } = makeGate();
    const request = makeRequest();

    const approvalPromise = gate.requestApproval(request, 'thread-001', 'my-telegram');
    await flushPromises();

    gate.resolveApproval('thread-001', 'yes');
    await approvalPromise;

    expect(auditRepo.insert).toHaveBeenCalledTimes(1);
    expect(auditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval.decision',
        tool: request.tool,
        request_id: request.requestId,
        run_id: request.runId,
        thread_id: 'thread-001',
        persona_id: request.personaId,
        details: expect.stringContaining('approved'),
      }),
    );
  });

  it('writes an audit log entry when the operator denies', async () => {
    const { gate, auditRepo } = makeGate();
    const request = makeRequest();

    const approvalPromise = gate.requestApproval(request, 'thread-001', 'my-telegram');
    await flushPromises();

    gate.resolveApproval('thread-001', 'no');
    await approvalPromise;

    expect(auditRepo.insert).toHaveBeenCalledTimes(1);
    expect(auditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval.decision',
        details: expect.stringContaining('denied'),
      }),
    );
  });

  it('writes an audit log entry on timeout', async () => {
    const { gate, auditRepo } = makeGate(undefined, 500);

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    await vi.advanceTimersByTimeAsync(501);
    await approvalPromise;

    expect(auditRepo.insert).toHaveBeenCalledTimes(1);
    expect(auditRepo.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approval.decision',
        details: expect.stringContaining('timeout'),
      }),
    );
  });

  it('logs an error but does not throw when audit log insert fails', async () => {
    const { gate, auditRepo, logger } = makeGate();
    const { DbError } = await import('../../../src/core/errors/error-types.js');
    vi.mocked(auditRepo.insert).mockReturnValue(
      err(new DbError('DB unavailable')),
    );

    const approvalPromise = gate.requestApproval(makeRequest(), 'thread-001', 'my-telegram');
    await flushPromises();

    gate.resolveApproval('thread-001', 'y');
    const outcome = await approvalPromise;

    // Outcome is still returned even though audit log failed
    expect(outcome).toBe('approved');
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'approved' }),
      expect.stringContaining('failed to write audit log'),
    );
  });

  it('writes separate audit entries for each concurrent approval', async () => {
    const { gate, auditRepo } = makeGate();

    const requestA = makeRequest({ threadId: 'thread-A', requestId: 'req-A' });
    const requestB = makeRequest({ threadId: 'thread-B', requestId: 'req-B' });

    const promiseA = gate.requestApproval(requestA, 'thread-A', 'my-telegram');
    const promiseB = gate.requestApproval(requestB, 'thread-B', 'my-telegram');

    await flushPromises();

    gate.resolveApproval('thread-A', 'y');
    gate.resolveApproval('thread-B', 'n');

    await Promise.all([promiseA, promiseB]);

    expect(auditRepo.insert).toHaveBeenCalledTimes(2);
  });
});
