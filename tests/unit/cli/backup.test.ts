/**
 * Unit tests for the `talonctl backup` command.
 *
 * Tests that the backup command creates a valid SQLite backup file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

import { backupCommand } from '../../../src/cli/commands/backup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-backup-test-'));
}

/** Creates a minimal SQLite database with one table for testing. */
function createTestDatabase(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec('CREATE TABLE test (id TEXT PRIMARY KEY)');
  db.exec("INSERT INTO test VALUES ('row1')");
  db.close();
}

/** Writes a talond.yaml config pointing at a specific db and data directory. */
function writeConfig(dir: string, dbPath: string, dataDir: string): string {
  const configPath = join(dir, 'talond.yaml');
  writeFileSync(
    configPath,
    `storage:\n  path: "${dbPath}"\ndataDir: "${dataDir}"\nlogLevel: info\n`,
  );
  return configPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backupCommand()', () => {
  let tmpDir: string;
  let dbDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    dbDir = makeTmpDir();
  });

  it('creates a backup file at the specified path', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupPath = join(dbDir, 'test-backup.sqlite');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath });

    expect(existsSync(backupPath)).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('backup file is a valid SQLite database', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupPath = join(dbDir, 'backup-valid.sqlite');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath });

    // Open backup as SQLite and verify data is preserved.
    const backupDb = new Database(backupPath);
    const rows = backupDb.prepare('SELECT id FROM test').all() as Array<{ id: string }>;
    backupDb.close();

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe('row1');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('creates backup directory if it does not exist', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupDir = join(dbDir, 'nested', 'backups');
    const backupPath = join(backupDir, 'test.sqlite');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath });

    expect(existsSync(backupDir)).toBe(true);
    expect(existsSync(backupPath)).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('uses default backup path under data/backups/', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath });

    // Check that a backup was created under data/backups/
    const backupsDir = join(dbDir, 'backups');
    const backupFiles = (await import('node:fs')).readdirSync(backupsDir);
    const sqliteBackups = backupFiles.filter((f) => f.endsWith('.sqlite'));
    expect(sqliteBackups.length).toBeGreaterThan(0);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when config file is missing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath: '/nonexistent/talond.yaml' });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when database does not exist', async () => {
    const dbPath = join(dbDir, 'nonexistent.sqlite');
    // Config points to a non-existent parent directory
    writeFileSync(
      join(tmpDir, 'talond.yaml'),
      `storage:\n  path: "/nonexistent/path/test.sqlite"\ndataDir: "${dbDir}"\nlogLevel: info\n`,
    );
    const configPath = join(tmpDir, 'talond.yaml');
    const backupPath = join(dbDir, 'backup.sqlite');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('logs source database and backup path on success', async () => {
    const dbPath = join(dbDir, 'test.sqlite');
    createTestDatabase(dbPath);
    const configPath = writeConfig(tmpDir, dbPath, dbDir);
    const backupPath = join(dbDir, 'backup-log-test.sqlite');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await backupCommand({ configPath, backupPath });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain(dbPath);
    expect(output).toContain(backupPath);
    expect(output).toContain('completed');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
