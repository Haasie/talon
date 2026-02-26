/**
 * Container sandbox management.
 *
 * Manages warm Docker containers per thread. Each container runs with a
 * read-only rootfs, all Linux capabilities dropped, and no network access
 * unless explicitly granted by persona policy.
 * Secrets are delivered via stdin JSON at spawn time, never written to disk.
 */

export { SandboxState } from './sandbox-types.js';
export type { SandboxConfig, ContainerInfo, MountConfig } from './sandbox-types.js';

export { ContainerFactory, resolveMountSource, buildBinds, defaultMounts, TMP_SIZE } from './container-factory.js';

export { SandboxManager } from './sandbox-manager.js';

export { ContainerHealthMonitor } from './container-health.js';
