/**
 * Host-side tool: db.query
 *
 * Executes read-only SQL queries against the talond SQLite database on behalf
 * of a persona. Write operations are not exposed through this tool — agents
 * use higher-level domain tools (e.g. memory.access) for mutations.
 *
 * Gated by `db.read:own` (persona can only query its own data).
 *
 * @remarks Full implementation in TASK-029.
 */

import type { ToolManifest } from '../tool-types.js';

/** Manifest for the db.query host tool. */
export interface DbQueryTool {
  readonly manifest: ToolManifest;
}

/** Arguments accepted by the db.query tool. */
export interface DbQueryArgs {
  /** SQL SELECT statement. Must be a read-only query. */
  sql: string;
  /** Positional or named parameters for the prepared statement. */
  params?: unknown[];
  /** Maximum number of rows to return (default: 100, max: 1 000). */
  limit?: number;
}
