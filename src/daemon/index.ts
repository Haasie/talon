/**
 * Daemon lifecycle management.
 *
 * Handles graceful startup (subsystem initialisation order) and shutdown
 * (drain queue, close containers, flush logs, write PID file).
 * Integrates with systemd sd_notify for service readiness signalling.
 */

export { TalondDaemon } from './daemon.js';
export { setupSignalHandlers } from './signal-handler.js';
export { recoverFromCrash, writePidFile, removePidFile } from './lifecycle.js';
export { HealthCheck } from './health-check.js';
export type { DaemonState, DaemonHealth, DaemonDependencies } from './daemon-types.js';
