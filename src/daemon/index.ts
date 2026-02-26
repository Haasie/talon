/**
 * Daemon lifecycle management.
 *
 * Handles graceful startup (subsystem initialisation order) and shutdown
 * (drain queue, close containers, flush logs, write PID file).
 * Integrates with systemd sd_notify for service readiness signalling.
 */

export {};
