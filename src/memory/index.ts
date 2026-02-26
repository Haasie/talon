/**
 * Per-thread memory subsystem.
 *
 * Stores and retrieves conversation context, long-term facts, and working
 * memory scoped to a thread or persona. Backed by SQLite; the interface is
 * abstract so alternative backends (vector DB, etc.) can be swapped in.
 */

export {};
