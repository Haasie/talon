/**
 * `talonctl remove-schedule` command.
 *
 * Disables a schedule by its ID. The schedule row is not deleted; it is
 * marked as disabled so it will no longer fire.
 *
 * The pure `removeSchedule()` function can be called programmatically.
 * The `removeScheduleCommand()` wrapper handles config loading, DB lifecycle,
 * console output, and process.exit.
 */

import type Database from 'better-sqlite3';

import { ScheduleRepository } from '../../core/database/repositories/schedule-repository.js';

// ---------------------------------------------------------------------------
// Core logic (importable, no console / process.exit)
// ---------------------------------------------------------------------------

/**
 * Disables an existing schedule by ID.
 *
 * @throws Error if the schedule ID is not found or a DB error occurs.
 */
export function removeSchedule(options: { scheduleId: string; db: Database.Database }): void {
  const { db, scheduleId } = options;

  const scheduleRepo = new ScheduleRepository(db);

  const findResult = scheduleRepo.findById(scheduleId);
  if (findResult.isErr()) {
    throw new Error(`Database error looking up schedule: ${findResult.error.message}`);
  }

  if (findResult.value === null) {
    throw new Error(`Schedule not found: "${scheduleId}"`);
  }

  const disableResult = scheduleRepo.disable(scheduleId);
  if (disableResult.isErr()) {
    throw new Error(`Failed to disable schedule: ${disableResult.error.message}`);
  }
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl remove-schedule`.
 *
 * Loads config to find the DB path, opens the database, delegates to
 * {@link removeSchedule}, then prints confirmation and closes the DB.
 */
export async function removeScheduleCommand(options: {
  scheduleId: string;
  configPath?: string;
}): Promise<void> {
  const { loadConfig } = await import('../../core/config/config-loader.js');
  const { createDatabase } = await import('../../core/database/connection.js');

  const configPath = options.configPath ?? 'talond.yaml';
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
    return;
  }

  const dbResult = createDatabase(configResult.value.storage.path);
  if (dbResult.isErr()) {
    console.error(`Error opening database: ${dbResult.error.message}`);
    process.exit(1);
    return;
  }

  const db = dbResult.value;

  try {
    removeSchedule({ scheduleId: options.scheduleId, db });
    console.log(`Schedule ${options.scheduleId.slice(0, 8)}… disabled.`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  } finally {
    db.close();
  }
}
