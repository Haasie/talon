/**
 * Docker container factory with security hardening.
 *
 * Creates containers with a minimal, default-deny security posture:
 *  - All Linux capabilities dropped
 *  - Read-only root filesystem
 *  - Tmpfs for /tmp (no exec, no suid, size-capped)
 *  - No Docker socket bind-mount
 *  - Network disabled by default
 *  - Memory, CPU, and PID limits applied from config
 *
 * Secrets must be delivered via stdin JSON at exec time — never as environment
 * variables or mounted files written to the container filesystem.
 */

import Dockerode from 'dockerode';
import { ok, err, type Result } from 'neverthrow';
import { SandboxError } from '../core/errors/index.js';
import type { SandboxConfig, MountConfig } from './sandbox-types.js';
import type { PersonaConfig } from '../core/config/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Label applied to every managed container for external identification. */
const LABEL_MANAGED = 'talon.managed';
/** Label carrying the associated thread ID. */
const LABEL_THREAD = 'talon.thread';
/** Label carrying the associated persona ID. */
const LABEL_PERSONA = 'talon.persona';

/** Template token replaced with the actual thread ID in mount source paths. */
const THREAD_TOKEN = '{thread}';

/**
 * Default tmpfs size for /tmp.  Kept small to prevent sandbox abuse.
 * The spec says 100m; we expose this as a constant to make it testable.
 */
export const TMP_SIZE = '100m';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Resolve `{thread}` template tokens in a mount source path.
 *
 * @param source   - Raw source path from persona config, possibly containing `{thread}`.
 * @param threadId - Actual thread ID to substitute.
 * @returns Resolved host path.
 */
export function resolveMountSource(source: string, threadId: string): string {
  return source.split(THREAD_TOKEN).join(threadId);
}

/**
 * Build the Dockerode Binds array from a list of MountConfig objects.
 *
 * @param mounts   - Mount definitions (may contain `{thread}` tokens).
 * @param threadId - Thread ID used to resolve template tokens.
 * @returns Array of `host:container:mode` bind strings.
 */
export function buildBinds(mounts: MountConfig[], threadId: string): string[] {
  return mounts.map((m) => `${resolveMountSource(m.source, threadId)}:${m.target}:${m.mode}`);
}

/**
 * Derive the default mounts for a thread's data directory.
 *
 * The host exposes three directories per thread:
 *  - `memory/`    — read-only (agent reads its stored facts)
 *  - `artifacts/` — read-write (agent writes produced files)
 *  - `ipc/`       — read-write (file-based IPC with talond)
 *
 * @param dataDir  - Root data directory on the host (e.g. `data`).
 * @param threadId - Thread ID that forms the sub-path.
 * @returns Three MountConfig entries.
 */
export function defaultMounts(dataDir: string, threadId: string): MountConfig[] {
  const base = `${dataDir}/threads/${threadId}`;
  return [
    { source: `${base}/memory`, target: '/memory', mode: 'ro' },
    { source: `${base}/artifacts`, target: '/artifacts', mode: 'rw' },
    { source: `${base}/ipc`, target: '/ipc', mode: 'rw' },
  ];
}

// ---------------------------------------------------------------------------
// ContainerFactory
// ---------------------------------------------------------------------------

/**
 * Creates and manages Docker container instances for thread sandboxes.
 *
 * Each container is started with a long-lived `sleep infinity` command so that
 * agent processes can be `docker exec`'d into it on demand without the overhead
 * of a full container start per message.
 */
export class ContainerFactory {
  private readonly docker: Dockerode;

  /**
   * @param socketPath - Path to the Docker socket. Defaults to `/var/run/docker.sock`.
   */
  constructor(socketPath?: string) {
    this.docker = new Dockerode({ socketPath: socketPath ?? '/var/run/docker.sock' });
  }

  /**
   * Expose the underlying Dockerode client for health checks and exec.
   */
  getDocker(): Dockerode {
    return this.docker;
  }

