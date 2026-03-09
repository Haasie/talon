/**
 * Unit tests for the `talonctl add-skill` command.
 *
 * Tests both the pure `addSkill()` function (importable by setup skill /
 * terminal agent) and the `addSkillCommand()` CLI wrapper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { addSkill, addSkillCommand } from '../../../src/cli/commands/add-skill.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-add-skill-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(tmpDir, 'talond.yaml');
}

function writeConfigWithPersona(personaName: string): string {
  const p = configPath();
  writeFileSync(
    p,
    [
      'logLevel: info',
      'personas:',
      `  - name: ${personaName}`,
      '    model: claude-sonnet-4-6',
      '    skills: []',
    ].join('\n') + '\n',
  );
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
// addSkill() — pure function
// ---------------------------------------------------------------------------

describe('addSkill()', () => {
  it('creates the skill directory', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    await addSkill({ name: 'web-search', personaName: 'assistant', configPath: p, skillsDir });

    expect(existsSync(join(skillsDir, 'web-search'))).toBe(true);
  });

  it('creates the prompts/ subdirectory', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    await addSkill({ name: 'web-search', personaName: 'assistant', configPath: p, skillsDir });

    expect(existsSync(join(skillsDir, 'web-search', 'prompts'))).toBe(true);
  });

  it('creates a skill.yaml manifest', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    await addSkill({ name: 'web-search', personaName: 'assistant', configPath: p, skillsDir });

    const manifestPath = join(skillsDir, 'web-search', 'skill.yaml');
    expect(existsSync(manifestPath)).toBe(true);

    const content = readFileSync(manifestPath, 'utf-8');
    const manifest = yaml.load(content) as Record<string, unknown>;
    expect(manifest.name).toBe('web-search');
    expect(manifest.version).toBeDefined();
  });

  it('adds skill to persona skills list in config', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    const result = await addSkill({ name: 'web-search', personaName: 'assistant', configPath: p, skillsDir });

    expect(result.name).toBe('web-search');
    expect(result.personaName).toBe('assistant');

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    const skills = personas[0]!.skills as string[];
    expect(skills).toContain('web-search');
  });

  it('adds multiple skills to the same persona', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    await addSkill({ name: 'web-search', personaName: 'assistant', configPath: p, skillsDir });
    await addSkill({ name: 'code-runner', personaName: 'assistant', configPath: p, skillsDir });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    const skills = personas[0]!.skills as string[];
    expect(skills).toContain('web-search');
    expect(skills).toContain('code-runner');
    expect(skills).toHaveLength(2);
  });

  it('does not overwrite existing skill.yaml', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(skillsDir, 'web-search', 'prompts'), { recursive: true });
    const manifestPath = join(skillsDir, 'web-search', 'skill.yaml');
    writeFileSync(manifestPath, '# existing manifest\nname: web-search\n');

    await addSkill({ name: 'web-search', personaName: 'assistant', configPath: p, skillsDir });

    const content = readFileSync(manifestPath, 'utf-8');
    expect(content).toBe('# existing manifest\nname: web-search\n');
  });

  // --- Validation ---

  it('rejects an invalid skill name', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    await expect(addSkill({ name: 'bad name', personaName: 'assistant', configPath: p, skillsDir }))
      .rejects.toThrow(/invalid/);
  });

  it('rejects an empty skill name', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    await expect(addSkill({ name: '', personaName: 'assistant', configPath: p, skillsDir }))
      .rejects.toThrow(/must not be empty/);
  });

  it('throws when persona does not exist', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    await expect(addSkill({ name: 'web-search', personaName: 'nonexistent', configPath: p, skillsDir }))
      .rejects.toThrow(/not found/);
  });

  it('throws when skill already registered on persona', async () => {
    const p = writeYaml([
      'personas:',
      '  - name: assistant',
      '    model: claude-sonnet-4-6',
      '    skills:',
      '      - web-search',
    ].join('\n') + '\n');
    const skillsDir = join(tmpDir, 'skills');

    await expect(addSkill({ name: 'web-search', personaName: 'assistant', configPath: p, skillsDir }))
      .rejects.toThrow(/already registered/);
  });

  it('rejects an invalid persona name', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');

    await expect(addSkill({ name: 'web-search', personaName: 'bad persona', configPath: p, skillsDir }))
      .rejects.toThrow(/invalid/);
  });

  it('throws for non-existent config file', async () => {
    await expect(addSkill({
      name: 'web-search',
      personaName: 'assistant',
      configPath: join(tmpDir, 'nope.yaml'),
      skillsDir: join(tmpDir, 'skills'),
    })).rejects.toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// addSkillCommand() — CLI wrapper
// ---------------------------------------------------------------------------

describe('addSkillCommand()', () => {
  it('prints confirmation on success', async () => {
    const p = writeConfigWithPersona('assistant');
    const skillsDir = join(tmpDir, 'skills');
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await addSkillCommand({ name: 'web-search', personaName: 'assistant', configPath: p, skillsDir });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('web-search');
    expect(output).toContain('assistant');
    consoleSpy.mockRestore();
  });

  it('exits with code 1 on error', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

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
});
