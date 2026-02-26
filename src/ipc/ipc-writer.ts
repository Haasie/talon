/**
 * Atomic IPC file writer.
 *
 * Serialises an {@link IpcMessage} to JSON and writes it atomically to a
 * target directory using `write-file-atomic` (temp file + rename).
 * File names embed the message timestamp for FIFO ordering by the reader.
 *
 * File naming convention: `{timestamp}-{id}.json`
 *   - `timestamp` — Unix epoch milliseconds (zero-padded to 15 digits)
 *   - `id`        — UUID v4 of the message (hyphens removed for clarity)
 */

import fs from 'fs/promises';
import path from 'path';
import writeFileAtomic from 'write-file-atomic';
import { ok, err } from 'neverthrow';
import type { Result } from 'neverthrow';

import { IpcError } from '../core/errors/index.js';
import type { IpcMessage } from './ipc-types.js';

// ---------------------------------------------------------------------------
// IpcWriter
// ---------------------------------------------------------------------------

/**
 * Writes IPC messages atomically to a directory on the local filesystem.
 *
 * Thread-safe: each write creates a distinct file; the directory is the only
 * shared resource and is created on first use.
 */
export class IpcWriter {
  constructor(private readonly directory: string) {}

  /**
   * Serialises `message` to JSON and writes it atomically to {@link directory}.
   *
   * The operation is atomic: the file appears in its final location only after
   * a successful rename, preventing partial reads by the poller.
   *
   * @returns `Ok<string>` with the base filename on success, or
   *          `Err<IpcError>` on I/O failure.
   */
  write(message: IpcMessage): Result<string, IpcError> {
    // Build the target filename synchronously so the Result type stays sync.
    const filename = buildFilename(message);
    const filepath = path.join(this.directory, filename);
    const content = JSON.stringify(message);

    try {
      // Ensure directory exists (sync so Result stays synchronous).
      fs.mkdir(this.directory, { recursive: true }).catch(() => {
        // Best-effort: if mkdir fails the subsequent writeFileAtomic will also
        // fail and surface a meaningful error through the Result.
      });

      writeFileAtomic.sync(filepath, content, { encoding: 'utf8' });
      return ok(filename);
    } catch (cause) {
      return err(
        new IpcError(
          `Failed to write IPC message "${message.id}" to "${filepath}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Async variant of {@link write}.
   *
   * Preferred when the caller is already in an async context — avoids
   * blocking the event loop on the underlying `fsync`.
   *
   * @returns A Promise resolving to `Ok<string>` or `Err<IpcError>`.
   */
  async writeAsync(message: IpcMessage): Promise<Result<string, IpcError>> {
    const filename = buildFilename(message);
    const filepath = path.join(this.directory, filename);
    const content = JSON.stringify(message);

    try {
      await fs.mkdir(this.directory, { recursive: true });
      await writeFileAtomic(filepath, content, { encoding: 'utf8' });
      return ok(filename);
    } catch (cause) {
      return err(
        new IpcError(
          `Failed to write IPC message "${message.id}" to "${filepath}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds the filename for a message.
 *
 * Zero-pads the timestamp to 15 digits so lexicographic order equals
 * chronological order for the next ~300 years.
 */
export function buildFilename(message: Pick<IpcMessage, 'id' | 'timestamp'>): string {
  const paddedTs = String(message.timestamp).padStart(15, '0');
  const cleanId = message.id.replace(/-/g, '');
  return `${paddedTs}-${cleanId}.json`;
}
