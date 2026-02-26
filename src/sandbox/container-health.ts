/**
 * Container health monitoring.
 *
 * Periodically verifies that containers tracked by SandboxManager are still
 * running inside Docker.  Any container that has disappeared unexpectedly
 * (crashed, OOM-killed, manually removed) is removed from the registry so
 * a fresh one can be spawned on the next request.
 *
 * The check is intentionally lightweight — it calls `docker inspect` for each
 * tracked container and compares the Running flag.  It does NOT restart
 * containers automatically; that is the responsibility of the queue processor.
 */

import type Dockerode from 'dockerode';
import type pino from 'pino';
import type { SandboxManager } from './sandbox-manager.js';
import { SandboxState } from './sandbox-types.js';

// ---------------------------------------------------------------------------
// ContainerHealthMonitor
// ---------------------------------------------------------------------------

/**
 * Periodic health checker for managed Docker containers.
 *
 * Usage:
 * ```ts
 * const monitor = new ContainerHealthMonitor(logger);
 * // called every 30 seconds by the daemon lifecycle:
 * await monitor.checkHealth(sandboxManager, docker);
 * ```
 */
export class ContainerHealthMonitor {
  constructor(private readonly logger: pino.Logger) {}

  /**
   * Inspect all tracked containers and remove any that are no longer running.
   *
   * Containers in `ShuttingDown` state are skipped because their disappearance
   * is expected.  Containers in `Spawning` state are also skipped to avoid
   * a race with the creation path.
   *
   * @param manager - SandboxManager owning the container registry.
   * @param docker  - Dockerode client used for inspect calls.
   */
  async checkHealth(manager: SandboxManager, docker: Dockerode): Promise<void> {
    const containers = manager.list();

    for (const info of containers) {
      // Skip transient states.
      if (
        info.state === SandboxState.ShuttingDown ||
        info.state === SandboxState.Spawning
      ) {
        continue;
      }

      try {
        const containerObj = docker.getContainer(info.containerId);
        const inspectData = await containerObj.inspect();

        if (!inspectData.State.Running) {
          this.logger.warn(
            {
              threadId: info.threadId,
              containerId: info.containerId,
              exitCode: inspectData.State.ExitCode,
            },
            'Container found stopped; removing from registry',
          );
          // Best-effort kill clears the registry entry.
          await manager.kill(info.threadId);
        }
      } catch (error) {
        // 404 = container has already been removed from Docker.
        const isNotFound =
          error !== null &&
          typeof error === 'object' &&
          'statusCode' in error &&
          (error as { statusCode: number }).statusCode === 404;

        if (isNotFound) {
          this.logger.warn(
            { threadId: info.threadId, containerId: info.containerId },
            'Container not found in Docker; removing from registry',
          );
          await manager.kill(info.threadId);
        } else {
          // Log and continue — a transient Docker API error should not cause
          // the monitor to abort checks for remaining containers.
          this.logger.error(
            {
              threadId: info.threadId,
              containerId: info.containerId,
              err: error instanceof Error ? error.message : String(error),
            },
            'Health check inspect failed',
          );
        }
      }
    }
  }
}
