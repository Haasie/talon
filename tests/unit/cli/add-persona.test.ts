/**
 * Unit tests for the `talonctl add-persona` command.
 *
 * Tests both the pure `addPersona()` function (importable by setup skill /
 * terminal agent) and the `addPersonaCommand()` CLI wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { addPersona, addPersonaCommand } from '../../../src/cli/commands/add-persona.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-add-persona-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(tmpDir, 'talond.yaml');
}

function writeMinimalConfig(): string {
  const p = configPath();
  writeFileSync(p, 'logLevel: info\npersonas: []\n');
  return p;
}

function writeYaml(content: string): string {
  const p = configPath();
  writeFileSync(p, content);
  return p;
}

function readYaml(p: string): Record<string, unknown> {
  return (yaml.load(readFileSync(p, 'utf-8')) ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// addPersona() — pure function
// ---------------------------------------------------------------------------

describe('addPersona()', () => {
  it('creates the persona directory', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'assistant', configPath: p, personasDir });

    expect(existsSync(join(personasDir, 'assistant'))).toBe(true);
  });

  it('creates system.md in the persona directory', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'helper', configPath: p, personasDir });

    const systemPromptPath = join(personasDir, 'helper', 'system.md');
    expect(existsSync(systemPromptPath)).toBe(true);
    const content = readFileSync(systemPromptPath, 'utf-8');
    expect(content).toContain('helper');
  });

  it('adds persona entry to talond.yaml', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    const result = await addPersona({ name: 'assistant', configPath: p, personasDir });

    expect(result.name).toBe('assistant');
    expect(result.model).toBeDefined();
    expect(result.systemPromptFile).toBeDefined();
    expect(result.skills).toEqual([]);

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(1);
    expect(personas[0]!.name).toBe('assistant');
  });

  it('appends to an existing personas list', async () => {
    const p = writeYaml('personas:\n  - name: existing\n    model: claude-sonnet-4-6\n');
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'new-agent', configPath: p, personasDir });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(2);
    expect(personas[1]!.name).toBe('new-agent');
  });

  it('does not overwrite existing system.md', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    // Pre-create persona dir and custom system.md
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(personasDir, 'assistant'), { recursive: true });
    const systemPromptPath = join(personasDir, 'assistant', 'system.md');
    writeFileSync(systemPromptPath, '# Custom content\n');

    await addPersona({ name: 'assistant', configPath: p, personasDir });

    const content = readFileSync(systemPromptPath, 'utf-8');
    expect(content).toBe('# Custom content\n');
  });

  it('creates a personality directory with example file', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'alfred', configPath: p, personasDir });

    const personalityDir = join(personasDir, 'alfred', 'personality');
    const example = readFileSync(join(personalityDir, '01-tone.md'), 'utf-8');
    expect(example).toContain('Tone');
  });

  it('does not scaffold personality for existing persona directories', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    // Pre-create persona dir with system.md (simulates existing persona)
    const { mkdirSync } = await import('node:fs');
    const personaDir = join(personasDir, 'custom-agent');
    mkdirSync(personaDir, { recursive: true });
    writeFileSync(join(personaDir, 'system.md'), '# Existing prompt\n');

    await addPersona({ name: 'custom-agent', configPath: p, personasDir });

    // Personality folder should NOT have been created for existing persona
    const { existsSync } = await import('node:fs');
    expect(existsSync(join(personaDir, 'personality'))).toBe(false);
  });

  it('creates personas array if missing from config', async () => {
    const p = writeYaml('logLevel: info\n');
    const personasDir = join(tmpDir, 'personas');

    await addPersona({ name: 'assistant', configPath: p, personasDir });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(1);
  });

  // --- Validation ---

  it('rejects a duplicate persona name', async () => {
    const p = writeYaml('personas:\n  - name: assistant\n    model: claude-sonnet-4-6\n');
    const personasDir = join(tmpDir, 'personas');

    await expect(addPersona({ name: 'assistant', configPath: p, personasDir }))
      .rejects.toThrow(/already exists/);
  });

  it('rejects an invalid persona name', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await expect(addPersona({ name: 'bad name', configPath: p, personasDir }))
      .rejects.toThrow(/invalid/);
  });

  it('rejects an empty persona name', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');

    await expect(addPersona({ name: '', configPath: p, personasDir }))
      .rejects.toThrow(/must not be empty/);
  });

  it('throws for non-existent config file', async () => {
    await expect(addPersona({ name: 'bot', configPath: join(tmpDir, 'nope.yaml'), personasDir: join(tmpDir, 'personas') }))
      .rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// addPersonaCommand() — CLI wrapper
// ---------------------------------------------------------------------------

describe('addPersonaCommand()', () => {
  it('prints confirmation on success', async () => {
    const p = writeMinimalConfig();
    const personasDir = join(tmpDir, 'personas');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await addPersonaCommand({ name: 'assistant', configPath: p, personasDir });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('assistant');
    consoleSpy.mockRestore();
  });

  it('exits with code 1 on error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await addPersonaCommand({ name: 'bot', configPath: join(tmpDir, 'nonexistent.yaml'), personasDir: join(tmpDir, 'personas') });

    expect(exitSpy).toHaveBeenCalledWith(1);
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints error message for invalid name', async () => {
    const p = writeMinimalConfig();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    await addPersonaCommand({ name: 'bad name', configPath: p, personasDir: join(tmpDir, 'personas') });

    expect(exitSpy).toHaveBeenCalledWith(1);
    const errOutput = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(errOutput).toContain('invalid');
    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
