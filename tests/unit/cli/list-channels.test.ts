import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listChannels } from '../../../src/cli/commands/list-channels.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-list-channels-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function writeYaml(content: string): string {
  const p = join(tmpDir, 'talond.yaml');
  writeFileSync(p, content);
  return p;
}

describe('listChannels()', () => {
  it('returns empty array when no channels configured', async () => {
    const p = writeYaml('logLevel: info\n');
    const result = await listChannels({ configPath: p });
    expect(result).toEqual([]);
  });

  it('returns channel info', async () => {
    const p = writeYaml('channels:\n  - name: tg\n    type: telegram\n  - name: slack-main\n    type: slack\n    enabled: false\n');
    const result = await listChannels({ configPath: p });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'tg', type: 'telegram', enabled: true });
    expect(result[1]).toEqual({ name: 'slack-main', type: 'slack', enabled: false });
  });

  it('defaults enabled to true when not specified', async () => {
    const p = writeYaml('channels:\n  - name: tg\n    type: telegram\n');
    const result = await listChannels({ configPath: p });
    expect(result[0]!.enabled).toBe(true);
  });

  it('throws for non-existent config', async () => {
    await expect(listChannels({ configPath: join(tmpDir, 'nope.yaml') }))
      .rejects.toThrow(/not found/);
  });
});
