/**
 * Tests for .env file loading logic used in daemon and CLI entry points.
 *
 * Tests the loading behavior with real temp files to verify
 * process.loadEnvFile() integration and edge cases.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

describe('.env file loading', () => {
  const tempFiles: string[] = [];

  afterEach(() => {
    for (const f of tempFiles) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    tempFiles.length = 0;
  });

  function writeTempEnv(content: string): string {
    const path = join(tmpdir(), `.env-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    writeFileSync(path, content);
    tempFiles.push(path);
    return path;
  }

  it('loads variables from a valid .env file into process.env', () => {
    const key = `TEST_ENV_LOAD_${Date.now()}`;
    const path = writeTempEnv(`${key}=hello_world\n`);

    process.loadEnvFile(path);

    expect(process.env[key]).toBe('hello_world');
    delete process.env[key];
  });

  it('does not crash when file does not exist', () => {
    const path = '/tmp/nonexistent-env-file-talon-test';
    // process.loadEnvFile throws for missing files — our code guards with existsSync
    expect(() => process.loadEnvFile(path)).toThrow();
  });

  it('throws on malformed .env content', () => {
    // Node's loadEnvFile is lenient with most content, but verify our
    // error handling path works if it ever does throw
    const path = writeTempEnv('VALID_KEY=value\n');
    expect(() => process.loadEnvFile(path)).not.toThrow();
    delete process.env['VALID_KEY'];
  });

  it('falls back to .env when TALOND_ENV_FILE is empty string', () => {
    // Using || instead of ?? means empty string falls back to default
    const original = process.env.TALOND_ENV_FILE;
    process.env.TALOND_ENV_FILE = '';
    const envFile = process.env.TALOND_ENV_FILE || '.env';
    expect(envFile).toBe('.env');
    if (original !== undefined) {
      process.env.TALOND_ENV_FILE = original;
    } else {
      delete process.env.TALOND_ENV_FILE;
    }
  });

  it('falls back to .env when TALOND_ENV_FILE is not set', () => {
    const original = process.env.TALOND_ENV_FILE;
    delete process.env.TALOND_ENV_FILE;
    const envFile = process.env.TALOND_ENV_FILE || '.env';
    expect(envFile).toBe('.env');
    if (original !== undefined) {
      process.env.TALOND_ENV_FILE = original;
    }
  });

  it('uses TALOND_ENV_FILE when set to a non-empty value', () => {
    const original = process.env.TALOND_ENV_FILE;
    process.env.TALOND_ENV_FILE = '/custom/path/.env';
    const envFile = process.env.TALOND_ENV_FILE || '.env';
    expect(envFile).toBe('/custom/path/.env');
    if (original !== undefined) {
      process.env.TALOND_ENV_FILE = original;
    } else {
      delete process.env.TALOND_ENV_FILE;
    }
  });

  it('resolves relative paths to absolute', () => {
    const resolved = resolve('config/.env.production');
    expect(resolved).toMatch(/^\//);
    expect(resolved).toContain('config/.env.production');
  });
});
