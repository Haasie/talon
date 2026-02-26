/**
 * Channel connector registry.
 *
 * Maintains a map of named channel connectors, provides look-up by name and
 * type, and manages the start/stop lifecycle for all registered connectors.
 */

import type pino from 'pino';
import type { ChannelConnector } from './channel-types.js';
import { ChannelError } from '../core/errors/error-types.js';

/**
 * Central registry for all active channel connectors.
 *
 * Connectors are registered by a unique instance name. The registry does not
 * own the connectors' lifecycle by default; call `startAll()` / `stopAll()`
 * explicitly from the daemon lifecycle controller.
 */
export class ChannelRegistry {
  private readonly connectors = new Map<string, ChannelConnector>();

  constructor(private readonly logger: pino.Logger) {}

  // ---------------------------------------------------------------------------
  // Registration
  // ---------------------------------------------------------------------------

  /**
   * Register a connector.
   * Throws if a connector with the same name is already registered.
   *
   * @param connector - The connector instance to register.
   */
  register(connector: ChannelConnector): void {
    if (this.connectors.has(connector.name)) {
      throw new ChannelError(
        `Channel connector "${connector.name}" is already registered`,
      );
    }
    this.connectors.set(connector.name, connector);
    this.logger.info({ channelName: connector.name, channelType: connector.type }, 'channel connector registered');
  }

  /**
   * Unregister a connector by name.
   * No-op if the connector is not registered.
   *
   * @param name - The connector instance name to remove.
   */
  unregister(name: string): void {
    const removed = this.connectors.delete(name);
    if (removed) {
      this.logger.info({ channelName: name }, 'channel connector unregistered');
    }
  }

  // ---------------------------------------------------------------------------
  // Look-up
  // ---------------------------------------------------------------------------

  /**
   * Returns the connector with the given instance name, or `undefined` if not found.
   *
   * @param name - Connector instance name.
   */
  get(name: string): ChannelConnector | undefined {
    return this.connectors.get(name);
  }

  /**
   * Returns all connectors of a given type (e.g. all 'telegram' connectors).
   *
   * @param type - Channel type string (e.g. 'telegram', 'slack').
   */
  getByType(type: string): ChannelConnector[] {
    return [...this.connectors.values()].filter((c) => c.type === type);
  }

  /**
   * Returns all registered connectors in registration order.
   */
  listAll(): ChannelConnector[] {
    return [...this.connectors.values()];
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Calls `start()` on every registered connector in parallel.
   * Logs and re-throws the first error encountered; other connectors that
   * started successfully are left running.
   */
  async startAll(): Promise<void> {
    const results = await Promise.allSettled(
      [...this.connectors.values()].map(async (connector) => {
        this.logger.info({ channelName: connector.name }, 'starting channel connector');
        await connector.start();
        this.logger.info({ channelName: connector.name }, 'channel connector started');
      }),
    );

    const failures = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );

    if (failures.length > 0) {
      const reasons = failures.map((f) => String(f.reason)).join('; ');
      throw new ChannelError(`Failed to start ${failures.length} channel connector(s): ${reasons}`);
    }
  }

  /**
   * Calls `stop()` on every registered connector in parallel.
   * Errors are logged but do not prevent other connectors from stopping.
   */
  async stopAll(): Promise<void> {
    await Promise.allSettled(
      [...this.connectors.values()].map(async (connector) => {
        try {
          this.logger.info({ channelName: connector.name }, 'stopping channel connector');
          await connector.stop();
          this.logger.info({ channelName: connector.name }, 'channel connector stopped');
        } catch (err) {
          this.logger.error(
            { channelName: connector.name, err },
            'error stopping channel connector',
          );
        }
      }),
    );
  }
}
