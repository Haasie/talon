/**
 * Host-side tool: memory.access
 *
 * Reads from or writes to the per-thread layered memory store. The host
 * mediates all memory operations to ensure isolation between threads and
 * enforce size limits.
 *
 * Gated by `memory.read:thread` (read ops) and `memory.write:thread` (write ops).
 *
 * @remarks Full implementation in TASK-029.
 */

import type { ToolManifest } from '../tool-types.js';

/** Manifest for the memory.access host tool. */
export interface MemoryAccessTool {
  readonly manifest: ToolManifest;
}

/** Arguments accepted by the memory.access tool. */
export interface MemoryAccessArgs {
  /** Operation to perform. */
  operation: 'read' | 'write' | 'delete' | 'list';
  /** Memory key to read, write, or delete. */
  key?: string;
  /** Value to store (required for write). */
  value?: unknown;
  /** Optional namespace/layer to scope the operation. */
  namespace?: string;
}
