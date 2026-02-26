/**
 * Bidirectional IPC channel.
 *
 * Combines an {@link IpcWriter} (outbound) and an {@link IpcReader} (inbound)
 * into a single logical channel that can be started, used to send messages,
 * and stopped cleanly.
 *
 * Usage in the host daemon (one channel per running container):
 *   - `inputDir`  — directory the container writes into (host reads from here)
 *   - `outputDir` — directory the container reads from (host writes here)
 *
 * Usage in a container agent (mirror of the above):
 *   - `inputDir`  — directory the host writes into
 *   - `outputDir` — directory the host reads from
 */

import type { Result } from 'neverthrow';

import { IpcError } from '../core/errors/index.js';
import { IpcWriter } from './ipc-writer.js';
import { IpcReader } from './ipc-reader.js';
import type { IpcMessage } from './ipc-types.js';

// ---------------------------------------------------------------------------
// BidirectionalIpcChannel
// ---------------------------------------------------------------------------

/**
 * Bidirectional file-based IPC channel.
 *
 * Encapsulates a reader polling `inputDir` and a writer targeting `outputDir`,
 * providing a clean start/send/stop interface.
 */
export class BidirectionalIpcChannel {
  /** The underlying writer (writes to `outputDir`). */
  readonly writer: IpcWriter;
  /** The underlying reader (reads from `inputDir`). */
  readonly reader: IpcReader;

  /**
   * @param inputDir       Directory this side reads incoming messages from.
   * @param outputDir      Directory this side writes outgoing messages to.
   * @param errorsDir      Directory where invalid / failed messages are moved.
   * @param pollIntervalMs How often the reader polls `inputDir` (default 500 ms).
   */
  constructor(
    inputDir: string,
    outputDir: string,
    errorsDir: string,
    pollIntervalMs = 500,
  ) {
    this.writer = new IpcWriter(outputDir);
    this.reader = new IpcReader(inputDir, { pollIntervalMs, errorsDir });
  }

  /**
   * Starts the inbound polling loop.
   *
   * @param handler Async callback invoked for each validated inbound message.
   */
  start(handler: (msg: IpcMessage) => Promise<void>): void {
    this.reader.start(handler);
  }

  /**
   * Sends a message to the peer by writing it atomically to `outputDir`.
   *
   * @returns `Ok<string>` with the written filename, or `Err<IpcError>` on
   *          write failure.
   */
  send(message: IpcMessage): Result<string, IpcError> {
    return this.writer.write(message);
  }

  /**
   * Stops the inbound polling loop.
   *
   * In-flight poll iterations complete before the interval is cleared.
   */
  stop(): void {
    this.reader.stop();
  }
}