  /**
   * Create and start a sandboxed Docker container for the given thread.
   *
   * Security guarantees applied at container creation:
   *  - `CapDrop: ['ALL']`         — zero Linux capabilities
   *  - `ReadonlyRootfs: true`     — immutable root filesystem
   *  - Tmpfs `/tmp`               — ephemeral writable scratch, no exec/suid
   *  - No Docker socket mount     — sandbox cannot manage containers
   *  - Network disabled unless persona policy enables it
   *  - Memory / CPU / PID limits from SandboxConfig
   *
   * @param config   - Sandbox configuration (image, limits, network policy).
   * @param threadId - Thread identifier; used in labels and mount paths.
   * @param persona  - Persona config providing ID and custom mounts.
   * @param dataDir  - Host data directory root for default mount paths.
   * @returns Ok<Container> on success, Err<SandboxError> on Docker API failure.
   */
  async createContainer(
    config: SandboxConfig,
    threadId: string,
    persona: { id: string; mounts: MountConfig[] },
    dataDir: string,
  ): Promise<Result<Dockerode.Container, SandboxError>> {
    try {
      // Combine default mounts with persona-specific mounts.
      // Persona mounts are appended after defaults so they can override.
      const allMounts: MountConfig[] = [
        ...defaultMounts(dataDir, threadId),
        ...persona.mounts,
      ];

      const binds = buildBinds(allMounts, threadId);

      const memoryBytes = config.resourceLimits.memoryMb * 1024 * 1024;
      // Docker CpuQuota is in microseconds per 100ms period.
      // cpus=1.0 => 100_000 µs, cpus=0.5 => 50_000 µs.
      const cpuQuota = Math.round(config.resourceLimits.cpus * 100_000);

      const container = await this.docker.createContainer({
        Image: config.image,
        // Keep the container alive; agent processes are exec'd in on demand.
        Cmd: ['sleep', 'infinity'],
        Labels: {
          [LABEL_MANAGED]: 'true',
          [LABEL_THREAD]: threadId,
          [LABEL_PERSONA]: persona.id,
        },
        HostConfig: {
          // Security hardening
          CapDrop: ['ALL'],
          ReadonlyRootfs: true,
          SecurityOpt: ['no-new-privileges:true'],
          Tmpfs: { '/tmp': `rw,noexec,nosuid,size=${TMP_SIZE}` },

          // Resource limits
          Memory: memoryBytes,
          CpuQuota: cpuQuota,
          CpuPeriod: 100_000,
          PidsLimit: config.resourceLimits.pidsLimit,

          // Network
          NetworkMode: config.networkDefault === 'off' ? 'none' : 'bridge',

          // Mounts
          Binds: binds,
        },
      });

      await container.start();

      return ok(container);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return err(
        new SandboxError(
          `Failed to create container for thread ${threadId}: ${cause.message}`,
          cause,
        ),
      );
    }
  }

  /**
   * Force-kill and remove a container by ID.
   *
   * Uses `force: true` so the kill works even if the container is not running.
   * Errors are swallowed and returned as Err to prevent cascading failures
   * during shutdown.
   *
   * @param containerId - Docker container ID to remove.
   * @returns Ok<void> on success, Err<SandboxError> on failure.
   */
  async removeContainer(containerId: string): Promise<Result<void, SandboxError>> {
    try {
      const container = this.docker.getContainer(containerId);
      await container.remove({ force: true });
      return ok(undefined);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      return err(
        new SandboxError(`Failed to remove container ${containerId}: ${cause.message}`, cause),
      );
    }
  }

  /**
   * Inspect a container to verify it is still running.
   *
   * @param containerId - Docker container ID to inspect.
   * @returns Ok<true> when running, Ok<false> when stopped/dead, Err on API error.
   */
  async isRunning(containerId: string): Promise<Result<boolean, SandboxError>> {
    try {
      const container = this.docker.getContainer(containerId);
      const info = await container.inspect();
      return ok(info.State.Running === true);
    } catch (error) {
      // 404 means the container no longer exists — treat as not running.
      if (error && typeof error === 'object' && 'statusCode' in error) {
        const statusCode = (error as { statusCode: number }).statusCode;
        if (statusCode === 404) {
          return ok(false);
        }
      }
      const cause = error instanceof Error ? error : new Error(String(error));
      return err(
        new SandboxError(`Failed to inspect container ${containerId}: ${cause.message}`, cause),
      );
    }
  }

  /**
   * Retrieve the PersonaConfig-compatible mounts from a PersonaConfig.
   *
   * Convenience helper so callers can pass a full PersonaConfig without
   * having to manually extract fields.
   *
   * @param persona - Full persona config object.
   * @returns Partial persona descriptor for createContainer.
   */
  static extractPersonaDescriptor(persona: PersonaConfig): { id: string; mounts: MountConfig[] } {
    return {
      id: persona.name, // personas use name as ID until DB integration
      mounts: persona.mounts as MountConfig[],
    };
  }
}
