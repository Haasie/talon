import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import yaml from 'js-yaml';

import { removeChannel } from '../../../src/cli/commands/remove-channel.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-remove-channel-test-'));
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

describe('removeChannel()', () => {
  it('removes a channel by name', async () => {
    const p = writeYaml('channels:\n  - name: tg\n    type: telegram\n  - name: slack-main\n    type: slack\n');
    await removeChannel({ name: 'tg', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(1);
    expect(channels[0]!.name).toBe('slack-main');
  });

  it('removes related bindings and returns warning', async () => {
    const p = writeYaml('channels:\n  - name: tg\n    type: telegram\nbindings:\n  - persona: assistant\n    channel: tg\n');
    const { warnings } = await removeChannel({ name: 'tg', configPath: p });

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('binding');

    const doc = readYaml(p);
    const bindings = doc.bindings as Array<Record<string, unknown>>;
    expect(bindings).toHaveLength(0);
  });

  it('throws when channel not found', async () => {
    const p = writeYaml('channels:\n  - name: tg\n    type: telegram\n');
    await expect(removeChannel({ name: 'nonexistent', configPath: p }))
      .rejects.toThrow(/not found/);
  });

  it('throws when no channels array', async () => {
    const p = writeYaml('logLevel: info\n');
    await expect(removeChannel({ name: 'tg', configPath: p }))
      .rejects.toThrow(/not found/);
  });

  it('rejects empty name', async () => {
    const p = writeYaml('channels: []\n');
    await expect(removeChannel({ name: '', configPath: p }))
      .rejects.toThrow(/required/);
  });

  it('allows removing channels with legacy names (dots, spaces)', async () => {
    const p = writeYaml('channels:\n  - name: my.old.channel\n    type: telegram\n');
    await removeChannel({ name: 'my.old.channel', configPath: p });

    const doc = readYaml(p);
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels).toHaveLength(0);
  });
});
