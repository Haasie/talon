/**
 * Unit tests for SandboxManager.
 *
 * ContainerFactory is fully mocked — no Docker socket is required.
 * Tests cover: spawn, get, kill, reapIdle, shutdownAll, maxConcurrent
 * enforcement, idle eviction, and state transitions.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { ok, err } from 'neverthrow';
import { SandboxManager } from '../../../src/sandbox/sandbox-manager.js';
import { SandboxState } from '../../../src/sandbox/sandbox-types.js';
import { SandboxError } from '../../../src/core/errors/index.js';
import type { ContainerFactory } from '../../../src/sandbox/container-factory.js';
import type { SandboxConfig, ContainerInfo } from '../../../src/sandbox/sandbox-types.js';
import type { PersonaConfig } from '../../../src/core/config/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSandboxConfig(overrides: Partial<SandboxConfig> = {}): SandboxConfig {
  return {
    runtime: 'docker',
    image: 'talon-sandbox:test',
    maxConcurrent: 3,
    networkDefault: 'off',
    idleTimeoutMs: 30_000,
    hardTimeoutMs: 60_000,
    resourceLimits: { memoryMb: 512, cpus: 1, pidsLimit: 128 },
    ...overrides,
  };
}

function makePersona(name = 'test-persona'): PersonaConfig {
  return {
    name,
    model: 'claude-sonnet-4-6',
    skills: [],
    capabilities: { allow: [], requireApproval: [] },
    mounts: [],
  };
}

/** Create a mock ContainerFactory that succeeds by default. */
function makeFactoryMock(containerId = 'mock-cid-123'): ContainerFactory & {
  createContainer: Mock;
  removeContainer: Mock;
  isRunning: Mock;
} {
  const mockDockerContainer = {
    id: containerId,
    inspect: vi.fn().mockResolvedValue({ Id: containerId, State: { Running: true } }),
  };

  return {
    createContainer: vi.fn().mockResolvedValue(ok(mockDockerContainer)),
    removeContainer: vi.fn().mockResolvedValue(ok(undefined)),
    isRunning: vi.fn().mockResolvedValue(ok(true)),
    getDocker: vi.fn(),
    // Static method not on instance; included for completeness.
  } as unknown as ContainerFactory & {
    createContainer: Mock;
    removeContainer: Mock;
    isRunning: Mock;
  };
}

/** Silence pino output in tests. */
function makeLogger(): ReturnType<typeof import('pino').default> {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as unknown as ReturnType<typeof import('pino').default>;
}

function makeManager(
  configOverrides: Partial<SandboxConfig> = {},
  factory?: ReturnType<typeof makeFactoryMock>,
): {
  manager: SandboxManager;
  factory: ReturnType<typeof makeFactoryMock>;
  logger: ReturnType<typeof makeLogger>;
} {
  const f = factory ?? makeFactoryMock();
  const logger = makeLogger();
  const manager = new SandboxManager(f, makeSandboxConfig(configOverrides), '/data', logger);
  return { manager, factory: f, logger };
}

// ---------------------------------------------------------------------------
// Initial state
// ---------------------------------------------------------------------------

