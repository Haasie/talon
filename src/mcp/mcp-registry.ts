/**
 * MCP server registry.
 *
 * Maintains the set of known MCP server configurations and their runtime
 * lifecycle state. The registry does NOT spawn actual processes — that is
 * handled by a future transport layer. It tracks status so that the proxy
 * can gate calls on server availability.
 */

import type pino from 'pino';
import { McpError } from '../core/errors/error-types.js';
import type { McpServerConfig, McpServerEntry, McpServerStatus } from './mcp-types.js';

/**
 * Central registry for all configured MCP servers.
 *
 * Servers are registered by their unique {@link McpServerConfig.name}. The
 * registry manages the logical lifecycle state transitions; actual transport
 * start/stop is delegated to a separate client layer (future task).
 */
export class McpRegistry {
  private readonly servers = new Map<string, McpServerEntry>();

  constructor(private readonly logger: pino.Logger) {}

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register an MCP server with the given name and configuration.
   * Throws {@link McpError} if a server with the same name is already registered.
   *
   * @param name   - Unique server name; must match `config.name`.
   * @param config - Static server configuration.
   */
  register(name: string, config: McpServerConfig): void {
    if (this.servers.has(name)) {
      throw new McpError(`MCP server "${name}" is already registered`);
    }

    const entry: McpServerEntry = {
      config,
      status: 'stopped',
    };

    this.servers.set(name, entry);
    this.logger.info({ mcpServer: name, transport: config.transport }, 'MCP server registered');
  }

  /**
   * Unregister an MCP server by name.
   * If the server is currently running, its status is set to `stopped` before
   * removal (actual transport teardown is the caller's responsibility).
   * No-op if the server is not registered.
   *
   * @param name - The server name to remove.
   */
  unregister(name: string): void {
    const removed = this.servers.delete(name);
    if (removed) {
      this.logger.info({ mcpServer: name }, 'MCP server unregistered');
    }
  }

  // ---------------------------------------------------------------------------
  // Look-up
  // ---------------------------------------------------------------------------

  /**
   * Returns the registry entry for the given server name, or `undefined`.
   *
   * @param name - Server name to look up.
   */
  get(name: string): McpServerEntry | undefined {
    return this.servers.get(name);
  }

  /**
   * Returns a snapshot of all registered server names in registration order.
   */
  listServers(): string[] {
    return [...this.servers.keys()];
  }

  /**
   * Returns all registered entries (config + status) in registration order.
   */
  listEntries(): McpServerEntry[] {
    return [...this.servers.values()];
  }

  // ---------------------------------------------------------------------------
  // Status management
  // ---------------------------------------------------------------------------

  /**
   * Update the lifecycle status of a registered server.
   * Throws {@link McpError} if the server is not registered.
   *
   * @param name      - Server name.
   * @param status    - New lifecycle state.
   * @param lastError - Optional error description (set when transitioning to `error`).
   */
  setStatus(name: string, status: McpServerStatus, lastError?: string): void {
    const entry = this.servers.get(name);
    if (!entry) {
      throw new McpError(`MCP server "${name}" is not registered`);
    }

    entry.status = status;
    if (lastError !== undefined) {
      entry.lastError = lastError;
    } else if (status !== 'error') {
      // Clear stale error when recovering to a non-error state.
      delete entry.lastError;
    }

    this.logger.debug({ mcpServer: name, status, lastError }, 'MCP server status updated');
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Transition all registered servers to `starting` status.
   *
   * In this initial implementation, servers immediately transition to `running`
   * because actual transport spawning is a future task. The method exists to
   * establish the lifecycle contract and allow future transport integration.
   */
  startAll(): Promise<void> {
    for (const [name, entry] of this.servers) {
      entry.status = 'starting';
      this.logger.info({ mcpServer: name }, 'starting MCP server');

      // Placeholder: no actual transport start yet. Transition directly to running.
      entry.status = 'running';
      this.logger.info({ mcpServer: name }, 'MCP server running');
    }
    return Promise.resolve();
  }

  /**
   * Transition all registered servers to `stopped` status.
   *
   * Errors from individual servers are caught and logged; all servers are
   * stopped regardless of failures so the daemon can shut down cleanly.
   */
  stopAll(): Promise<void> {
    for (const [name, entry] of this.servers) {
      try {
        this.logger.info({ mcpServer: name }, 'stopping MCP server');
        entry.status = 'stopping';

        // Placeholder: no actual transport stop yet. Transition to stopped.
        entry.status = 'stopped';
        this.logger.info({ mcpServer: name }, 'MCP server stopped');
      } catch (err) {
        this.logger.error({ mcpServer: name, err }, 'error stopping MCP server');
        entry.status = 'error';
        entry.lastError = err instanceof Error ? err.message : String(err);
      }
    }
    return Promise.resolve();
  }
}
