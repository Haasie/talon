/**
 * Daemon health check helper.
 *
 * Gathers a point-in-time health snapshot from the running daemon and
 * exposes it via the `check()` method. Used by the daemon IPC layer so
 * `talonctl status` can display live daemon health without coupling the
 * IPC code directly to the daemon internals.
 */

import type { TalondDaemon } from './daemon.js';
import type { DaemonHealth } from './daemon-types.js';

/**
 * Wraps a TalondDaemon instance and provides a simple `check()` method
 * for gathering health information.
 *
 * This indirection keeps the IPC layer decoupled from daemon internals
 * and makes it easy to inject a mock in tests.
 */
export class HealthCheck {
  constructor(private readonly daemon: TalondDaemon) {}

  /**
   * Returns a current health snapshot from the daemon.
   *
   * Delegates directly to `daemon.health()`. The snapshot is computed
   * synchronously from in-memory state — no database queries are needed.
   */
  check(): DaemonHealth {
    return this.daemon.health();
  }
}
