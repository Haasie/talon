/**
 * Unit tests for the `talonctl status` command.
 *
 * Tests IPC command writing and response polling using a temporary directory
 * to simulate daemon IPC files.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { statusCommand } from '../../../src/cli/commands/status.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-status-test-'));
}

/** Writes a fake daemon response file to the output directory. */
async function writeFakeResponse(
  outputDir: string,
  commandId: string,
  data: Record<string, unknown>,
  success = true,
): Promise<void> {
  mkdirSync(outputDir, { recursive: true });
  const response = {
    id: randomUUID(),
    commandId,
    success,
    data: success ? data : undefined,
    error: success ? undefined : (data['error'] as string),
  };
  const filename = `${Date.now()}-${randomUUID().replace(/-/g, '')}.json`;
  writeFileSync(join(outputDir, filename), JSON.stringify(response));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('statusCommand()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('exits with code 1 when daemon does not respond (timeout)', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Use a very short timeout and an empty IPC dir (no daemon)
    await statusCommand({ ipcDir: tmpDir, timeoutMs: 50 });

    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('writes a command file to the input directory', async () => {
    const inputDir = join(tmpDir, 'input');
    mkdirSync(inputDir, { recursive: true });

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    // Short timeout — we just want to verify the file was written
    await statusCommand({ ipcDir: tmpDir, timeoutMs: 50 });

    const { readdirSync } = await import('node:fs');
    const files = readdirSync(inputDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThan(0);

    exitSpy.mockRestore();
    consoleSpy.mockRestore();
  });

  it('displays status when daemon responds successfully', async () => {
    const outputDir = join(tmpDir, 'output');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    // We need to capture the command ID to write a matching response.
    // The command writes to input/ and we respond from output/.
    // Intercept the write by watching the input directory.

    let commandId: string | null = null;
    const inputDir = join(tmpDir, 'input');
    mkdirSync(inputDir, { recursive: true });
    mkdirSync(outputDir, { recursive: true });

    // Watch input dir for new files and write a matching response.
    const { watch } = await import('node:fs');
    const watcher = watch(inputDir, async (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(join(inputDir, filename), 'utf8');
        const cmd = JSON.parse(content) as { id: string; command: string };
        if (cmd.command === 'status' && !commandId) {
          commandId = cmd.id;
          await writeFakeResponse(outputDir, cmd.id, {
            uptimeMs: 60000,
            activeContainers: 2,
            queueDepth: 5,
            personaCount: 3,
            channelCount: 2,
            deadLetterCount: 0,
          });
        }
      } catch {
        // Ignore parse errors from empty/incomplete files
      }
    });

    await statusCommand({ ipcDir: tmpDir, timeoutMs: 2000 });

    watcher.close();

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    // Status output should contain uptime and counts
    expect(output).toContain('talond status');
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
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    // Write error response when a command comes in
    const { watch } = await import('node:fs');
    const watcher = watch(inputDir, async (event, filename) => {
      if (!filename || !filename.endsWith('.json')) return;
      try {
        const { readFileSync } = await import('node:fs');
        const content = readFileSync(join(inputDir, filename), 'utf8');
        const cmd = JSON.parse(content) as { id: string; command: string };
        if (cmd.command === 'status') {
          // Write an error response
          const response = {
            id: randomUUID(),
            commandId: cmd.id,
            success: false,
            error: 'Internal daemon error',
          };
          const fname = `${Date.now()}-${randomUUID().replace(/-/g, '')}.json`;
          writeFileSync(join(outputDir, fname), JSON.stringify(response));
        }
      } catch {
        // Ignore
      }
    });

    await statusCommand({ ipcDir: tmpDir, timeoutMs: 2000 });

    watcher.close();

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
