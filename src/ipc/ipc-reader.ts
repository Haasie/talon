/**
 * Directory-polling IPC reader.
 *
 * Polls a directory at a configurable interval, reads JSON files in
 * lexicographic (FIFO) order, validates them against {@link IpcMessageSchema},
 * and dispatches valid messages to a caller-supplied handler.
 *
 * Error handling policy:
 *   - Invalid JSON / schema violations → file moved to `errorsDir`, no crash
 *   - Handler rejection                → file moved to `errorsDir` with error
 *                                        annotation, no crash
 *   - Directory unreadable             → logged, polling continues
 */

import fs from 'fs/promises';
import path from 'path';

import { IpcMessageSchema } from './ipc-types.js';
import type { IpcMessage } from './ipc-types.js';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Configuration for {@link IpcReader}. */
export interface IpcReaderOptions {
  /** How often to poll the directory in milliseconds. Default: 500. */
  pollIntervalMs: number;
  /** Directory where invalid / failed messages are moved for inspection. */
  errorsDir: string;
}

/** Default reader options. */
export const DEFAULT_READER_OPTIONS: IpcReaderOptions = {
  pollIntervalMs: 500,
  errorsDir: '',
};

// ---------------------------------------------------------------------------
// IpcReader
// ---------------------------------------------------------------------------

/**
 * Polls a directory for JSON files, validates each against the IPC message
 * schema, and dispatches valid messages to a handler function.
 *
 * Files are processed in lexicographic order (which equals FIFO because of
 * the timestamp-prefixed naming convention produced by {@link IpcWriter}).
 *
 * @example
 * ```ts
 * const reader = new IpcReader('/run/talon/container-in', {
 *   pollIntervalMs: 500,
 *   errorsDir: '/run/talon/ipc-errors',
 * });
 * reader.start(async (msg) => {
 *   console.log('received', msg.type);
 * });
 * ```
 */
export class IpcReader {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private readonly opts: IpcReaderOptions;

  constructor(
    private readonly directory: string,
    options: Partial<IpcReaderOptions> = {},
  ) {
    this.opts = { ...DEFAULT_READER_OPTIONS, ...options };
    if (!this.opts.errorsDir) {
      this.opts.errorsDir = path.join(this.directory, 'errors');
    }
  }

  /**
   * Starts the polling loop.
   *
   * The first poll fires after one `pollIntervalMs` interval. Calling `start`
   * while already running is a no-op.
   *
   * @param handler Async function called for each valid message. On rejection
   *                the message is moved to `errorsDir`.
   */
  start(handler: (message: IpcMessage) => Promise<void>): void {
    if (this.intervalHandle !== null) {
      return;
    }
    this.intervalHandle = setInterval(() => {
      // Intentionally fire-and-forget inside the interval; errors are handled
      // within pollOnce / processFile rather than propagated here.
      void this.runPoll(handler);
    }, this.opts.pollIntervalMs);
  }

  /**
   * Stops the polling loop.
   *
   * Safe to call multiple times; subsequent calls are no-ops.
   */
  stop(): void {
    if (this.intervalHandle !== null) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  /**
   * Performs a single poll of the directory.
   *
   * Useful for testing without a real timer. Returns the list of successfully
   * validated and dispatched messages.
   *
   * @param handler Optional handler. When omitted messages are validated and
   *                returned but not otherwise processed (test/inspect use).
   */
  async pollOnce(handler?: (message: IpcMessage) => Promise<void>): Promise<IpcMessage[]> {
    const files = await this.listFiles();
    const processed: IpcMessage[] = [];

    for (const file of files) {
      const msg = await this.processFile(file, handler);
      if (msg !== null) {
        processed.push(msg);
      }
    }

    return processed;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Inner poll loop body — called on every tick. */
  private async runPoll(handler: (message: IpcMessage) => Promise<void>): Promise<void> {
    await this.pollOnce(handler);
  }

  /**
   * Returns all `.json` files in the directory, sorted lexicographically for
   * FIFO processing order.
   */
  private async listFiles(): Promise<string[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.directory);
    } catch {
      // Directory not yet created or temporarily unavailable — not fatal.
      return [];
    }

    return entries
      .filter((name) => name.endsWith('.json'))
      .sort() // lexicographic = timestamp order given the naming convention
      .map((name) => path.join(this.directory, name));
  }

  /**
   * Reads, validates, dispatches, and deletes a single message file.
   *
   * @returns The parsed message on success, or `null` if the file was invalid
   *          or the handler failed.
   */
  private async processFile(
    filepath: string,
    handler?: (message: IpcMessage) => Promise<void>,
  ): Promise<IpcMessage | null> {
    // --- Read ---
    let raw: string;
    try {
      raw = await fs.readFile(filepath, 'utf8');
    } catch {
      // File disappeared between readdir and readFile (already processed by a
      // parallel reader) — skip silently.
      return null;
    }

    // --- Parse JSON ---
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (cause) {
      await this.moveToErrors(filepath, raw, `JSON parse error: ${String(cause)}`);
      return null;
    }

    // --- Validate schema ---
    const validation = IpcMessageSchema.safeParse(parsed);
    if (!validation.success) {
      await this.moveToErrors(
        filepath,
        raw,
        `Schema validation failed: ${validation.error.message}`,
      );
      return null;
    }

    const message = validation.data;

    // --- Dispatch ---
    if (handler) {
      try {
        await handler(message);
      } catch (cause) {
        await this.moveToErrors(
          filepath,
          raw,
          `Handler error: ${String(cause)}`,
          message,
        );
        return null;
      }
    }

    // --- Delete processed file ---
    try {
      await fs.unlink(filepath);
    } catch {
      // If deletion fails we may re-process the message on the next poll.
      // Handlers should be idempotent where possible (by checking message.id).
    }

    return message;
  }

  /**
   * Moves a problematic file to {@link IpcReaderOptions.errorsDir}.
   *
   * Writes a sibling `.error` JSON file alongside the original content so
   * operators can inspect what went wrong without losing the raw payload.
   */
  private async moveToErrors(
    filepath: string,
    rawContent: string,
    reason: string,
    message?: IpcMessage,
  ): Promise<void> {
    try {
      await fs.mkdir(this.opts.errorsDir, { recursive: true });

      const basename = path.basename(filepath);
      const destPath = path.join(this.opts.errorsDir, basename);

      // Write raw content to errors dir (may already exist if we're retrying).
      await fs.writeFile(destPath, rawContent, 'utf8');

      // Write a companion error annotation file.
      const errorRecord = {
        originalFile: filepath,
        reason,
        timestamp: Date.now(),
        messageId: message?.id,
        messageType: message?.type,
      };
      await fs.writeFile(
        path.join(this.opts.errorsDir, basename.replace('.json', '.error.json')),
        JSON.stringify(errorRecord, null, 2),
        'utf8',
      );

      // Remove the original from the inbox so we don't re-process it.
      await fs.unlink(filepath);
    } catch {
      // Moving to errors dir itself failed — log and move on to avoid
      // infinite crash loops. The original file stays in the inbox, so the
      // next poll will re-attempt.
    }
  }
}
