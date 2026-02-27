/**
 * Unit tests for the `talonctl reload` command.
 *
 * Tests IPC command writing and response polling for the reload command.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { reloadCommand } from '../../../src/cli/commands/reload.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-reload-test-'));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reloadCommand()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('exits with code 1 when daemon does not respond (timeout)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Use a very short timeout and an empty IPC dir (no daemon)
    await reloadCommand({ ipcDir: tmpDir, timeoutMs: 50 });

    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('writes a command file to the input directory', async () => {
    const inputDir = join(tmpDir, 'input');
    mkdirSync(inputDir, { recursive: true });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    // Short timeout — just verify the command file was written
    await reloadCommand({ ipcDir: tmpDir, timeoutMs: 50 });

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(inputDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('displays reload result when daemon responds successfully', async () => {
    const outputDir = join(tmpDir, 'output');
    const inputDir = join(tmpDir, 'input');
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    // Watch input dir for new files and write a matching response.
    const { watch } = await import('node:fs');
    const watcher = watch(inputDir, async (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(join(inputDir, filename), 'utf8');
        const cmd = JSON.parse(content) as { id: string; command: string };
        if (cmd.command === 'reload') {
          const response = {
            id: randomUUID(),
            commandId: cmd.id,
            success: true,
            data: {
              configReloaded: true,
              personasReloaded: true,
              channelsReloaded: true,
            },
          };
          const fname = `${Date.now()}-${randomUUID().replace(/-/g, '')}.json`;
          writeFileSync(join(outputDir, fname), JSON.stringify(response));
        }
      } catch {
        // Ignore
      }
    });

    await reloadCommand({ ipcDir: tmpDir, timeoutMs: 2000 });

    watcher.close();

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('Reload completed');
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when daemon responds with error', async () => {
    const outputDir = join(tmpDir, 'output');
    const inputDir = join(tmpDir, 'input');
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    const { watch } = await import('node:fs');
    const watcher = watch(inputDir, async (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(join(inputDir, filename), 'utf8');
        const cmd = JSON.parse(content) as { id: string; command: string };
        if (cmd.command === 'reload') {
          const response = {
            id: randomUUID(),
            commandId: cmd.id,
            success: false,
            error: 'Failed to reload config',
          };
          const fname = `${Date.now()}-${randomUUID().replace(/-/g, '')}.json`;
          writeFileSync(join(outputDir, fname), JSON.stringify(response));
        }
      } catch {
        // Ignore
      }
    });

    await reloadCommand({ ipcDir: tmpDir, timeoutMs: 2000 });

    watcher.close();

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
