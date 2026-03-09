/**
 * `talonctl backup` command.
 *
 * Standalone command (no daemon required). Creates an atomic SQLite backup
 * using VACUUM INTO and records a timestamped backup file.
 *
 * Default backup path: `data/backups/talond-{timestamp}.sqlite`
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { loadConfig } from '../../core/config/config-loader.js';
import { createDatabase } from '../../core/database/connection.js';
import type { BackupResult } from '../cli-types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default path to search for talond.yaml if none is specified. */
const DEFAULT_CONFIG_PATH = 'talond.yaml';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the `backup` CLI command.
 *
 * Loads config, determines the database path, and creates an atomic SQLite
 * backup using VACUUM INTO.
 *
 * @param options.configPath - Path to talond.yaml (defaults to `talond.yaml`).
 * @param options.backupPath - Override backup destination path.
 */
export async function backupCommand(options: {
  configPath?: string;
  backupPath?: string;
} = {}): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  // Load configuration to get the database and data paths.
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
    return;
  }

  const config = configResult.value;
  const dbPath = config.storage.path;
  const dataDir = config.dataDir;

  // Build the backup path: data/backups/talond-{ISO timestamp}.sqlite
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupPath =
    options.backupPath ?? path.join(dataDir, 'backups', `talond-${timestamp}.sqlite`);

  // Validate backup path ends with .sqlite extension.
  if (!backupPath.endsWith('.sqlite')) {
    console.error(`Error: Backup path must end with .sqlite extension.`);
    process.exit(1);
    return;
  }

  console.log(`Source database: ${dbPath}`);
  console.log(`Backup path:     ${backupPath}`);

  // Ensure backup directory exists.
  const backupDir = path.dirname(backupPath);
  try {
    await fs.mkdir(backupDir, { recursive: true });
  } catch (cause) {
    console.error(`Error creating backup directory: ${String(cause)}`);
    process.exit(1);
    return;
  }

  // Open database connection.
  const dbResult = createDatabase(dbPath);
  if (dbResult.isErr()) {
    console.error(`Error opening database: ${dbResult.error.message}`);
    process.exit(1);
    return;
  }

  const db = dbResult.value;
  let backupSucceeded = false;

  try {
    // VACUUM INTO performs an atomic, consistent copy of the database.
    // It works even if the source database has WAL mode enabled.
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    backupSucceeded = true;
  } catch (cause) {
    console.error(`Error creating backup: ${String(cause)}`);
    process.exit(1);
  } finally {
    db.close();
  }

  if (backupSucceeded) {
    // Verify the backup file was actually created.
    if (!existsSync(backupPath)) {
      console.error(`Error: Backup file "${backupPath}" was not created. VACUUM INTO may have failed silently.`);
      process.exit(1);
      return;
    }

    const stat = await fs.stat(backupPath);
    if (stat.size === 0) {
      console.error(`Error: Backup file "${backupPath}" is empty.`);
      process.exit(1);
      return;
    }

    const completedAt = new Date().toISOString();
    displayBackupResult({ backupPath, completedAt });
    const sizeMb = (stat.size / (1024 * 1024)).toFixed(2);
    console.log(`Backup size:       ${sizeMb} MB`);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Renders backup result to stdout.
 */
function displayBackupResult(result: BackupResult): void {
  console.log(`Backup completed at ${result.completedAt}`);
  console.log(`Backup saved to:   ${result.backupPath}`);
}
