import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { removePersona } from '../../../src/cli/commands/remove-persona.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-remove-persona-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function configPath(): string {
  return join(tmpDir, 'talond.yaml');
}

function writeYaml(content: string): string {
  const p = configPath();
  writeFileSync(p, content);
  return p;
}

function readYaml(p: string): Record<string, unknown> {
  return (yaml.load(readFileSync(p, 'utf-8')) ?? {}) as Record<string, unknown>;
}

describe('removePersona()', () => {
  it('removes a persona by name', async () => {
    const p = writeYaml('personas:\n  - name: assistant\n    model: claude-sonnet-4-6\n  - name: coder\n    model: claude-sonnet-4-6\n');
    await removePersona({ name: 'assistant', configPath: p });

    const doc = readYaml(p);
    const personas = doc.personas as Array<Record<string, unknown>>;
    expect(personas).toHaveLength(1);
    expect(personas[0]!.name).toBe('coder');
  });

  it('removes related bindings and returns warning', async () => {
    const p = writeYaml('personas:\n  - name: assistant\nbindings:\n  - persona: assistant\n    channel: tg\n');
    const { warnings } = await removePersona({ name: 'assistant', configPath: p });

    expect(warnings.some((w) => w.includes('binding'))).toBe(true);
  });

  it('warns about existing persona directory', async () => {
    const personasDir = join(tmpDir, 'personas');
    mkdirSync(join(personasDir, 'assistant'), { recursive: true });

    const p = writeYaml('personas:\n  - name: assistant\n');
    const { warnings } = await removePersona({ name: 'assistant', configPath: p, personasDir });

    expect(warnings.some((w) => w.includes('directory'))).toBe(true);
  });

  it('throws when persona not found', async () => {
    const p = writeYaml('personas:\n  - name: assistant\n');
    await expect(removePersona({ name: 'nonexistent', configPath: p }))
      .rejects.toThrow(/not found/);
  });

  it('rejects invalid name', async () => {
    const p = writeYaml('personas: []\n');
    await expect(removePersona({ name: 'bad name', configPath: p }))
      .rejects.toThrow(/invalid/);
  });
});
