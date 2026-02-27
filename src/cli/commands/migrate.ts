/**
 * `talonctl migrate` command.
 *
 * Standalone command (no daemon required). Loads the talond configuration to
 * determine the database path, opens the database, and applies any pending
 * migrations using the migration runner.
 *
 * Reports the number of migrations applied on success, or a clear error
 * message with the failure reason on failure.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../../core/config/config-loader.js';
import { createDatabase } from '../../core/database/connection.js';
import { runMigrations } from '../../core/database/migrations/runner.js';
import type { MigrateResult } from '../cli-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path to search for talond.yaml if none is specified. */
const DEFAULT_CONFIG_PATH = 'talond.yaml';

/**
 * Path to the bundled migrations directory, relative to this source file.
 * In production (built JS), this will be adjacent to the compiled output.
 */
function getMigrationsDir(): string {
  // When running via tsx (dev) or after tsc (prod), resolve relative to this file.
  const thisFile = fileURLToPath(import.meta.url);
  const thisDir = path.dirname(thisFile);
  return path.resolve(thisDir, '../../core/database/migrations');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the `migrate` CLI command.
 *
 * Loads config, opens the database, and runs pending migrations.
 *
 * @param options.configPath - Path to talond.yaml (defaults to `talond.yaml`).
 * @param options.migrationsDir - Override migrations directory (for testing).
 */
export function migrateCommand(options: {
  configPath?: string;
  migrationsDir?: string;
} = {}): void {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  // Load configuration to get the database path.
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
    return;
  }

  const config = configResult.value;
  const dbPath = config.storage.path;
  const migrationsDir = options.migrationsDir ?? getMigrationsDir();

  console.log(`Applying migrations to: ${dbPath}`);
  console.log(`Migrations directory:   ${migrationsDir}`);

  // Open database connection.
  const dbResult = createDatabase(dbPath);
  if (dbResult.isErr()) {
    console.error(`Error opening database: ${dbResult.error.message}`);
    process.exit(1);
    return;
  }

  const db = dbResult.value;

  try {
    const migrateResult = runMigrations(db, migrationsDir);

    if (migrateResult.isErr()) {
      console.error(`Migration failed: ${migrateResult.error.message}`);
      process.exit(1);
      return;
    }

    const applied = migrateResult.value;
    displayMigrateResult({ applied, dbPath });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Renders migrate result to stdout.
 */
function displayMigrateResult(result: MigrateResult): void {
  if (result.applied === 0) {
    console.log('No pending migrations — database is up to date.');
  } else {
    console.log(`Successfully applied ${result.applied} migration(s).`);
  }
}
