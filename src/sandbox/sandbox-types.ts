/**
 * Type definitions for the container sandbox subsystem.
 *
 * Separating types from implementation avoids circular imports between
 * sandbox-manager, container-factory, and container-health.
 */

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

/**
 * Lifecycle states for a managed container.
 *
 * Transitions:
 *   Spawning -> Warm       (container started, ready to accept exec)
 *   Warm     -> Busy       (agent run in progress)
 *   Busy     -> Warm       (run completed)
 *   Warm     -> ShuttingDown  (idle timeout or explicit kill)
 *   Busy     -> ShuttingDown  (hard timeout or explicit kill)
 *   ShuttingDown -> (removed from map)
 */
export enum SandboxState {
  Spawning = 'spawning',
  Warm = 'warm',
  Busy = 'busy',
  ShuttingDown = 'shutting_down',
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Runtime configuration passed to the sandbox subsystem.
 *
 * This mirrors the Zod-validated SandboxConfig from core/config but is kept
 * as a standalone interface so the sandbox module does not depend on Zod.
 */
export interface SandboxConfig {
  /** Container runtime to use. */
  runtime: 'docker' | 'apple-container';
  /** Docker image tag for the agent sandbox. */
  image: string;
  /** Maximum number of simultaneously warm/busy containers. */
  maxConcurrent: number;
  /** Default network mode for new containers. */
  networkDefault: 'off' | 'on';
  /** Milliseconds a container may be idle before it is reaped. */
  idleTimeoutMs: number;
  /** Absolute maximum lifetime of a container in milliseconds. */
  hardTimeoutMs: number;
  /** OS-level resource quotas applied at container creation. */
  resourceLimits: {
    memoryMb: number;
    cpus: number;
    pidsLimit: number;
  };
}

// ---------------------------------------------------------------------------
// Runtime tracking
// ---------------------------------------------------------------------------

/**
 * Live record of a managed container tracked by SandboxManager.
 */
export interface ContainerInfo {
  /** Docker container ID (64-char hex string). */
  containerId: string;
  /** Talon thread this container belongs to. */
  threadId: string;
  /** Persona driving this container. */
  personaId: string;
  /** Current lifecycle state. */
  state: SandboxState;
  /** SDK session ID for conversation resumption (set after first run). */
  sessionId?: string;
  /** Unix epoch milliseconds when the container was created. */
  createdAt: number;
  /** Unix epoch milliseconds when the container last became active. */
  lastActivityAt: number;
}

// ---------------------------------------------------------------------------
// Mount configuration
// ---------------------------------------------------------------------------

/**
 * A single host-to-container filesystem mount.
 *
 * The `source` field supports a `{thread}` template token that the factory
 * replaces with the actual thread ID at container creation time. This allows
 * per-thread workspace directories to be mounted without needing to build
 * separate configs per thread.
 *
 * @example
 * ```ts
 * { source: '/data/threads/{thread}/memory', target: '/memory', mode: 'ro' }
 * ```
 */
export interface MountConfig {
  /** Host path. Supports `{thread}` template token. */
  source: string;
  /** Absolute path inside the container. */
  target: string;
  /** Mount mode: read-only or read-write. */
  mode: 'ro' | 'rw';
}
