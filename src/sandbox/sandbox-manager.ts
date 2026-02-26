/**
 * Sandbox manager — Docker container lifecycle orchestration.
 *
 * Owns the map of threadId -> ContainerInfo and is the single authority for
 * container state transitions.  The manager enforces:
 *  - maxConcurrent limit (evicts oldest-idle first when at capacity)
 *  - Idle reaping (containers idle longer than idleTimeoutMs are killed)
 *  - Graceful shutdown (SIGTERM -> grace period -> SIGKILL)
 *
 * All mutations go through this class; ContainerFactory is a pure creation
 * helper with no state of its own.
 */

import type pino from 'pino';
import { ok, err, type Result } from 'neverthrow';
import { SandboxError } from '../core/errors/index.js';
import type { ContainerFactory } from './container-factory.js';
import type { PersonaConfig } from '../core/config/index.js';
import { SandboxState, type ContainerInfo, type SandboxConfig } from './sandbox-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default grace period (ms) given to containers before force-kill. */
const DEFAULT_SHUTDOWN_GRACE_MS = 10_000;

// ---------------------------------------------------------------------------
// SandboxManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of Docker sandbox containers for all active threads.
 *
 * One container per thread. Containers are kept warm between agent runs to
 * amortise startup latency.
 */
export class SandboxManager {
  /** Live container registry: threadId -> ContainerInfo */
  private readonly containers: Map<string, ContainerInfo> = new Map();

  /**
   * @param factory  - Container creation/removal helper.
   * @param config   - Sandbox configuration (limits, timeouts, image).
   * @param dataDir  - Host data directory root used for default mount paths.
   * @param logger   - Structured logger (pino).
   */
  constructor(
    private readonly factory: ContainerFactory,
    private readonly config: SandboxConfig,
    private readonly dataDir: string,
    private readonly logger: pino.Logger,
  ) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return an existing warm container for `threadId`, or spawn a new one.
   *
   * If the container exists but is Busy or Spawning it is returned as-is;
   * the caller is responsible for queuing work appropriately.
   *
   * When at capacity the manager attempts to evict the oldest idle container
   * before spawning.  If no idle container is available the call fails with
   * SandboxError.
   *
   * @param threadId  - Thread to get/spawn a container for.
   * @param personaId - Persona driving this thread (stored on ContainerInfo).
   * @param persona   - Full persona config used for mount resolution.
   * @returns Ok<ContainerInfo> or Err<SandboxError>.
   */
  async getOrSpawn(
    threadId: string,
    personaId: string,
    persona: PersonaConfig,
  ): Promise<Result<ContainerInfo, SandboxError>> {
    const existing = this.containers.get(threadId);
    if (existing) {
      existing.lastActivityAt = Date.now();
      return ok(existing);
    }

    // Enforce maxConcurrent.
    if (this.activeCount() >= this.config.maxConcurrent) {
      const evicted = await this.evictOldestIdle();
      if (!evicted) {
        return err(
          new SandboxError(
            `maxConcurrent limit (${this.config.maxConcurrent}) reached and no idle container available to evict`,
          ),
        );
      }
    }

    return this.spawn(threadId, personaId, persona);
  }

  /**
   * Get the ContainerInfo for a thread without spawning.
   *
   * @param threadId - Thread to look up.
   * @returns The ContainerInfo or undefined if no container exists.
   */
  get(threadId: string): ContainerInfo | undefined {
    return this.containers.get(threadId);
  }

  /**
   * Return a snapshot of all tracked containers.
   */
  list(): ContainerInfo[] {
    return Array.from(this.containers.values());
  }

  /**
   * Force-kill and remove the container for a thread.
   *
   * Transitions the container to ShuttingDown, removes it from Docker,
   * then removes it from the registry.
   *
   * @param threadId - Thread whose container should be killed.
   * @returns Ok<void> or Err<SandboxError>.
   */
  async kill(threadId: string): Promise<Result<void, SandboxError>> {
    const info = this.containers.get(threadId);
    if (!info) {
      return err(new SandboxError(`No container found for thread ${threadId}`));
    }

    info.state = SandboxState.ShuttingDown;
    this.logger.info({ threadId, containerId: info.containerId }, 'Killing container');

    const result = await this.factory.removeContainer(info.containerId);
    this.containers.delete(threadId);

    if (result.isErr()) {
      this.logger.warn(
        { threadId, containerId: info.containerId, err: result.error.message },
        'Container removal failed (already cleaned up?)',
      );
      // Still return ok — the container is no longer tracked regardless.
      return ok(undefined);
    }

    return ok(undefined);
  }

  /**
   * Mark a container as Busy (run in progress).
   *
   * Updates lastActivityAt so the idle reaper does not reclaim an active
   * container.
   *
   * @param threadId - Thread whose container should be marked busy.
   */
  markBusy(threadId: string): void {
    const info = this.containers.get(threadId);
    if (info) {
      info.state = SandboxState.Busy;
      info.lastActivityAt = Date.now();
    }
  }

