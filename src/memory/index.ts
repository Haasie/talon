/**
 * Per-thread memory subsystem.
 *
 * Stores and retrieves conversation context, long-term facts, and working
 * memory scoped to a thread or persona. Backed by SQLite; the interface is
 * abstract so alternative backends (vector DB, etc.) can be swapped in.
 */

export { MemoryLayer } from './memory-types.js';
export type { MemoryItem, ThreadContext } from './memory-types.js';

export { ThreadWorkspace } from './thread-workspace.js';
export { MemoryManager } from './memory-manager.js';
export { ContextBuilder } from './context-builder.js';
