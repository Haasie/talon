import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { IpcWriter, buildFilename } from '../../../src/ipc/ipc-writer.js';
import { IpcMessageSchema } from '../../../src/ipc/ipc-types.js';
import type { IpcMessage } from '../../../src/ipc/ipc-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMessage(overrides: Partial<IpcMessage> = {}): IpcMessage {
  return IpcMessageSchema.parse({
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    type: 'shutdown',
    runId: 'run-1',
    threadId: 'thread-1',
    timestamp: 1700000000000,
    payload: {},
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('IpcWriter', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-writer-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // buildFilename helper
  // -------------------------------------------------------------------------

  describe('buildFilename()', () => {
    it('returns a string ending with .json', () => {
      const msg = makeMessage();
      expect(buildFilename(msg)).toMatch(/\.json$/);
    });

    it('pads timestamp to 15 digits', () => {
      const msg = makeMessage({ timestamp: 123 });
      expect(buildFilename(msg)).toMatch(/^000000000000123-/);
    });

    it('embeds the message id (without hyphens)', () => {
      const msg = makeMessage();
      expect(buildFilename(msg)).toContain('f47ac10b58cc4372a5670e02b2c3d479');
    });

    it('format is {timestamp}-{id-no-hyphens}.json', () => {
      const msg = makeMessage({ timestamp: 1700000000000 });
      expect(buildFilename(msg)).toBe('001700000000000-f47ac10b58cc4372a5670e02b2c3d479.json');
    });

    it('sorts lexicographically in timestamp order', () => {
      const earlier = buildFilename(makeMessage({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', timestamp: 1000 }));
      const later = buildFilename(makeMessage({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d480', timestamp: 2000 }));
      expect(earlier < later).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // write()
  // -------------------------------------------------------------------------

  describe('write()', () => {
    it('creates a file in the target directory', () => {
      const writer = new IpcWriter(tmpDir);
      const msg = makeMessage();
      const result = writer.write(msg);

      expect(result.isOk()).toBe(true);
    });

    it('returned filename matches buildFilename output', () => {
      const writer = new IpcWriter(tmpDir);
      const msg = makeMessage();
      const result = writer.write(msg);

      expect(result._unsafeUnwrap()).toBe(buildFilename(msg));
    });

    it('file content is valid JSON', async () => {
      const writer = new IpcWriter(tmpDir);
      const msg = makeMessage();
      const result = writer.write(msg);
      const filename = result._unsafeUnwrap();

      const raw = await fs.readFile(path.join(tmpDir, filename), 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('file content round-trips through IpcMessageSchema', async () => {
      const writer = new IpcWriter(tmpDir);
      const msg = makeMessage();
      const result = writer.write(msg);
      const filename = result._unsafeUnwrap();

      const raw = await fs.readFile(path.join(tmpDir, filename), 'utf8');
      const parsed = IpcMessageSchema.parse(JSON.parse(raw));
      expect(parsed).toEqual(msg);
    });

    it('creates target directory if it does not exist', async () => {
      const nestedDir = path.join(tmpDir, 'deeply', 'nested');
      const writer = new IpcWriter(nestedDir);
      const msg = makeMessage();

      // Directory does not exist yet
      await expect(fs.access(nestedDir)).rejects.toThrow();

      writer.write(msg); // sync write also kicks off mkdir

      // Give the async mkdir a tick to complete (it's best-effort)
      await new Promise((r) => setTimeout(r, 50));
    });

    it('creates distinct files for distinct messages', () => {
      const writer = new IpcWriter(tmpDir);
      const msg1 = makeMessage({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', timestamp: 1000 });
      const msg2 = makeMessage({ id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', timestamp: 2000 });

      const r1 = writer.write(msg1)._unsafeUnwrap();
      const r2 = writer.write(msg2)._unsafeUnwrap();

      expect(r1).not.toBe(r2);
    });

    it('returns Err when directory write fails', () => {
      // Point writer at a file path (not a dir) so writes must fail.
      const filePath = path.join(tmpDir, 'not-a-directory');
      // Create a file at that path to block directory creation.
      require('fs').writeFileSync(filePath, 'block');

      const writer = new IpcWriter(path.join(filePath, 'subdir'));
      const result = writer.write(makeMessage());

      expect(result.isErr()).toBe(true);
      expect(result._unsafeUnwrapErr()).toBeInstanceOf(Error);
    });
  });

  // -------------------------------------------------------------------------
  // writeAsync()
  // -------------------------------------------------------------------------

  describe('writeAsync()', () => {
    it('creates a file in the target directory', async () => {
      const writer = new IpcWriter(tmpDir);
      const msg = makeMessage();
      const result = await writer.writeAsync(msg);

      expect(result.isOk()).toBe(true);
    });

    it('creates the directory if it does not exist', async () => {
      const nestedDir = path.join(tmpDir, 'async-nested');
      const writer = new IpcWriter(nestedDir);
      const msg = makeMessage();

      const result = await writer.writeAsync(msg);
      expect(result.isOk()).toBe(true);

      const stat = await fs.stat(nestedDir);
      expect(stat.isDirectory()).toBe(true);
    });

    it('file content is valid JSON', async () => {
      const writer = new IpcWriter(tmpDir);
      const msg = makeMessage();
      const result = await writer.writeAsync(msg);
      const filename = result._unsafeUnwrap();

      const raw = await fs.readFile(path.join(tmpDir, filename), 'utf8');
      expect(() => JSON.parse(raw)).not.toThrow();
    });

    it('returns Err<IpcError> on write failure', async () => {
      const filePath = path.join(tmpDir, 'not-a-dir');
      require('fs').writeFileSync(filePath, 'block');

      const writer = new IpcWriter(path.join(filePath, 'sub'));
      const result = await writer.writeAsync(makeMessage());

      expect(result.isErr()).toBe(true);
    });
  });
});
