import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { listPersonas } from '../../../src/cli/commands/list-personas.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-list-personas-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function writeYaml(content: string): string {
  const p = join(tmpDir, 'talond.yaml');
  writeFileSync(p, content);
  return p;
}

describe('listPersonas()', () => {
  it('returns empty array when no personas configured', async () => {
    const p = writeYaml('logLevel: info\n');
    const result = await listPersonas({ configPath: p });
    expect(result).toEqual([]);
  });

  it('returns persona info with skill count', async () => {
    const p = writeYaml('personas:\n  - name: assistant\n    model: claude-sonnet-4-6\n    skills:\n      - web-search\n      - code-runner\n  - name: helper\n');
    const result = await listPersonas({ configPath: p });

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ name: 'assistant', model: 'claude-sonnet-4-6', skillCount: 2 });
    expect(result[1]).toEqual({ name: 'helper', model: '(default)', skillCount: 0 });
  });

  it('throws for non-existent config', async () => {
    await expect(listPersonas({ configPath: join(tmpDir, 'nope.yaml') }))
      .rejects.toThrow(/not found/);
  });
});
