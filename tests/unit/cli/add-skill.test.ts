/**
 * Unit tests for the `talonctl add-skill` command.
 *
 * Uses real temp directories. Tests skill directory scaffolding, manifest
 * generation, persona skill list updates, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { addSkillCommand } from '../../../src/cli/commands/add-skill.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-add-skill-test-'));
}

/** Writes a talond.yaml with a single persona. */
function writeConfigWithPersona(dir: string, personaName: string): string {
  const configPath = join(dir, 'talond.yaml');
  writeFileSync(
    configPath,
    [
      'logLevel: info',
      'personas:',
      `  - name: ${personaName}`,
      '    model: claude-sonnet-4-6',
      '    skills: []',
    ].join('\n') + '\n',
  );
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

describe('addSkillCommand()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('creates the skill directory', async () => {
    const configPath = writeConfigWithPersona(tmpDir, 'assistant');
    const skillsDir = join(tmpDir, 'skills');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    expect(existsSync(join(skillsDir, 'web-search'))).toBe(true);
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('creates the prompts/ subdirectory', async () => {
    const configPath = writeConfigWithPersona(tmpDir, 'assistant');
    const skillsDir = join(tmpDir, 'skills');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    expect(existsSync(join(skillsDir, 'web-search', 'prompts'))).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('creates a skill.yaml manifest', async () => {
    const configPath = writeConfigWithPersona(tmpDir, 'assistant');
    const skillsDir = join(tmpDir, 'skills');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    const manifestPath = join(skillsDir, 'web-search', 'skill.yaml');
    expect(existsSync(manifestPath)).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('skill.yaml manifest contains expected fields', async () => {
    const configPath = writeConfigWithPersona(tmpDir, 'assistant');
    const skillsDir = join(tmpDir, 'skills');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    const manifestPath = join(skillsDir, 'web-search', 'skill.yaml');
    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = yaml.load(content) as Record<string, unknown>;

    expect(manifest.name).toBe('web-search');
    expect(manifest.version).toBeDefined();
    expect(manifest.description).toBeDefined();
    expect(Array.isArray(manifest.prompts)).toBe(true);
    expect(manifest.capabilities).toBeDefined();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('adds skill to persona skills list in talond.yaml', async () => {
    const configPath = writeConfigWithPersona(tmpDir, 'assistant');
    const skillsDir = join(tmpDir, 'skills');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    const doc = readConfig(configPath);
    const personas = doc.personas as Array<Record<string, unknown>>;
    const skills = personas[0]!.skills as string[];

    expect(skills).toContain('web-search');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when persona does not exist', async () => {
    const configPath = writeConfigWithPersona(tmpDir, 'assistant');
    const skillsDir = join(tmpDir, 'skills');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'nonexistent',
      configPath,
      skillsDir,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when skill already registered on persona', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    writeFileSync(
      configPath,
      [
        'logLevel: info',
        'personas:',
        '  - name: assistant',
        '    model: claude-sonnet-4-6',
        '    skills:',
        '      - web-search',
      ].join('\n') + '\n',
    );
    const skillsDir = join(tmpDir, 'skills');

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when config file does not exist', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath: join(tmpDir, 'nonexistent.yaml'),
      skillsDir: join(tmpDir, 'skills'),
    });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('does not overwrite existing skill.yaml', async () => {
    const configPath = writeConfigWithPersona(tmpDir, 'assistant');
    const skillsDir = join(tmpDir, 'skills');

    // Pre-create skill directory and manifest
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(skillsDir, 'web-search', 'prompts'), { recursive: true });
    const manifestPath = join(skillsDir, 'web-search', 'skill.yaml');
    writeFileSync(manifestPath, '# existing manifest\nname: web-search\n');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    const content = readFileSync(manifestPath, 'utf-8');
    expect(content).toBe('# existing manifest\nname: web-search\n');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints a confirmation message on success', async () => {
    const configPath = writeConfigWithPersona(tmpDir, 'assistant');
    const skillsDir = join(tmpDir, 'skills');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('web-search');
    expect(output).toContain('assistant');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('adds multiple skills to the same persona', async () => {
    const configPath = writeConfigWithPersona(tmpDir, 'assistant');
    const skillsDir = join(tmpDir, 'skills');

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addSkillCommand({
      name: 'web-search',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    await addSkillCommand({
      name: 'code-runner',
      personaName: 'assistant',
      configPath,
      skillsDir,
    });

    const doc = readConfig(configPath);
    const personas = doc.personas as Array<Record<string, unknown>>;
    const skills = personas[0]!.skills as string[];

    expect(skills).toContain('web-search');
    expect(skills).toContain('code-runner');
    expect(skills).toHaveLength(2);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