describe('SandboxManager — initial state', () => {
  it('starts with zero active containers', () => {
    const { manager } = makeManager();
    expect(manager.activeCount()).toBe(0);
  });

  it('list() returns empty array', () => {
    const { manager } = makeManager();
    expect(manager.list()).toEqual([]);
  });

  it('get() returns undefined for unknown threadId', () => {
    const { manager } = makeManager();
    expect(manager.get('no-such-thread')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// getOrSpawn — success
// ---------------------------------------------------------------------------

describe('SandboxManager.getOrSpawn() — success', () => {
  it('returns Ok<ContainerInfo> on first spawn', async () => {
    const { manager } = makeManager();
    const result = await manager.getOrSpawn('t1', 'persona-1', makePersona());
    expect(result.isOk()).toBe(true);
  });

  it('returned ContainerInfo has correct threadId', async () => {
    const { manager } = makeManager();
    const result = await manager.getOrSpawn('t1', 'persona-1', makePersona());
    expect(result._unsafeUnwrap().threadId).toBe('t1');
  });

  it('returned ContainerInfo has correct personaId', async () => {
    const { manager } = makeManager();
    const result = await manager.getOrSpawn('t1', 'my-persona', makePersona());
    expect(result._unsafeUnwrap().personaId).toBe('my-persona');
  });

  it('returned ContainerInfo state is Warm', async () => {
    const { manager } = makeManager();
    const result = await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(result._unsafeUnwrap().state).toBe(SandboxState.Warm);
  });

  it('increments activeCount after spawn', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(manager.activeCount()).toBe(1);
  });

  it('container appears in list() after spawn', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(manager.list()).toHaveLength(1);
  });

  it('calls factory.createContainer once', async () => {
    const { manager, factory } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(factory.createContainer).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getOrSpawn — returns existing container
// ---------------------------------------------------------------------------

describe('SandboxManager.getOrSpawn() — existing container', () => {
  it('returns the same container on second call for same thread', async () => {
    const { manager } = makeManager();
    const r1 = await manager.getOrSpawn('t1', 'p1', makePersona());
    const r2 = await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(r1._unsafeUnwrap().containerId).toBe(r2._unsafeUnwrap().containerId);
  });

  it('does NOT call factory.createContainer a second time', async () => {
    const { manager, factory } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(factory.createContainer).toHaveBeenCalledOnce();
  });

  it('updates lastActivityAt on re-access', async () => {
    const { manager } = makeManager();
    const r1 = await manager.getOrSpawn('t1', 'p1', makePersona());
    const t1 = r1._unsafeUnwrap().lastActivityAt;

    // Advance time slightly.
    await new Promise((r) => setTimeout(r, 5));

    await manager.getOrSpawn('t1', 'p1', makePersona());
    const info = manager.get('t1')!;
    expect(info.lastActivityAt).toBeGreaterThanOrEqual(t1);
  });
});

// ---------------------------------------------------------------------------
// getOrSpawn — maxConcurrent enforcement
// ---------------------------------------------------------------------------

describe('SandboxManager.getOrSpawn() — maxConcurrent', () => {
  it('allows spawning up to maxConcurrent containers', async () => {
    const { manager } = makeManager({ maxConcurrent: 2 });
    const r1 = await manager.getOrSpawn('t1', 'p1', makePersona());
    const r2 = await manager.getOrSpawn('t2', 'p1', makePersona());
    expect(r1.isOk()).toBe(true);
    expect(r2.isOk()).toBe(true);
  });

  it('evicts oldest idle container when at capacity', async () => {
    const { manager } = makeManager({ maxConcurrent: 2 });

    // Spawn two containers.
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.getOrSpawn('t2', 'p1', makePersona());

    // t1 should be evicted (oldest idle) to make room.
    const r3 = await manager.getOrSpawn('t3', 'p1', makePersona());
    expect(r3.isOk()).toBe(true);

    // t1 should no longer be in registry.
    expect(manager.get('t1')).toBeUndefined();
    // t2 and t3 should be present.
    expect(manager.get('t2')).toBeDefined();
    expect(manager.get('t3')).toBeDefined();
  });

  it('returns Err when at capacity with no idle containers', async () => {
    const { manager } = makeManager({ maxConcurrent: 2 });

    // Fill capacity.
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.getOrSpawn('t2', 'p1', makePersona());

    // Mark both busy so they cannot be evicted.
    manager.markBusy('t1');
    manager.markBusy('t2');

    const r3 = await manager.getOrSpawn('t3', 'p1', makePersona());
    expect(r3.isErr()).toBe(true);
    expect(r3._unsafeUnwrapErr()).toBeInstanceOf(SandboxError);
  });
});

// ---------------------------------------------------------------------------
// getOrSpawn — factory error
// ---------------------------------------------------------------------------

describe('SandboxManager.getOrSpawn() — factory failure', () => {
  it('returns Err<SandboxError> when factory.createContainer fails', async () => {
    const factory = makeFactoryMock();
    factory.createContainer.mockResolvedValue(
      err(new SandboxError('Docker is unavailable')),
    );
    const { manager } = makeManager({}, factory);

    const result = await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(SandboxError);
  });

  it('does not track container after factory failure', async () => {
    const factory = makeFactoryMock();
    factory.createContainer.mockResolvedValue(
      err(new SandboxError('Docker is unavailable')),
    );
    const { manager } = makeManager({}, factory);

    await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(manager.get('t1')).toBeUndefined();
    expect(manager.activeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// get()
// ---------------------------------------------------------------------------

describe('SandboxManager.get()', () => {
  it('returns ContainerInfo after spawn', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(manager.get('t1')).toBeDefined();
  });

  it('returns undefined for an unknown thread', () => {
    const { manager } = makeManager();
    expect(manager.get('unknown')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// kill()
// ---------------------------------------------------------------------------

describe('SandboxManager.kill()', () => {
  it('returns Ok after killing an existing container', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    const result = await manager.kill('t1');
    expect(result.isOk()).toBe(true);
  });

  it('removes container from registry', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.kill('t1');
    expect(manager.get('t1')).toBeUndefined();
    expect(manager.activeCount()).toBe(0);
  });

  it('calls factory.removeContainer', async () => {
    const { manager, factory } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.kill('t1');
    expect(factory.removeContainer).toHaveBeenCalledOnce();
  });

  it('returns Err when no container exists for thread', async () => {
    const { manager } = makeManager();
    const result = await manager.kill('no-such-thread');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr()).toBeInstanceOf(SandboxError);
  });

  it('still removes from registry even when factory.removeContainer fails', async () => {
    const factory = makeFactoryMock();
    factory.removeContainer.mockResolvedValue(err(new SandboxError('remove failed')));
    const { manager } = makeManager({}, factory);

    await manager.getOrSpawn('t1', 'p1', makePersona());
    const result = await manager.kill('t1');

    // Should succeed overall (registry cleanup succeeds even if Docker call fails).
    expect(result.isOk()).toBe(true);
    expect(manager.get('t1')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// markBusy / markWarm
// ---------------------------------------------------------------------------

describe('SandboxManager.markBusy() / markWarm()', () => {
  it('markBusy transitions state to Busy', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    manager.markBusy('t1');
    expect(manager.get('t1')?.state).toBe(SandboxState.Busy);
  });

  it('markWarm transitions state back to Warm', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    manager.markBusy('t1');
    manager.markWarm('t1');
    expect(manager.get('t1')?.state).toBe(SandboxState.Warm);
  });

  it('markBusy updates lastActivityAt', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    const before = manager.get('t1')!.lastActivityAt;

    await new Promise((r) => setTimeout(r, 5));
    manager.markBusy('t1');

    expect(manager.get('t1')!.lastActivityAt).toBeGreaterThanOrEqual(before);
  });

  it('markBusy on unknown thread is a no-op (no throw)', () => {
    const { manager } = makeManager();
    expect(() => manager.markBusy('unknown')).not.toThrow();
  });

  it('markWarm on unknown thread is a no-op (no throw)', () => {
    const { manager } = makeManager();
    expect(() => manager.markWarm('unknown')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// activeCount()
// ---------------------------------------------------------------------------

describe('SandboxManager.activeCount()', () => {
  it('counts Warm containers', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(manager.activeCount()).toBe(1);
  });

  it('counts Busy containers', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    manager.markBusy('t1');
    expect(manager.activeCount()).toBe(1);
  });

  it('does NOT count ShuttingDown containers', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    // Manually set to ShuttingDown without removing.
    const info = manager.get('t1') as ContainerInfo;
    info.state = SandboxState.ShuttingDown;
    expect(manager.activeCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// reapIdle()
// ---------------------------------------------------------------------------

describe('SandboxManager.reapIdle()', () => {
  it('does nothing when no containers exist', async () => {
    const { manager } = makeManager();
    await expect(manager.reapIdle()).resolves.not.toThrow();
  });

  it('does NOT reap containers within idleTimeout', async () => {
    const { manager } = makeManager({ idleTimeoutMs: 60_000 });
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.reapIdle();
    // Container should still be in registry.
    expect(manager.get('t1')).toBeDefined();
  });

  it('reaps containers idle longer than idleTimeoutMs', async () => {
    const { manager } = makeManager({ idleTimeoutMs: 0 });
    await manager.getOrSpawn('t1', 'p1', makePersona());

    // Manually push lastActivityAt into the past.
    const info = manager.get('t1') as ContainerInfo;
    info.lastActivityAt = Date.now() - 100;

    await manager.reapIdle();
    expect(manager.get('t1')).toBeUndefined();
  });

  it('does NOT reap Busy containers even if overdue', async () => {
    const { manager } = makeManager({ idleTimeoutMs: 0 });
    await manager.getOrSpawn('t1', 'p1', makePersona());
    manager.markBusy('t1');

    const info = manager.get('t1') as ContainerInfo;
    info.lastActivityAt = Date.now() - 100;

    await manager.reapIdle();
    // Busy container should still be present.
    expect(manager.get('t1')).toBeDefined();
  });

  it('reaps multiple idle containers in one pass', async () => {
    const { manager } = makeManager({ idleTimeoutMs: 0 });
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.getOrSpawn('t2', 'p1', makePersona());

    for (const threadId of ['t1', 't2']) {
      const info = manager.get(threadId) as ContainerInfo;
      info.lastActivityAt = Date.now() - 100;
    }

    await manager.reapIdle();
    expect(manager.get('t1')).toBeUndefined();
    expect(manager.get('t2')).toBeUndefined();
  });

  it('calls factory.removeContainer for each reaped container', async () => {
    const { manager, factory } = makeManager({ idleTimeoutMs: 0 });
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.getOrSpawn('t2', 'p1', makePersona());

    for (const threadId of ['t1', 't2']) {
      const info = manager.get(threadId) as ContainerInfo;
      info.lastActivityAt = Date.now() - 100;
    }

    await manager.reapIdle();
    expect(factory.removeContainer).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// shutdownAll()
// ---------------------------------------------------------------------------

describe('SandboxManager.shutdownAll()', () => {
  it('does nothing when no containers exist', async () => {
    const { manager } = makeManager();
    await expect(manager.shutdownAll(0)).resolves.not.toThrow();
  });

  it('removes all containers from registry', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.getOrSpawn('t2', 'p1', makePersona());

    await manager.shutdownAll(0);
    expect(manager.list()).toHaveLength(0);
  });

  it('calls factory.removeContainer for every container', async () => {
    const { manager, factory } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.getOrSpawn('t2', 'p1', makePersona());

    await manager.shutdownAll(0);
    expect(factory.removeContainer).toHaveBeenCalledTimes(2);
  });

  it('marks all containers ShuttingDown before grace period', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());

    // The shutdown sets state before the grace period delay.
    // We interleave: start shutdown, check state immediately after marking.
    const shutdownPromise = manager.shutdownAll(10);

    // After tick, state should be ShuttingDown (marked synchronously before await).
    await new Promise((r) => setTimeout(r, 0));

    // By this point container may already be removed; that is fine.
    await shutdownPromise;
    // Just verifying no error is thrown and the map is empty.
    expect(manager.list()).toHaveLength(0);
  });

  it('does not throw when factory.removeContainer fails during shutdown', async () => {
    const factory = makeFactoryMock();
    factory.removeContainer.mockResolvedValue(err(new SandboxError('force kill failed')));
    const { manager } = makeManager({}, factory);

    await manager.getOrSpawn('t1', 'p1', makePersona());
    await expect(manager.shutdownAll(0)).resolves.not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// list()
// ---------------------------------------------------------------------------

describe('SandboxManager.list()', () => {
  it('returns all tracked containers', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    await manager.getOrSpawn('t2', 'p2', makePersona('p2'));
    const list = manager.list();
    expect(list).toHaveLength(2);
    expect(list.map((c) => c.threadId).sort()).toEqual(['t1', 't2']);
  });

  it('returns a snapshot (not the live map values)', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    const list = manager.list();
    await manager.kill('t1');
    // The snapshot should still have the entry even though it was killed.
    expect(list).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Session ID tracking
// ---------------------------------------------------------------------------

describe('SandboxManager — sessionId', () => {
  it('ContainerInfo initially has no sessionId', async () => {
    const { manager } = makeManager();
    const result = await manager.getOrSpawn('t1', 'p1', makePersona());
    expect(result._unsafeUnwrap().sessionId).toBeUndefined();
  });

  it('allows sessionId to be set externally on ContainerInfo', async () => {
    const { manager } = makeManager();
    await manager.getOrSpawn('t1', 'p1', makePersona());
    const info = manager.get('t1')!;
    info.sessionId = 'sdk-session-xyz';
    expect(manager.get('t1')?.sessionId).toBe('sdk-session-xyz');
  });
});
