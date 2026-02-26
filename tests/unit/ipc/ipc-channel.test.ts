import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { BidirectionalIpcChannel } from '../../../src/ipc/ipc-channel.js';
import { IpcMessageSchema } from '../../../src/ipc/ipc-types.js';
import type { IpcMessage } from '../../../src/ipc/ipc-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeShutdown(ts = 1700000000000): IpcMessage {
  return IpcMessageSchema.parse({
    id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    type: 'shutdown',
    runId: 'run-1',
    threadId: 'thread-1',
    timestamp: ts,
    payload: {},
  });
}

function makeToolRequest(id: string, ts: number): IpcMessage {
  return IpcMessageSchema.parse({
    id,
    type: 'tool.request',
    runId: 'run-1',
    threadId: 'thread-1',
    timestamp: ts,
    payload: { toolName: 'echo', args: { text: 'hello' } },
  });
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('BidirectionalIpcChannel', () => {
  let baseDir: string;
  let inputDir: string;
  let outputDir: string;
  let errorsDir: string;

  beforeEach(async () => {
    baseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-channel-test-'));
    inputDir = path.join(baseDir, 'in');
    outputDir = path.join(baseDir, 'out');
    errorsDir = path.join(baseDir, 'errors');
    await fs.mkdir(inputDir, { recursive: true });
    await fs.mkdir(outputDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(baseDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  describe('construction', () => {
    it('exposes writer and reader properties', () => {
      const ch = new BidirectionalIpcChannel(inputDir, outputDir, errorsDir, 500);
      expect(ch.writer).toBeDefined();
      expect(ch.reader).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // send()
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('writes a file to outputDir and returns Ok', async () => {
      const ch = new BidirectionalIpcChannel(inputDir, outputDir, errorsDir, 500);
      const msg = makeShutdown();

      const result = ch.send(msg);
      expect(result.isOk()).toBe(true);

      const files = await fs.readdir(outputDir);
      expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(1);
    });

    it('returned filename is the written filename', async () => {
      const ch = new BidirectionalIpcChannel(inputDir, outputDir, errorsDir, 500);
      const msg = makeShutdown();

      const filename = ch.send(msg)._unsafeUnwrap();
      const files = await fs.readdir(outputDir);
      expect(files).toContain(filename);
    });

    it('file content parses back to the original message', async () => {
      const ch = new BidirectionalIpcChannel(inputDir, outputDir, errorsDir, 500);
      const msg = makeShutdown();

      const filename = ch.send(msg)._unsafeUnwrap();
      const raw = await fs.readFile(path.join(outputDir, filename), 'utf8');
      const parsed = IpcMessageSchema.parse(JSON.parse(raw));
      expect(parsed).toEqual(msg);
    });
  });

  // -------------------------------------------------------------------------
  // start() / stop() + bidirectional round-trip
  // -------------------------------------------------------------------------

  describe('start() / stop()', () => {
    it('start() picks up messages in inputDir and stop() halts polling', async () => {
      const ch = new BidirectionalIpcChannel(inputDir, outputDir, errorsDir, 50);
      const received: IpcMessage[] = [];

      ch.start(async (m) => {
        received.push(m);
      });

      // Simulate the peer writing a message into inputDir
      const peer = new BidirectionalIpcChannel(outputDir, inputDir, errorsDir, 50);
      peer.send(makeShutdown());

      await new Promise((r) => setTimeout(r, 200));
      ch.stop();

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe('shutdown');
    });

    it('bidirectional: both sides can send and receive simultaneously', async () => {
      const sideA = new BidirectionalIpcChannel(inputDir, outputDir, errorsDir, 50);
      const sideB = new BidirectionalIpcChannel(outputDir, inputDir, errorsDir, 50);

      const aReceived: IpcMessage[] = [];
      const bReceived: IpcMessage[] = [];

      sideA.start(async (m) => { aReceived.push(m); });
      sideB.start(async (m) => { bReceived.push(m); });

      // A sends to B (writes to outputDir = B's inputDir)
      sideA.send(makeToolRequest('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1000));

      // B sends to A (writes to inputDir = A's inputDir... wait, that's wrong)
      // Correction: sideB sends to its own outputDir = inputDir (A reads from inputDir)
      sideB.send(makeToolRequest('f47ac10b-58cc-4372-a567-0e02b2c3d479', 2000));

      await new Promise((r) => setTimeout(r, 300));
      sideA.stop();
      sideB.stop();

      expect(bReceived).toHaveLength(1);
      expect(aReceived).toHaveLength(1);
    });

    it('stop() is safe to call when not started', () => {
      const ch = new BidirectionalIpcChannel(inputDir, outputDir, errorsDir, 500);
      expect(() => ch.stop()).not.toThrow();
    });
  });
});
