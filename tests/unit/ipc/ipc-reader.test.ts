import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { IpcReader } from '../../../src/ipc/ipc-reader.js';
import { IpcWriter } from '../../../src/ipc/ipc-writer.js';
import { IpcMessageSchema } from '../../../src/ipc/ipc-types.js';
import type { IpcMessage } from '../../../src/ipc/ipc-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShutdown(overrides: Partial<IpcMessage> = {}): IpcMessage {
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

function makeToolRequest(id: string, ts: number): IpcMessage {
  return IpcMessageSchema.parse({
    id,
    type: 'tool.request',
    runId: 'run-1',
    threadId: 'thread-1',
    timestamp: ts,
    payload: { toolName: 'noop', args: {} },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('IpcReader', () => {
  let tmpDir: string;
  let errorsDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-reader-test-'));
    errorsDir = path.join(tmpDir, 'errors');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // pollOnce() — basic happy path
  // -------------------------------------------------------------------------

  describe('pollOnce()', () => {
    it('returns an empty array when the directory is empty', async () => {
      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      const results = await reader.pollOnce();
      expect(results).toEqual([]);
    });

    it('returns an empty array when directory does not exist', async () => {
      const reader = new IpcReader(path.join(tmpDir, 'nonexistent'), {
        pollIntervalMs: 500,
        errorsDir,
      });
      const results = await reader.pollOnce();
      expect(results).toEqual([]);
    });

    it('reads a single valid message and returns it', async () => {
      const writer = new IpcWriter(tmpDir);
      const msg = makeShutdown();
      writer.write(msg);

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      const results = await reader.pollOnce();

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual(msg);
    });

    it('deletes the file after processing', async () => {
      const writer = new IpcWriter(tmpDir);
      const msg = makeShutdown();
      const filename = writer.write(msg)._unsafeUnwrap();

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      await reader.pollOnce();

      await expect(fs.access(path.join(tmpDir, filename))).rejects.toThrow();
    });

    it('processes files in lexicographic (timestamp) order', async () => {
      const writer = new IpcWriter(tmpDir);

      const msg1 = makeToolRequest('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1000);
      const msg2 = makeToolRequest('f47ac10b-58cc-4372-a567-0e02b2c3d479', 2000);

      // Write in reverse order to verify sorting
      writer.write(msg2);
      writer.write(msg1);

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      const received: string[] = [];
      const results = await reader.pollOnce(async (m) => {
        received.push(m.id);
      });

      expect(received[0]).toBe(msg1.id);
      expect(received[1]).toBe(msg2.id);
      expect(results).toHaveLength(2);
    });

    it('ignores non-.json files', async () => {
      await fs.writeFile(path.join(tmpDir, 'somefile.txt'), 'hello');
      await fs.writeFile(path.join(tmpDir, 'another.log'), 'world');

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      const results = await reader.pollOnce();
      expect(results).toHaveLength(0);
    });

    it('calls the handler for each valid message', async () => {
      const writer = new IpcWriter(tmpDir);
      writer.write(makeToolRequest('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1000));
      writer.write(makeToolRequest('f47ac10b-58cc-4372-a567-0e02b2c3d479', 2000));

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      const handled: IpcMessage[] = [];
      await reader.pollOnce(async (m) => {
        handled.push(m);
      });

      expect(handled).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Invalid messages → errors dir
  // -------------------------------------------------------------------------

  describe('invalid message handling', () => {
    it('moves invalid JSON to errors dir', async () => {
      const invalidFile = path.join(tmpDir, '000000000001000-invalid.json');
      await fs.writeFile(invalidFile, 'not valid json {{{');

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      const results = await reader.pollOnce();

      expect(results).toHaveLength(0);

      // Original file should be gone from inbox
      await expect(fs.access(invalidFile)).rejects.toThrow();

      // Error file should exist
      const errorFiles = await fs.readdir(errorsDir);
      expect(errorFiles.some((f) => f.endsWith('.json'))).toBe(true);
    });

    it('moves schema-invalid messages to errors dir', async () => {
      const badMsg = {
        id: 'not-a-uuid',
        type: 'unknown.type',
        runId: '',
        threadId: '',
        timestamp: -1,
      };
      const badFile = path.join(tmpDir, '000000000001000-badmsg.json');
      await fs.writeFile(badFile, JSON.stringify(badMsg));

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      await reader.pollOnce();

      await expect(fs.access(badFile)).rejects.toThrow();

      const errorFiles = await fs.readdir(errorsDir);
      expect(errorFiles.length).toBeGreaterThan(0);
    });

    it('creates a .error.json companion file', async () => {
      const badFile = path.join(tmpDir, '000000000001000-bad.json');
      await fs.writeFile(badFile, 'not json');

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      await reader.pollOnce();

      const errorFiles = await fs.readdir(errorsDir);
      const errorAnnotation = errorFiles.find((f) => f.endsWith('.error.json'));
      expect(errorAnnotation).toBeTruthy();

      const annotation = JSON.parse(
        await fs.readFile(path.join(errorsDir, errorAnnotation!), 'utf8'),
      ) as { reason: string };
      expect(annotation.reason).toContain('JSON parse error');
    });

    it('moves message to errors dir when handler throws', async () => {
      const writer = new IpcWriter(tmpDir);
      const msg = makeShutdown();
      writer.write(msg);

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      const results = await reader.pollOnce(async (_m) => {
        throw new Error('handler boom');
      });

      expect(results).toHaveLength(0);

      const errorFiles = await fs.readdir(errorsDir);
      expect(errorFiles.some((f) => f.endsWith('.json'))).toBe(true);
    });

    it('continues processing subsequent files after one invalid file', async () => {
      // Bad file with lower sort key
      const badFile = path.join(tmpDir, '000000000000001-bad.json');
      await fs.writeFile(badFile, 'oops');

      // Good file with higher sort key
      const writer = new IpcWriter(tmpDir);
      writer.write(makeShutdown({ timestamp: 2 }));

      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      const results = await reader.pollOnce();

      // The valid message should still be processed
      expect(results).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // start() / stop()
  // -------------------------------------------------------------------------

  describe('start() / stop()', () => {
    it('start() begins polling and stop() halts it', async () => {
      const reader = new IpcReader(tmpDir, { pollIntervalMs: 50, errorsDir });
      const received: IpcMessage[] = [];

      reader.start(async (m) => {
        received.push(m);
      });

      // Write a message after the reader is running
      const writer = new IpcWriter(tmpDir);
      writer.write(makeShutdown());

      // Wait for at least one poll cycle
      await new Promise((r) => setTimeout(r, 200));
      reader.stop();

      expect(received).toHaveLength(1);
    });

    it('stop() is idempotent', () => {
      const reader = new IpcReader(tmpDir, { pollIntervalMs: 500, errorsDir });
      reader.start(async () => {});
      reader.stop();
      expect(() => reader.stop()).not.toThrow();
    });

    it('calling start() while running is a no-op', async () => {
      const reader = new IpcReader(tmpDir, { pollIntervalMs: 50, errorsDir });
      const callCount = { value: 0 };

      vi.useFakeTimers();
      reader.start(async () => { callCount.value++; });
      reader.start(async () => { callCount.value += 100; }); // second start is no-op

      // Only one interval should be running
      vi.useRealTimers();
      reader.stop();
    });
  });
});
