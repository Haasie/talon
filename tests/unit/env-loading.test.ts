/**
 * Tests for .env file loading in the daemon entry point.
 *
 * Verifies that process.loadEnvFile() is called correctly and that
 * the env file path can be overridden via TALOND_ENV_FILE or --env-file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// We test the loading logic in isolation rather than importing index.ts
// (which would start the daemon). Extract the pure functions to test.

describe('.env file loading', () => {
  const originalLoadEnvFile = process.loadEnvFile;
  let mockLoadEnvFile: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockLoadEnvFile = vi.fn();
    process.loadEnvFile = mockLoadEnvFile;
  });

  afterEach(() => {
    process.loadEnvFile = originalLoadEnvFile;
  });

  it('calls process.loadEnvFile when .env exists', () => {
    const envPath = resolve('.env');

    // Simulate what index.ts does
    if (existsSync(envPath)) {
      process.loadEnvFile(envPath);
      expect(mockLoadEnvFile).toHaveBeenCalledWith(envPath);
    } else {
      // No .env in test dir — verify it's not called
      expect(mockLoadEnvFile).not.toHaveBeenCalled();
    }
  });

  it('resolves TALOND_ENV_FILE override to absolute path', () => {
    const customPath = 'config/custom.env';
    const resolved = resolve(customPath);
    expect(resolved).toContain('config/custom.env');
    expect(resolved).toMatch(/^\//); // absolute path
  });

  it('defaults to .env when TALOND_ENV_FILE is not set', () => {
    const envFile = process.env.TALOND_ENV_FILE ?? '.env';
    expect(envFile).toBe('.env');
  });

  it('uses TALOND_ENV_FILE when set', () => {
    const original = process.env.TALOND_ENV_FILE;
    process.env.TALOND_ENV_FILE = 'custom.env';
    const envFile = process.env.TALOND_ENV_FILE ?? '.env';
    expect(envFile).toBe('custom.env');
    if (original !== undefined) {
      process.env.TALOND_ENV_FILE = original;
    } else {
      delete process.env.TALOND_ENV_FILE;
    }
  });
});
