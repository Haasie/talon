/**
 * Integration tests for the IPC subsystem.
 *
 * These tests exercise the full write → poll → validate → process → delete
 * round-trip against a real temporary filesystem. No mocking.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

import { IpcWriter } from '../../src/ipc/ipc-writer.js';
import { IpcReader } from '../../src/ipc/ipc-reader.js';
import { BidirectionalIpcChannel } from '../../src/ipc/ipc-channel.js';
import { IpcMessageSchema } from '../../src/ipc/ipc-types.js';
import type { IpcMessage } from '../../src/ipc/ipc-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMsg(type: IpcMessage['type'], id: string, ts: number): IpcMessage {
  const base = {
    id,
    type,
    runId: 'run-integration',
    threadId: 'thread-integration',
    timestamp: ts,
  };

  switch (type) {
    case 'shutdown':
      return IpcMessageSchema.parse({ ...base, payload: {} });
    case 'tool.request':
      return IpcMessageSchema.parse({ ...base, payload: { toolName: 'test', args: {} } });
    case 'message.send':
      return IpcMessageSchema.parse({ ...base, payload: { channelId: 'test', content: 'hi' } });
    case 'tool.result':
      return IpcMessageSchema.parse({
        ...base,
        payload: { requestId: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', success: true },
      });
    case 'memory.read':
      return IpcMessageSchema.parse({ ...base, payload: { key: 'test/key' } });
    case 'memory.write':
      return IpcMessageSchema.parse({ ...base, payload: { key: 'test/key', value: 42 } });
    case 'artifact.put':
      return IpcMessageSchema.parse({
        ...base,
        payload: { name: 'out.txt', mimeType: 'text/plain', content: 'aGVsbG8=' },
      });
    case 'message.new':
      return IpcMessageSchema.parse({ ...base, payload: { channelId: 'slack', content: 'hi' } });
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IPC integration', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ipc-integration-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Single round-trip
  // -------------------------------------------------------------------------

  it('write + pollOnce: file is created, processed, and deleted', async () => {
    const inboxDir = path.join(tmpDir, 'inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    const msg = makeMsg('shutdown', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', Date.now());
    const filename = writer.write(msg)._unsafeUnwrap();

    // File exists before poll
    await expect(fs.access(path.join(inboxDir, filename))).resolves.toBeUndefined();

    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => {
      received.push(m);
    });

    // Message was delivered
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);

    // File was deleted after processing
    await expect(fs.access(path.join(inboxDir, filename))).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // All message types
  // -------------------------------------------------------------------------

  it.each([
    ['shutdown', 'f47ac10b-58cc-4372-a567-0e02b2c3d479'],
    ['tool.request', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'],
    ['message.send', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12'],
    ['tool.result', 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13'],
    ['memory.read', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14'],
    ['memory.write', 'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15'],
    ['artifact.put', 'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a16'],
    ['message.new', 'a1eebc99-9c0b-4ef8-bb6d-6bb9bd380a17'],
  ] as [IpcMessage['type'], string][])(
    'round-trips message type "%s"',
    async (type, id) => {
      const inboxDir = path.join(tmpDir, `inbox-${type.replace('.', '-')}`);
      const errorsDir = path.join(tmpDir, 'errors');
      await fs.mkdir(inboxDir, { recursive: true });

      const writer = new IpcWriter(inboxDir);
      const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

      const msg = makeMsg(type, id, Date.now());
      writer.write(msg);

      const received: IpcMessage[] = [];
      await reader.pollOnce(async (m) => { received.push(m); });

      expect(received).toHaveLength(1);
      expect(received[0]?.type).toBe(type);
      expect(received[0]?.id).toBe(id);
    },
  );

  // -------------------------------------------------------------------------
  // FIFO ordering with multiple messages
  // -------------------------------------------------------------------------

  it('processes multiple messages in timestamp order (FIFO)', async () => {
    const inboxDir = path.join(tmpDir, 'fifo-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    const messages = [
      makeMsg('tool.request', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1000),
      makeMsg('tool.request', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 2000),
      makeMsg('tool.request', 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13', 3000),
    ];

    // Write in reverse order to verify FIFO is by timestamp, not write order
    for (const m of [...messages].reverse()) {
      writer.write(m);
    }

    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => { received.push(m); });

    expect(received).toHaveLength(3);
    expect(received.map((m) => m.id)).toEqual(messages.map((m) => m.id));
  });

  // -------------------------------------------------------------------------
  // Invalid message quarantine
  // -------------------------------------------------------------------------

  it('quarantines invalid JSON to errors dir and does not crash', async () => {
    const inboxDir = path.join(tmpDir, 'err-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    // Write garbage files
    await fs.writeFile(path.join(inboxDir, '000000000000001-garbage.json'), '{bad json');
    await fs.writeFile(path.join(inboxDir, '000000000000002-schema-fail.json'), JSON.stringify({
      id: 'not-uuid',
      type: 'unknown',
    }));

    // Write one valid message after the bad ones
    const writer = new IpcWriter(inboxDir);
    writer.write(makeMsg('shutdown', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 3));

    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });
    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => { received.push(m); });

    // Only the valid message is received
    expect(received).toHaveLength(1);
    expect(received[0]?.type).toBe('shutdown');

    // Inbox is now empty
    const inboxFiles = (await fs.readdir(inboxDir)).filter((f) => f.endsWith('.json'));
    expect(inboxFiles).toHaveLength(0);

    // Errors dir has the quarantined files
    const errFiles = await fs.readdir(errorsDir);
    expect(errFiles.filter((f) => f.endsWith('.json')).length).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------------------------
  // BidirectionalIpcChannel end-to-end
  // -------------------------------------------------------------------------

  it('BidirectionalIpcChannel: full round-trip via polling', async () => {
    const aIn = path.join(tmpDir, 'a-in');
    const aOut = path.join(tmpDir, 'a-out');
    const errors = path.join(tmpDir, 'errors');
    await fs.mkdir(aIn, { recursive: true });
    await fs.mkdir(aOut, { recursive: true });

    // sideA: reads from aIn, writes to aOut
    // sideB: reads from aOut, writes to aIn  (mirror)
    const sideA = new BidirectionalIpcChannel(aIn, aOut, errors, 50);
    const sideB = new BidirectionalIpcChannel(aOut, aIn, errors, 50);

    const aReceived: IpcMessage[] = [];
    const bReceived: IpcMessage[] = [];

    sideA.start(async (m) => { aReceived.push(m); });
    sideB.start(async (m) => { bReceived.push(m); });

    try {
      // A sends to B
      sideA.send(makeMsg('shutdown', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 1000));
      // B sends to A
      sideB.send(makeMsg('tool.request', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 2000));

      // Wait for polling
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      sideA.stop();
      sideB.stop();
    }

    expect(bReceived).toHaveLength(1);
    expect(bReceived[0]?.type).toBe('shutdown');

    expect(aReceived).toHaveLength(1);
    expect(aReceived[0]?.type).toBe('tool.request');
  });

  // -------------------------------------------------------------------------
  // Async writer
  // -------------------------------------------------------------------------

  it('writeAsync + pollOnce round-trip', async () => {
    const inboxDir = path.join(tmpDir, 'async-inbox');
    const errorsDir = path.join(tmpDir, 'errors');

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    const msg = makeMsg('memory.write', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', Date.now());
    await writer.writeAsync(msg);

    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => { received.push(m); });

    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(msg);
  });
});
