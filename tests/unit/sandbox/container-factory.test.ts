/**
 * Unit tests for ContainerFactory.
 *
 * All Dockerode interactions are mocked; no real Docker socket is required.
 * Tests verify the correct Docker API options are passed with security
 * hardening, resource limits, mounts, and network configuration.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { ContainerFactory, buildBinds, resolveMountSource, defaultMounts, TMP_SIZE } from '../../../src/sandbox/container-factory.js';
import type { SandboxConfig, MountConfig } from '../../../src/sandbox/sandbox-types.js';

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
    resourceLimits: {
      memoryMb: 512,
      cpus: 0.5,
      pidsLimit: 128,
    },
    ...overrides,
  };
}

/** Build a mock ContainerFactory with an injectable Dockerode mock. */
function makeFactory(dockerMock: object): ContainerFactory {
  const factory = new ContainerFactory('/var/run/docker.sock');
  // Replace the internal docker instance with our mock.
  (factory as unknown as { docker: object }).docker = dockerMock;
  return factory;
}

// ---------------------------------------------------------------------------
// resolveMountSource
// ---------------------------------------------------------------------------

describe('resolveMountSource()', () => {
  it('replaces {thread} with the actual thread ID', () => {
    expect(resolveMountSource('/data/threads/{thread}/memory', 'thread-42')).toBe(
      '/data/threads/thread-42/memory',
    );
  });

  it('replaces multiple {thread} occurrences', () => {
    expect(resolveMountSource('{thread}/a/{thread}/b', 'T1')).toBe(require('path').resolve('T1/a/T1/b'));
  });

  it('returns source unchanged when no token present', () => {
    expect(resolveMountSource('/fixed/path', 'T1')).toBe('/fixed/path');
  });
});

// ---------------------------------------------------------------------------
// buildBinds
// ---------------------------------------------------------------------------

