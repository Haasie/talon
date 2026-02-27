/**
 * Unit tests for the `talonctl add-persona` command.
 *
 * Uses real temp directories. Tests directory scaffolding, system prompt
 * file creation, config updates, and duplicate detection.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { addPersonaCommand } from '../../../src/cli/commands/add-persona.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-add-persona-test-'));
}

/** Writes a minimal talond.yaml with an empty personas array. */
function writeMinimalConfig(dir: string): string {
  const configPath = join(dir, 'talond.yaml');
  writeFileSync(configPath, 'logLevel: info\npersonas: []\n');
  return configPath;
}

/** Reads and parses the YAML at configPath. */
function readConfig(configPath: string): Record<string, unknown> {
  const content = readFileSync(configPath, 'utf-8');
  return (yaml.load(content) ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('addPersonaCommand()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('creates the persona directory', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const personasDir = join(tmpDir, 'personas');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'assistant', configPath, personasDir });

    expect(existsSync(join(personasDir, 'assistant'))).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('creates system.md in the persona directory', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const personasDir = join(tmpDir, 'personas');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'helper', configPath, personasDir });

    const systemPromptPath = join(personasDir, 'helper', 'system.md');
    expect(existsSync(systemPromptPath)).toBe(true);
    const content = readFileSync(systemPromptPath, 'utf-8');
    expect(content.length).toBeGreaterThan(0);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('system.md contains the persona name', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const personasDir = join(tmpDir, 'personas');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'my-agent', configPath, personasDir });

    const systemPromptPath = join(personasDir, 'my-agent', 'system.md');
    const content = readFileSync(systemPromptPath, 'utf-8');
    expect(content).toContain('my-agent');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('adds persona entry to talond.yaml', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const personasDir = join(tmpDir, 'personas');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'assistant', configPath, personasDir });

    const doc = readConfig(configPath);
    const personas = doc.personas as Array<Record<string, unknown>>;

    expect(personas).toHaveLength(1);
    expect(personas[0]!.name).toBe('assistant');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('persona entry has model and systemPromptFile fields', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const personasDir = join(tmpDir, 'personas');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'assistant', configPath, personasDir });

    const doc = readConfig(configPath);
    const personas = doc.personas as Array<Record<string, unknown>>;

    expect(personas[0]!.model).toBeDefined();
    expect(personas[0]!.systemPromptFile).toBeDefined();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('persona entry has an empty skills list', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const personasDir = join(tmpDir, 'personas');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'assistant', configPath, personasDir });

    const doc = readConfig(configPath);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas[0]!.skills).toEqual([]);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('appends to an existing personas list', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    writeFileSync(
      configPath,
      'personas:\n  - name: existing\n    model: claude-sonnet-4-6\nlogLevel: info\n',
    );
    const personasDir = join(tmpDir, 'personas');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'new-agent', configPath, personasDir });

    const doc = readConfig(configPath);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(2);
    expect(personas[1]!.name).toBe('new-agent');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects a duplicate persona name', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    writeFileSync(
      configPath,
      'personas:\n  - name: assistant\n    model: claude-sonnet-4-6\nlogLevel: info\n',
    );
    const personasDir = join(tmpDir, 'personas');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'assistant', configPath, personasDir });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when config file does not exist', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({
      name: 'assistant',
      configPath: join(tmpDir, 'nonexistent.yaml'),
      personasDir: join(tmpDir, 'personas'),
    });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints a confirmation message on success', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const personasDir = join(tmpDir, 'personas');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'assistant', configPath, personasDir });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('assistant');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('does not overwrite existing system.md', async () => {
    const configPath = writeMinimalConfig(tmpDir);
    const personasDir = join(tmpDir, 'personas');

    // Pre-create persona dir and custom system.md
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(personasDir, 'assistant'), { recursive: true });
    const systemPromptPath = join(personasDir, 'assistant', 'system.md');
    writeFileSync(systemPromptPath, '# Custom content\n');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addPersonaCommand({ name: 'assistant', configPath, personasDir });

    const content = readFileSync(systemPromptPath, 'utf-8');
    expect(content).toBe('# Custom content\n');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
