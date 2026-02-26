/**
 * Database migrations.
 *
 * Versioned SQL migration files are applied in order by the migration runner.
 * Schema version is tracked via SQLite's PRAGMA user_version.
 */

export { runMigrations } from './runner.js';
