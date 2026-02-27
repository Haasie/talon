/**
 * Host-side tool: db.query
 *
 * Executes read-only SQL queries against the talond SQLite database on behalf
 * of a persona. Write operations are not exposed through this tool — agents
 * use higher-level domain tools (e.g. memory.access) for mutations.
 *
 * Gated by `db.read:own` (persona can only query its own data).
 */

import type Database from 'better-sqlite3';
import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolExecutionContext } from './channel-send.js';

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

/** Default and maximum row limits for db.query results. */
const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

/**
 * SQL safety check: reject any statement that is not a pure SELECT.
 *
 * This pattern strips leading whitespace and SQL block comments, then checks
 * that the first meaningful keyword is SELECT. Any DML (INSERT, UPDATE,
 * DELETE), DDL (CREATE, DROP, ALTER), or PRAGMA statements are rejected.
 *
 * Note: This is a defense-in-depth check. The database is also opened in
 * read-only mode at the caller level.
 */
const FORBIDDEN_KEYWORDS = /^\s*(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|ATTACH|DETACH|PRAGMA|REPLACE|TRUNCATE|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

/**
 * Handler class for the db.query host tool.
 *
 * Accepts a SQL SELECT statement, validates it for safety, and executes it
 * against the provided Database instance. Returns column names, rows, and
 * the row count.
 */
export class DbQueryHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: 'db.query',
    description:
      'Executes read-only SQL SELECT queries against the talond SQLite database. Only SELECT statements are permitted.',
    capabilities: ['db.read:own'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      db: Database.Database;
      logger: pino.Logger;
    },
  ) {}

  /**
   * Execute the db.query tool.
   *
   * @param args    - Validated tool arguments.
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  execute(args: DbQueryArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    return Promise.resolve(this.executeSync(args, context));
  }

  /** Synchronous implementation — wrapped by execute() to satisfy the async tool interface. */
  private executeSync(args: DbQueryArgs, context: ToolExecutionContext): ToolCallResult {
    const requestId = context.requestId ?? 'unknown';
    const { sql, params, limit } = args;

    this.deps.logger.info(
      { requestId, runId: context.runId, personaId: context.personaId },
      'db.query: executing',
    );

    // Validate sql argument
    if (!sql || typeof sql !== 'string' || sql.trim() === '') {
      const error = new ToolError('db.query: sql is required and must be a non-empty string');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    // Strip inline comments (--) and block comments (/* */) for safety check.
    // This prevents bypassing the keyword check with comment injection.
    const strippedSql = stripSqlComments(sql.trim());

    // Enforce SELECT-only rule
    if (FORBIDDEN_KEYWORDS.test(strippedSql)) {
      const error = new ToolError(
        'db.query: only SELECT statements are allowed. INSERT, UPDATE, DELETE, DROP, and other write operations are forbidden',
      );
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    if (!strippedSql.match(/^\s*SELECT\b/i)) {
      const error = new ToolError(
        'db.query: statement must begin with SELECT. Only read-only queries are allowed',
      );
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    // Validate and clamp limit
    const rowLimit = Math.min(
      typeof limit === 'number' && limit > 0 ? limit : DEFAULT_LIMIT,
      MAX_LIMIT,
    );

    // Validate params type
    if (params !== undefined && !Array.isArray(params)) {
      const error = new ToolError('db.query: params must be an array if provided');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'db.query', status: 'error', error: error.message };
    }

    // Build the final SQL with a LIMIT clause injected.
    // Wrap in a subquery so the limit applies to the user's full query safely.
    const limitedSql = `SELECT * FROM (${sql.trim()}) LIMIT ${rowLimit}`;

    try {
      const stmt = this.deps.db.prepare(limitedSql);
      const rawRows = stmt.all(...(params ?? []));

      // Extract column names from the first row, or from statement columns if available.
      const columns: string[] = rawRows.length > 0
        ? Object.keys(rawRows[0] as Record<string, unknown>)
        : [];

      // Convert rows to arrays for a compact wire format.
      const rows = (rawRows as Record<string, unknown>[]).map((row) =>
        columns.map((col) => row[col] ?? null),
      );

      this.deps.logger.info(
        { requestId, rowCount: rows.length },
        'db.query: query completed',
      );

      return {
        requestId,
        tool: 'db.query',
        status: 'success',
        result: {
          columns,
          rows,
          rowCount: rows.length,
        },
      };
    } catch (cause) {
      const msg = `db.query: query execution failed — ${cause instanceof Error ? cause.message : String(cause)}`;
      this.deps.logger.error({ requestId, err: cause }, msg);
      return { requestId, tool: 'db.query', status: 'error', error: msg };
    }
  }
}

/**
 * Strip SQL line comments (-- ...) and block comments (/* ... *\/) from a
 * SQL string. Used to prevent comment-injection bypass of the keyword check.
 *
 * @param sql - Raw SQL string.
 * @returns SQL string with comments removed.
 */
function stripSqlComments(sql: string): string {
  // Remove block comments first (/* ... */)
  let result = sql.replace(/\/\*[\s\S]*?\*\//g, ' ');
  // Remove line comments (-- ...)
  result = result.replace(/--[^\n]*/g, ' ');
  return result.trim();
}
