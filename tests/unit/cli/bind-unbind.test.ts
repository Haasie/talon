import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { bind } from '../../../src/cli/commands/bind.js';
import { unbind } from '../../../src/cli/commands/unbind.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-bind-test-'));
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

const fullConfig = `
channels:
  - name: my-telegram
    type: telegram
  - name: slack-main
    type: slack
personas:
  - name: assistant
    model: claude-sonnet-4-6
  - name: coder
    model: claude-sonnet-4-6
`;

describe('bind()', () => {
  it('creates a binding between persona and channel', async () => {
    const p = writeYaml(fullConfig);
    const result = await bind({ persona: 'assistant', channel: 'my-telegram', configPath: p });

    expect(result.persona).toBe('assistant');
    expect(result.channel).toBe('my-telegram');

    const doc = readYaml(p);
    const bindings = doc.bindings as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(1);
    expect(bindings[0]!.persona).toBe('assistant');
    expect(bindings[0]!.channel).toBe('my-telegram');
  });

  it('sets isDefault true for first binding on a channel', async () => {
    const p = writeYaml(fullConfig);
    await bind({ persona: 'assistant', channel: 'my-telegram', configPath: p });

    const doc = readYaml(p);
    const bindings = doc.bindings as Array<Record<string, unknown>>;
    expect(bindings[0]!.isDefault).toBe(true);
  });

  it('sets isDefault false for subsequent bindings on same channel', async () => {
    const p = writeYaml(fullConfig);
    await bind({ persona: 'assistant', channel: 'my-telegram', configPath: p });
    await bind({ persona: 'coder', channel: 'my-telegram', configPath: p });

    const doc = readYaml(p);
    const bindings = doc.bindings as Array<Record<string, unknown>>;
    expect(bindings[1]!.isDefault).toBe(false);
  });

  it('throws when persona not found', async () => {
    const p = writeYaml(fullConfig);
    await expect(bind({ persona: 'nonexistent', channel: 'my-telegram', configPath: p }))
      .rejects.toThrow(/Persona.*not found/);
  });

  it('throws when channel not found', async () => {
    const p = writeYaml(fullConfig);
    await expect(bind({ persona: 'assistant', channel: 'nonexistent', configPath: p }))
      .rejects.toThrow(/Channel.*not found/);
  });

  it('throws on duplicate binding', async () => {
    const p = writeYaml(fullConfig);
    await bind({ persona: 'assistant', channel: 'my-telegram', configPath: p });
    await expect(bind({ persona: 'assistant', channel: 'my-telegram', configPath: p }))
      .rejects.toThrow(/already bound/);
  });

  it('rejects invalid persona name', async () => {
    const p = writeYaml(fullConfig);
    await expect(bind({ persona: 'bad name', channel: 'my-telegram', configPath: p }))
      .rejects.toThrow(/invalid/);
  });
});

describe('unbind()', () => {
  it('removes an existing binding', async () => {
    const p = writeYaml(fullConfig);
    await bind({ persona: 'assistant', channel: 'my-telegram', configPath: p });
    await unbind({ persona: 'assistant', channel: 'my-telegram', configPath: p });

    const doc = readYaml(p);
    const bindings = doc.bindings as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(0);
  });

  it('throws when binding does not exist', async () => {
    const p = writeYaml(fullConfig);
    await expect(unbind({ persona: 'assistant', channel: 'my-telegram', configPath: p }))
      .rejects.toThrow(/No binding exists/);
  });

  it('throws when no bindings array exists', async () => {
    const p = writeYaml('channels: []\npersonas: []\n');
    await expect(unbind({ persona: 'assistant', channel: 'my-telegram', configPath: p }))
      .rejects.toThrow(/No binding exists/);
  });
});
