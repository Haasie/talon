/**
 * Unit tests for the `talonctl add-channel` command.
 *
 * Uses real temp directories. Tests YAML reading/writing, duplicate detection,
 * placeholder config generation, and error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import yaml from 'js-yaml';

import { addChannelCommand } from '../../../src/cli/commands/add-channel.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'talon-add-channel-test-'));
}

/** Writes a minimal valid talond.yaml with no channels. */
function writeMinimalConfig(dir: string): string {
  const configPath = join(dir, 'talond.yaml');
  writeFileSync(configPath, 'logLevel: info\nchannels: []\n');
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

describe('addChannelCommand()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  it('adds a channel entry to an empty channels list', async () => {
    const configPath = writeMinimalConfig(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addChannelCommand({ name: 'my-telegram', type: 'telegram', configPath });

    const doc = readConfig(configPath);
    const channels = doc.channels as Array<Record<string, unknown>>;

    expect(channels).toHaveLength(1);
    expect(channels[0]!.name).toBe('my-telegram');
    expect(channels[0]!.type).toBe('telegram');
    expect(exitSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('appends a channel to an existing list', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    writeFileSync(
      configPath,
      'channels:\n  - name: existing\n    type: slack\nlogLevel: info\n',
    );

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addChannelCommand({ name: 'new-discord', type: 'discord', configPath });

    const doc = readConfig(configPath);
    const channels = doc.channels as Array<Record<string, unknown>>;

    expect(channels).toHaveLength(2);
    expect(channels[1]!.name).toBe('new-discord');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('rejects a duplicate channel name', async () => {
    const configPath = join(tmpDir, 'talond.yaml');
    writeFileSync(
      configPath,
      'channels:\n  - name: my-telegram\n    type: telegram\nlogLevel: info\n',
    );

    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addChannelCommand({ name: 'my-telegram', type: 'telegram', configPath });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('exits with code 1 when config file does not exist', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addChannelCommand({
      name: 'my-bot',
      type: 'telegram',
      configPath: join(tmpDir, 'nonexistent.yaml'),
    });

    expect(exitSpy).toHaveBeenCalledWith(1);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('adds telegram placeholder config', async () => {
    const configPath = writeMinimalConfig(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addChannelCommand({ name: 'tg-bot', type: 'telegram', configPath });

    const doc = readConfig(configPath);
    const channels = doc.channels as Array<Record<string, unknown>>;
    const ch = channels[0]!;

    expect(ch.config).toBeDefined();
    const config = ch.config as Record<string, unknown>;
    expect(config.token).toBeDefined();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('adds slack placeholder config with botToken and appToken', async () => {
    const configPath = writeMinimalConfig(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addChannelCommand({ name: 'slack-main', type: 'slack', configPath });

    const doc = readConfig(configPath);
    const channels = doc.channels as Array<Record<string, unknown>>;
    const config = channels[0]!.config as Record<string, unknown>;

    expect(config.botToken).toBeDefined();
    expect(config.appToken).toBeDefined();

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('sets enabled: true on the new channel', async () => {
    const configPath = writeMinimalConfig(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addChannelCommand({ name: 'tg', type: 'telegram', configPath });

    const doc = readConfig(configPath);
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels[0]!.enabled).toBe(true);

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('prints a confirmation message on success', async () => {
    const configPath = writeMinimalConfig(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addChannelCommand({ name: 'tg', type: 'telegram', configPath });

    const output = consoleSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(output).toContain('tg');
    expect(output).toContain('telegram');

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('handles unknown channel type with empty config', async () => {
    const configPath = writeMinimalConfig(tmpDir);

    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => undefined as never);

    await addChannelCommand({ name: 'custom-chan', type: 'custom', configPath });

    const doc = readConfig(configPath);
    const channels = doc.channels as Array<Record<string, unknown>>;
    expect(channels[0]!.config).toEqual({});

    consoleSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
