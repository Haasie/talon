/**
 * Unit tests for the `talonctl migrate` command.
 *
 * Tests that the migrate command calls the migration runner correctly
 * and reports success/failure appropriately.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrateCommand } from '../../../src/cli/commands/migrate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-migrate-test-'));
}

/** Writes a minimal valid talond.yaml pointing to a test database. */
function writeConfig(dir: string, dbPath: string): string {
  const configPath = join(dir, 'talond.yaml');
  writeFileSync(
    configPath,
    `storage:\n  path: "${dbPath}"\nlogLevel: info\n`,
  );
  return configPath;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('migrateCommand()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('applies migrations and logs success message', async () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const configPath = writeConfig(tmpDir, dbPath);
    const migrationsDir = makeTmpDir();

    // Create a simple migration file
    writeFileSync(join(migrationsDir, '001-test.sql'), 'CREATE TABLE test (id TEXT PRIMARY KEY);');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await migrateCommand({ configPath, migrationsDir });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('1 migration(s)');
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('reports "up to date" when no pending migrations exist', async () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const configPath = writeConfig(tmpDir, dbPath);
    const migrationsDir = makeTmpDir();
    // Empty migrations dir — nothing to apply

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await migrateCommand({ configPath, migrationsDir });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('up to date');
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when config file is missing', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await migrateCommand({ configPath: '/nonexistent/talond.yaml' });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when migration fails', async () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const configPath = writeConfig(tmpDir, dbPath);
    const migrationsDir = makeTmpDir();

    // Create an invalid migration file
    writeFileSync(join(migrationsDir, '001-bad.sql'), 'INVALID SQL STATEMENT;');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await migrateCommand({ configPath, migrationsDir });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('calls runMigrations with the correct database', async () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const configPath = writeConfig(tmpDir, dbPath);
    const migrationsDir = makeTmpDir();

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await migrateCommand({ configPath, migrationsDir });

    // Database file should have been created at the configured path.
    const { existsSync } = await import('node:fs');
    expect(existsSync(dbPath)).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('skips already-applied migrations on re-run', async () => {
    const dbPath = join(tmpDir, 'test.sqlite');
    const configPath = writeConfig(tmpDir, dbPath);
    const migrationsDir = makeTmpDir();
    writeFileSync(join(migrationsDir, '001-test.sql'), 'CREATE TABLE test (id TEXT PRIMARY KEY);');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    // First run: applies 1 migration
    await migrateCommand({ configPath, migrationsDir });
    consoleSpy.mockClear();

    // Second run: no new migrations
    await migrateCommand({ configPath, migrationsDir });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('up to date');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