describe('buildBinds()', () => {
  it('returns host:container:mode strings', () => {
    const mounts: MountConfig[] = [
      { source: '/host/a', target: '/a', mode: 'ro' },
      { source: '/host/b', target: '/b', mode: 'rw' },
    ];
    expect(buildBinds(mounts, 'thread-1')).toEqual(['/host/a:/a:ro', '/host/b:/b:rw']);
  });

  it('resolves {thread} tokens in source paths', () => {
    const mounts: MountConfig[] = [
      { source: '/data/{thread}/memory', target: '/memory', mode: 'ro' },
    ];
    expect(buildBinds(mounts, 'mythread')).toEqual(['/data/mythread/memory:/memory:ro']);
  });

  it('returns empty array for empty mounts', () => {
    expect(buildBinds([], 'any')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// defaultMounts
// ---------------------------------------------------------------------------

describe('defaultMounts()', () => {
  it('returns three entries for memory, artifacts, ipc', () => {
    const mounts = defaultMounts('/data', 'thread-X');
    expect(mounts).toHaveLength(3);
    expect(mounts.map((m) => m.target)).toEqual(['/memory', '/artifacts', '/ipc']);
  });

  it('memory mount is read-only', () => {
    const [memory] = defaultMounts('/data', 'T');
    expect(memory.mode).toBe('ro');
  });

  it('artifacts and ipc mounts are read-write', () => {
    const [, artifacts, ipc] = defaultMounts('/data', 'T');
    expect(artifacts.mode).toBe('rw');
    expect(ipc.mode).toBe('rw');
  });

  it('embeds thread ID in source paths', () => {
    const mounts = defaultMounts('/data', 'thread-99');
    expect(mounts.every((m) => m.source.includes('thread-99'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ContainerFactory.createContainer
// ---------------------------------------------------------------------------

describe('ContainerFactory.createContainer()', () => {
  let startMock: Mock;
  let createContainerMock: Mock;
  let dockerMock: object;

  beforeEach(() => {
    startMock = vi.fn().mockResolvedValue(undefined);
    const mockContainer = {
      id: 'mock-container-id-abc123',
      start: startMock,
      inspect: vi.fn().mockResolvedValue({ Id: 'mock-container-id-abc123', State: { Running: true } }),
    };
    createContainerMock = vi.fn().mockResolvedValue(mockContainer);
    dockerMock = { createContainer: createContainerMock };
  });

  it('returns Ok with a container on success', async () => {
    const factory = makeFactory(dockerMock);
    const result = await factory.createContainer(
      makeSandboxConfig(),
      'thread-1',
      { id: 'persona-1', mounts: [] },
      '/data',
    );
    expect(result.isOk()).toBe(true);
  });

  it('calls docker.createContainer once', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(makeSandboxConfig(), 'thread-1', { id: 'p1', mounts: [] }, '/data');
    expect(createContainerMock).toHaveBeenCalledOnce();
  });

  it('starts the container after creating it', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(makeSandboxConfig(), 'thread-1', { id: 'p1', mounts: [] }, '/data');
    expect(startMock).toHaveBeenCalledOnce();
  });

  it('uses sleep infinity as the container command', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(makeSandboxConfig(), 't1', { id: 'p1', mounts: [] }, '/data');
    const opts = createContainerMock.mock.calls[0][0] as { Cmd: string[] };
    expect(opts.Cmd).toEqual(['sleep', 'infinity']);
  });

  // -------------------------------------------------------------------------
  // Security hardening
  // -------------------------------------------------------------------------

  it('drops ALL capabilities', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(makeSandboxConfig(), 't1', { id: 'p1', mounts: [] }, '/data');
    const opts = createContainerMock.mock.calls[0][0] as { HostConfig: { CapDrop: string[] } };
    expect(opts.HostConfig.CapDrop).toEqual(['ALL']);
  });

  it('sets ReadonlyRootfs to true', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(makeSandboxConfig(), 't1', { id: 'p1', mounts: [] }, '/data');
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { ReadonlyRootfs: boolean };
    };
    expect(opts.HostConfig.ReadonlyRootfs).toBe(true);
  });

  it('mounts /tmp as tmpfs with noexec,nosuid', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(makeSandboxConfig(), 't1', { id: 'p1', mounts: [] }, '/data');
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { Tmpfs: Record<string, string> };
    };
    expect(opts.HostConfig.Tmpfs['/tmp']).toContain('noexec');
    expect(opts.HostConfig.Tmpfs['/tmp']).toContain('nosuid');
    expect(opts.HostConfig.Tmpfs['/tmp']).toContain(TMP_SIZE);
  });

  it('sets SecurityOpt no-new-privileges', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(makeSandboxConfig(), 't1', { id: 'p1', mounts: [] }, '/data');
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { SecurityOpt: string[] };
    };
    expect(opts.HostConfig.SecurityOpt).toContain('no-new-privileges:true');
  });

  // -------------------------------------------------------------------------
  // Network
  // -------------------------------------------------------------------------

  it('sets NetworkMode to none when networkDefault is off', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(
      makeSandboxConfig({ networkDefault: 'off' }),
      't1',
      { id: 'p1', mounts: [] },
      '/data',
    );
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { NetworkMode: string };
    };
    expect(opts.HostConfig.NetworkMode).toBe('none');
  });

  it('sets NetworkMode to bridge when networkDefault is on', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(
      makeSandboxConfig({ networkDefault: 'on' }),
      't1',
      { id: 'p1', mounts: [] },
      '/data',
    );
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { NetworkMode: string };
    };
    expect(opts.HostConfig.NetworkMode).toBe('bridge');
  });

  // -------------------------------------------------------------------------
  // Resource limits
  // -------------------------------------------------------------------------

  it('converts memoryMb to bytes', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(
      makeSandboxConfig({ resourceLimits: { memoryMb: 512, cpus: 1, pidsLimit: 100 } }),
      't1',
      { id: 'p1', mounts: [] },
      '/data',
    );
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { Memory: number };
    };
    expect(opts.HostConfig.Memory).toBe(512 * 1024 * 1024);
  });

  it('converts cpus to CpuQuota (microseconds per 100ms period)', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(
      makeSandboxConfig({ resourceLimits: { memoryMb: 512, cpus: 0.5, pidsLimit: 100 } }),
      't1',
      { id: 'p1', mounts: [] },
      '/data',
    );
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { CpuQuota: number; CpuPeriod: number };
    };
    // 0.5 cpus * 100_000 µs period = 50_000 µs quota
    expect(opts.HostConfig.CpuQuota).toBe(50_000);
    expect(opts.HostConfig.CpuPeriod).toBe(100_000);
  });

  it('sets PidsLimit from config', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(
      makeSandboxConfig({ resourceLimits: { memoryMb: 256, cpus: 1, pidsLimit: 64 } }),
      't1',
      { id: 'p1', mounts: [] },
      '/data',
    );
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { PidsLimit: number };
    };
    expect(opts.HostConfig.PidsLimit).toBe(64);
  });

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  it('applies talon labels', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(
      makeSandboxConfig(),
      'thread-abc',
      { id: 'persona-xyz', mounts: [] },
      '/data',
    );
    const opts = createContainerMock.mock.calls[0][0] as {
      Labels: Record<string, string>;
    };
    expect(opts.Labels['talon.managed']).toBe('true');
    expect(opts.Labels['talon.thread']).toBe('thread-abc');
    expect(opts.Labels['talon.persona']).toBe('persona-xyz');
  });

  // -------------------------------------------------------------------------
  // Mounts
  // -------------------------------------------------------------------------

  it('includes default mounts (memory, artifacts, ipc)', async () => {
    const factory = makeFactory(dockerMock);
    await factory.createContainer(makeSandboxConfig(), 'thread-1', { id: 'p1', mounts: [] }, '/data');
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { Binds: string[] };
    };
    const binds = opts.HostConfig.Binds;
    expect(binds.some((b) => b.includes('/memory'))).toBe(true);
    expect(binds.some((b) => b.includes('/artifacts'))).toBe(true);
    expect(binds.some((b) => b.includes('/ipc'))).toBe(true);
  });

  it('appends persona mounts after default mounts', async () => {
    const factory = makeFactory(dockerMock);
    const personaMounts: MountConfig[] = [{ source: '/extra/host', target: '/extra', mode: 'ro' }];
    await factory.createContainer(
      makeSandboxConfig(),
      'thread-1',
      { id: 'p1', mounts: personaMounts },
      '/data',
    );
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { Binds: string[] };
    };
    expect(opts.HostConfig.Binds).toContain('/extra/host:/extra:ro');
  });

  it('resolves {thread} tokens in persona mount sources', async () => {
    const factory = makeFactory(dockerMock);
    const personaMounts: MountConfig[] = [
      { source: '/shared/{thread}/data', target: '/shared', mode: 'rw' },
    ];
    await factory.createContainer(
      makeSandboxConfig(),
      'thread-99',
      { id: 'p1', mounts: personaMounts },
      '/data',
    );
    const opts = createContainerMock.mock.calls[0][0] as {
      HostConfig: { Binds: string[] };
    };
    expect(opts.HostConfig.Binds).toContain('/shared/thread-99/data:/shared:rw');
  });

  // -------------------------------------------------------------------------
  // Error handling
  // -------------------------------------------------------------------------

  it('returns Err<SandboxError> when docker.createContainer throws', async () => {
    const failingDocker = {
      createContainer: vi.fn().mockRejectedValue(new Error('Docker daemon unavailable')),
    };
    const factory = makeFactory(failingDocker);
    const result = await factory.createContainer(
      makeSandboxConfig(),
      'thread-1',
      { id: 'p1', mounts: [] },
      '/data',
    );
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('Docker daemon unavailable');
  });

  it('returns Err<SandboxError> when container.start() throws', async () => {
    const failStart = vi.fn().mockRejectedValue(new Error('start failed'));
    const mockContainer = {
      id: 'cid',
      start: failStart,
      inspect: vi.fn().mockResolvedValue({ Id: 'cid', State: { Running: false } }),
    };
    const failingDocker = { createContainer: vi.fn().mockResolvedValue(mockContainer) };
    const factory = makeFactory(failingDocker);
    const result = await factory.createContainer(
      makeSandboxConfig(),
      'thread-1',
      { id: 'p1', mounts: [] },
      '/data',
    );
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ContainerFactory.removeContainer
// ---------------------------------------------------------------------------

describe('ContainerFactory.removeContainer()', () => {
  it('returns Ok on successful removal', async () => {
    const removeMock = vi.fn().mockResolvedValue(undefined);
    const dockerMock = {
      getContainer: vi.fn().mockReturnValue({ remove: removeMock }),
    };
    const factory = makeFactory(dockerMock);
    const result = await factory.removeContainer('some-container-id');
    expect(result.isOk()).toBe(true);
    expect(removeMock).toHaveBeenCalledWith({ force: true });
  });

  it('returns Err<SandboxError> when removal fails', async () => {
    const dockerMock = {
      getContainer: vi.fn().mockReturnValue({
        remove: vi.fn().mockRejectedValue(new Error('removal failed')),
      }),
    };
    const factory = makeFactory(dockerMock);
    const result = await factory.removeContainer('bad-id');
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('bad-id');
  });
});

// ---------------------------------------------------------------------------
// ContainerFactory.isRunning
// ---------------------------------------------------------------------------

describe('ContainerFactory.isRunning()', () => {
  it('returns Ok<true> when container State.Running is true', async () => {
    const dockerMock = {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ State: { Running: true } }),
      }),
    };
    const factory = makeFactory(dockerMock);
    const result = await factory.isRunning('cid');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(true);
  });

  it('returns Ok<false> when container State.Running is false', async () => {
    const dockerMock = {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockResolvedValue({ State: { Running: false } }),
      }),
    };
    const factory = makeFactory(dockerMock);
    const result = await factory.isRunning('cid');
    expect(result._unsafeUnwrap()).toBe(false);
  });

  it('returns Ok<false> on 404 (container gone)', async () => {
    const notFoundError = Object.assign(new Error('Not found'), { statusCode: 404 });
    const dockerMock = {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockRejectedValue(notFoundError),
      }),
    };
    const factory = makeFactory(dockerMock);
    const result = await factory.isRunning('cid');
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBe(false);
  });

  it('returns Err<SandboxError> on unexpected API errors', async () => {
    const dockerMock = {
      getContainer: vi.fn().mockReturnValue({
        inspect: vi.fn().mockRejectedValue(new Error('daemon crashed')),
      }),
    };
    const factory = makeFactory(dockerMock);
    const result = await factory.isRunning('cid');
    expect(result.isErr()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ContainerFactory.extractPersonaDescriptor
// ---------------------------------------------------------------------------

describe('ContainerFactory.extractPersonaDescriptor()', () => {
  it('returns id equal to persona name', () => {
    const persona = {
      name: 'alfred',
      model: 'claude-sonnet-4-6',
      skills: [],
      capabilities: { allow: [], requireApproval: [] },
      mounts: [],
    };
    const desc = ContainerFactory.extractPersonaDescriptor(persona);
    expect(desc.id).toBe('alfred');
  });

  it('returns persona mounts', () => {
    const persona = {
      name: 'alfred',
      model: 'claude-sonnet-4-6',
      skills: [],
      capabilities: { allow: [], requireApproval: [] },
      mounts: [{ source: '/host/path', target: '/container/path', mode: 'ro' as const }],
    };
    const desc = ContainerFactory.extractPersonaDescriptor(persona);
    expect(desc.mounts).toHaveLength(1);
    expect(desc.mounts[0].target).toBe('/container/path');
  });
});