  /**
   * Mark a container as Warm (idle, ready for a new run).
   *
   * @param threadId - Thread whose container should be marked warm.
   */
  markWarm(threadId: string): void {
    const info = this.containers.get(threadId);
    if (info) {
      info.state = SandboxState.Warm;
      info.lastActivityAt = Date.now();
    }
  }

  /**
   * Reap containers that have been idle longer than `idleTimeoutMs`.
   *
   * Intended to be called on a periodic timer (e.g. every 10 seconds).
   * Only Warm containers are eligible for reaping; Busy containers are
   * considered active even if their lastActivityAt is stale.
   */
  async reapIdle(): Promise<void> {
    const now = Date.now();
    const toReap: string[] = [];

    for (const [threadId, info] of this.containers) {
      if (
        info.state === SandboxState.Warm &&
        now - info.lastActivityAt > this.config.idleTimeoutMs
      ) {
        toReap.push(threadId);
      }
    }

    for (const threadId of toReap) {
      this.logger.info({ threadId }, 'Reaping idle container');
      await this.kill(threadId);
    }
  }

  /**
   * Gracefully shut down all tracked containers.
   *
   * Sends SIGTERM to all containers, waits `gracePeriodMs`, then force-kills
   * any that are still tracked.
   *
   * @param gracePeriodMs - Time to wait between SIGTERM and force removal.
   *                        Defaults to 10 000 ms.
   */
  async shutdownAll(gracePeriodMs: number = DEFAULT_SHUTDOWN_GRACE_MS): Promise<void> {
    const threadIds = Array.from(this.containers.keys());
    if (threadIds.length === 0) return;

    this.logger.info({ count: threadIds.length }, 'Shutting down all sandbox containers');

    // Mark all as shutting down first so no new work is dispatched.
    for (const threadId of threadIds) {
      const info = this.containers.get(threadId);
      if (info) {
        info.state = SandboxState.ShuttingDown;
      }
    }

    // Give containers a chance to finish gracefully.
    await new Promise<void>((resolve) => setTimeout(resolve, gracePeriodMs));

    // Force-kill remaining containers in parallel.
    const kills = threadIds.map((threadId) => this.kill(threadId));
    await Promise.allSettled(kills);
  }

  /**
   * Count containers that are not shutting down.
   *
   * Used to enforce maxConcurrent.
   */
  activeCount(): number {
    let count = 0;
    for (const info of this.containers.values()) {
      if (info.state !== SandboxState.ShuttingDown) {
        count++;
      }
    }
    return count;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Spawn a new container for `threadId`.
   *
   * Registers the container in state Spawning before the Docker call, then
   * transitions to Warm on success or removes the entry on failure.
   */
  private async spawn(
    threadId: string,
    personaId: string,
    persona: PersonaConfig,
  ): Promise<Result<ContainerInfo, SandboxError>> {
    const now = Date.now();

    // Register a placeholder so concurrent callers see the thread as active.
    const placeholder: ContainerInfo = {
      containerId: '',
      threadId,
      personaId,
      state: SandboxState.Spawning,
      createdAt: now,
      lastActivityAt: now,
    };
    this.containers.set(threadId, placeholder);

    this.logger.info({ threadId, personaId, image: this.config.image }, 'Spawning container');

    const personaDescriptor = {
      id: personaId,
      mounts: persona.mounts as Array<{ source: string; target: string; mode: 'ro' | 'rw' }>,
    };

    const result = await this.factory.createContainer(
      this.config,
      threadId,
      personaDescriptor,
      this.dataDir,
    );

    if (result.isErr()) {
      // Clean up placeholder on failure.
      this.containers.delete(threadId);
      this.logger.error(
        { threadId, err: result.error.message },
        'Container spawn failed',
      );
      return err(result.error);
    }

    const container = result.value;
    const containerInspect = await container.inspect().catch(() => null);
    const containerId = containerInspect?.Id ?? container.id;

    const info: ContainerInfo = {
      containerId,
      threadId,
      personaId,
      state: SandboxState.Warm,
      createdAt: now,
      lastActivityAt: now,
    };

    this.containers.set(threadId, info);
    this.logger.info({ threadId, containerId }, 'Container spawned and warm');

    return ok(info);
  }

  /**
   * Find and kill the warm container that has been idle the longest.
   *
   * @returns true if a container was evicted, false if none were eligible.
   */
  private async evictOldestIdle(): Promise<boolean> {
    let oldest: ContainerInfo | null = null;
    let oldestTime = Infinity;

    for (const info of this.containers.values()) {
      if (info.state === SandboxState.Warm && info.lastActivityAt < oldestTime) {
        oldest = info;
        oldestTime = info.lastActivityAt;
      }
    }

    if (!oldest) return false;

    this.logger.info(
      { threadId: oldest.threadId, idleMs: Date.now() - oldest.lastActivityAt },
      'Evicting oldest idle container to make room',
    );

    await this.kill(oldest.threadId);
    return true;
  }
}
