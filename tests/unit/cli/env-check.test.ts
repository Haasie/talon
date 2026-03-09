import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { envCheck } from '../../../src/cli/commands/env-check.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-env-check-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function writeYaml(content: string): string {
  const p = join(tmpDir, 'talond.yaml');
  writeFileSync(p, content);
  return p;
}

describe('envCheck()', () => {
  it('returns empty array when no env vars referenced', async () => {
    const p = writeYaml('logLevel: info\n');
    const result = await envCheck({ configPath: p });
    expect(result).toEqual([]);
  });

  it('finds env var placeholders', async () => {
    const p = writeYaml('channels:\n  - token: ${TELEGRAM_TOKEN}\n    key: ${API_KEY}\n');
    const result = await envCheck({ configPath: p });

    expect(result).toHaveLength(2);
    expect(result.map((v) => v.name)).toEqual(['API_KEY', 'TELEGRAM_TOKEN']);
  });

  it('reports set/unset status', async () => {
    process.env.TEST_ENV_CHECK_VAR = 'hello';
    const p = writeYaml('token: ${TEST_ENV_CHECK_VAR}\nother: ${MISSING_VAR_12345}\n');
    const result = await envCheck({ configPath: p });

    const testVar = result.find((v) => v.name === 'TEST_ENV_CHECK_VAR');
    const missingVar = result.find((v) => v.name === 'MISSING_VAR_12345');

    expect(testVar?.isSet).toBe(true);
    expect(missingVar?.isSet).toBe(false);

    delete process.env.TEST_ENV_CHECK_VAR;
  });

  it('deduplicates env var references', async () => {
    const p = writeYaml('a: ${MY_VAR}\nb: ${MY_VAR}\nc: ${MY_VAR}\n');
    const result = await envCheck({ configPath: p });
    expect(result).toHaveLength(1);
  });

  it('throws for non-existent config', async () => {
    await expect(envCheck({ configPath: join(tmpDir, 'nope.yaml') }))
      .rejects.toThrow(/not found/);
  });
});
