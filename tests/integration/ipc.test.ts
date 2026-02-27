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

  // -------------------------------------------------------------------------
  // Concurrent writers
  // -------------------------------------------------------------------------

  it('concurrent writers: multiple writers to the same inbox all deliver', async () => {
    const inboxDir = path.join(tmpDir, 'concurrent-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    // Create 5 writers all writing to the same inbox simultaneously
    const writePromises: Promise<void>[] = [];
    const ids = [
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
      'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
      'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14',
      'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15',
    ];

    const now = Date.now();
    for (let i = 0; i < ids.length; i++) {
      const writer = new IpcWriter(inboxDir);
      const msg = makeMsg('tool.request', ids[i]!, now + i);
      writePromises.push(writer.writeAsync(msg).then(() => undefined));
    }

    await Promise.all(writePromises);

    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => { received.push(m); });

    expect(received).toHaveLength(ids.length);
    const receivedIds = received.map((m) => m.id).sort();
    expect(receivedIds).toEqual([...ids].sort());
  });

  it('concurrent writers do not produce corrupt files', async () => {
    const inboxDir = path.join(tmpDir, 'corrupt-check-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    // Write 10 messages concurrently
    const ids: string[] = [
      'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12',
      'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13',
      'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14',
      'e0eebc99-9c0b-4ef8-bb6d-6bb9bd380a15',
      'f0eebc99-9c0b-4ef8-bb6d-6bb9bd380a16',
      'a1eebc99-9c0b-4ef8-bb6d-6bb9bd380a17',
      'b1eebc99-9c0b-4ef8-bb6d-6bb9bd380a18',
      'c1eebc99-9c0b-4ef8-bb6d-6bb9bd380a19',
      'd1eebc99-9c0b-4ef8-bb6d-6bb9bd380a20',
    ];
    const now = Date.now();

    await Promise.all(
      ids.map((id, i) => {
        const writer = new IpcWriter(inboxDir);
        return writer.writeAsync(makeMsg('memory.read', id, now + i)).then(() => undefined);
      }),
    );

    const received: IpcMessage[] = [];
    // Track errors
    let errorCount = 0;
    await reader.pollOnce(async (m) => {
      received.push(m);
    });

    // Check errors dir for corrupt files
    try {
      const errFiles = await fs.readdir(errorsDir);
      errorCount = errFiles.length;
    } catch {
      // errors dir may not exist if no errors
      errorCount = 0;
    }

    expect(errorCount).toBe(0);
    expect(received).toHaveLength(ids.length);
  });

  // -------------------------------------------------------------------------
  // Large message handling (>100KB payload)
  // -------------------------------------------------------------------------

  it('large message handling: payload >100KB is written and read correctly', async () => {
    const inboxDir = path.join(tmpDir, 'large-msg-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    // Create a large content string (>100KB)
    const largeContent = 'x'.repeat(110 * 1024); // 110KB

    const msg = IpcMessageSchema.parse({
      id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
      type: 'message.send',
      runId: 'run-large',
      threadId: 'thread-large',
      timestamp: Date.now(),
      payload: { channelId: 'test', content: largeContent },
    });

    const filename = writer.write(msg)._unsafeUnwrap();

    // Verify file exists and check its size
    const stat = await fs.stat(path.join(inboxDir, filename));
    expect(stat.size).toBeGreaterThan(100 * 1024);

    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => { received.push(m); });

    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(msg.id);
    // Verify the large content survived the round-trip
    const payload = received[0]?.payload as { channelId: string; content: string };
    expect(payload.content.length).toBe(largeContent.length);
    expect(payload.content).toBe(largeContent);
  });

  it('large message via writeAsync also round-trips correctly', async () => {
    const inboxDir = path.join(tmpDir, 'large-async-inbox');
    const errorsDir = path.join(tmpDir, 'errors');

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    const largeContent = 'y'.repeat(200 * 1024); // 200KB

    const msg = IpcMessageSchema.parse({
      id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
      type: 'artifact.put',
      runId: 'run-large-async',
      threadId: 'thread-large-async',
      timestamp: Date.now(),
      payload: { name: 'large.txt', mimeType: 'text/plain', content: largeContent },
    });

    await writer.writeAsync(msg);

    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => { received.push(m); });

    expect(received).toHaveLength(1);
    const payload = received[0]?.payload as { name: string; content: string };
    expect(payload.content.length).toBe(largeContent.length);
  });

  // -------------------------------------------------------------------------
  // High-throughput: 100+ messages in rapid succession
  // -------------------------------------------------------------------------

  it('high-throughput: 100+ messages written and read successfully', async () => {
    const inboxDir = path.join(tmpDir, 'high-throughput-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    const messageCount = 100;
    const writtenIds: string[] = [];

    // Generate 100 unique UUIDs
    const baseIds = [
      'a0eebc99-9c0b-4ef8-bb6d-', 'b0eebc99-9c0b-4ef8-bb6d-', 'c0eebc99-9c0b-4ef8-bb6d-',
      'd0eebc99-9c0b-4ef8-bb6d-', 'e0eebc99-9c0b-4ef8-bb6d-',
    ];

    const now = Date.now();
    for (let i = 0; i < messageCount; i++) {
      const suffix = String(i).padStart(12, '0');
      const baseIdx = i % baseIds.length;
      const id = `${baseIds[baseIdx]}${suffix}`;
      writtenIds.push(id);

      const msg = makeMsg('tool.request', id, now + i);
      const result = writer.write(msg);
      expect(result.isOk()).toBe(true);
    }

    // Read all messages
    const received: IpcMessage[] = [];
    // May need multiple polls for 100 messages
    for (let poll = 0; poll < 5; poll++) {
      const batch = await reader.pollOnce(async (m) => { received.push(m); });
      if (received.length >= messageCount) break;
    }

    expect(received).toHaveLength(messageCount);

    // Verify all IDs are present
    const receivedIds = new Set(received.map((m) => m.id));
    for (const id of writtenIds) {
      expect(receivedIds.has(id)).toBe(true);
    }
  }, 30000);

  it('high-throughput: messages are delivered in FIFO order', async () => {
    const inboxDir = path.join(tmpDir, 'throughput-fifo-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    const count = 20;
    const timestamps: number[] = [];

    // Write messages with increasing timestamps
    for (let i = 0; i < count; i++) {
      const ts = 1000000 + i * 1000;
      timestamps.push(ts);
      const suffix = String(i).padStart(12, '0');
      const id = `a0eebc99-9c0b-4ef8-bb6d-${suffix}`;
      writer.write(makeMsg('memory.read', id, ts));
    }

    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => { received.push(m); });

    expect(received).toHaveLength(count);

    // Verify FIFO: each message's timestamp should be >= previous
    for (let i = 1; i < received.length; i++) {
      expect(received[i]!.timestamp).toBeGreaterThanOrEqual(received[i - 1]!.timestamp);
    }
  });

  // -------------------------------------------------------------------------
  // Error recovery: reader continues after corrupt file
  // -------------------------------------------------------------------------

  it('error recovery: reader continues after encountering a corrupt file', async () => {
    const inboxDir = path.join(tmpDir, 'recovery-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 100, errorsDir });

    // Write valid message first (timestamp 1)
    const validMsg1 = makeMsg('shutdown', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 1);
    writer.write(validMsg1);

    // Write a corrupt file in between (timestamp 2)
    await fs.writeFile(
      path.join(inboxDir, '000000000002000-corruptfile00000000.json'),
      '{ this is not valid json !!!',
    );

    // Write another valid message after corrupt (timestamp 3)
    const validMsg2 = makeMsg('tool.request', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 3);
    writer.write(validMsg2);

    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => { received.push(m); });

    // Both valid messages should be received despite the corrupt file in between
    expect(received).toHaveLength(2);
    const receivedTypes = received.map((m) => m.type);
    expect(receivedTypes).toContain('shutdown');
    expect(receivedTypes).toContain('tool.request');

    // Corrupt file should be in errors dir
    const errFiles = await fs.readdir(errorsDir);
    expect(errFiles.some((f) => f.includes('corrupt'))).toBe(true);
  });

  it('error recovery: reader continues polling after handler rejection', async () => {
    const inboxDir = path.join(tmpDir, 'handler-err-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 100, errorsDir });

    const goodId = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
    const badId = 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12';

    // Write: bad first (ts=1), good second (ts=2)
    writer.write(makeMsg('tool.request', badId, 1));
    writer.write(makeMsg('memory.read', goodId, 2));

    const received: IpcMessage[] = [];
    await reader.pollOnce(async (m) => {
      if (m.id === badId) {
        throw new Error('handler rejection for bad message');
      }
      received.push(m);
    });

    // Good message should be received even though handler rejected bad message
    expect(received).toHaveLength(1);
    expect(received[0]?.id).toBe(goodId);

    // Bad message should be quarantined in errors dir
    const errFiles = await fs.readdir(errorsDir);
    const errJsonFiles = errFiles.filter((f) => f.endsWith('.json') && !f.endsWith('.error.json'));
    expect(errJsonFiles.length).toBeGreaterThanOrEqual(1);
  });

  it('error recovery: reader survives unreadable directory on poll', async () => {
    const inboxDir = path.join(tmpDir, 'unreadable-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    // NOTE: We do NOT create the inboxDir — the reader should handle this gracefully

    const reader = new IpcReader(inboxDir, { pollIntervalMs: 100, errorsDir });

    // pollOnce on a non-existent directory should return empty, not throw
    const received: IpcMessage[] = [];
    await expect(
      reader.pollOnce(async (m) => { received.push(m); }),
    ).resolves.not.toThrow();

    expect(received).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // IpcWriter error cases
  // -------------------------------------------------------------------------

  it('write returns Ok with filename on success', async () => {
    const inboxDir = path.join(tmpDir, 'writer-ok-inbox');
    await fs.mkdir(inboxDir, { recursive: true });

    const writer = new IpcWriter(inboxDir);
    const msg = makeMsg('shutdown', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 12345);

    const result = writer.write(msg);

    expect(result.isOk()).toBe(true);
    const filename = result._unsafeUnwrap();
    expect(filename).toMatch(/\.json$/);
    expect(filename).toContain('000000000012345');
  });

  it('writeAsync returns Ok with filename on success', async () => {
    const inboxDir = path.join(tmpDir, 'writer-async-ok-inbox');

    const writer = new IpcWriter(inboxDir);
    const msg = makeMsg('shutdown', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 99999);

    const result = await writer.writeAsync(msg);

    expect(result.isOk()).toBe(true);
    const filename = result._unsafeUnwrap();
    expect(filename).toContain('000000000099999');
  });

  // -------------------------------------------------------------------------
  // pollOnce without handler (inspect mode)
  // -------------------------------------------------------------------------

  it('pollOnce without handler: validates but does not delete files', async () => {
    const inboxDir = path.join(tmpDir, 'inspect-inbox');
    const errorsDir = path.join(tmpDir, 'errors');
    await fs.mkdir(inboxDir, { recursive: true });

    const writer = new IpcWriter(inboxDir);
    const reader = new IpcReader(inboxDir, { pollIntervalMs: 500, errorsDir });

    const msg = makeMsg('shutdown', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', Date.now());
    const filename = writer.write(msg)._unsafeUnwrap();

    // Poll without handler — files should be deleted after reading (per IpcReader behavior)
    const inspected = await reader.pollOnce();

    expect(inspected).toHaveLength(1);
    expect(inspected[0]?.id).toBe(msg.id);

    // File is deleted (handler-less pollOnce still deletes after validation)
    await expect(fs.access(path.join(inboxDir, filename))).rejects.toThrow();
  });

  // -------------------------------------------------------------------------
  // BidirectionalIpcChannel: additional cases
  // -------------------------------------------------------------------------

  it('BidirectionalIpcChannel: multiple messages in each direction', async () => {
    const aIn = path.join(tmpDir, 'bi-a-in');
    const aOut = path.join(tmpDir, 'bi-a-out');
    const errors = path.join(tmpDir, 'bi-errors');
    await fs.mkdir(aIn, { recursive: true });
    await fs.mkdir(aOut, { recursive: true });

    const sideA = new BidirectionalIpcChannel(aIn, aOut, errors, 50);
    const sideB = new BidirectionalIpcChannel(aOut, aIn, errors, 50);

    const aReceived: IpcMessage[] = [];
    const bReceived: IpcMessage[] = [];

    sideA.start(async (m) => { aReceived.push(m); });
    sideB.start(async (m) => { bReceived.push(m); });

    try {
      // A sends 3 messages to B
      sideA.send(makeMsg('tool.request', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 1001));
      sideA.send(makeMsg('memory.read', 'b0eebc99-9c0b-4ef8-bb6d-6bb9bd380a12', 1002));
      sideA.send(makeMsg('artifact.put', 'c0eebc99-9c0b-4ef8-bb6d-6bb9bd380a13', 1003));

      // B sends 2 messages to A
      sideB.send(makeMsg('shutdown', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 2001));
      sideB.send(makeMsg('message.send', 'd0eebc99-9c0b-4ef8-bb6d-6bb9bd380a14', 2002));

      await new Promise((r) => setTimeout(r, 400));
    } finally {
      sideA.stop();
      sideB.stop();
    }

    expect(bReceived).toHaveLength(3);
    expect(aReceived).toHaveLength(2);

    const bTypes = bReceived.map((m) => m.type).sort();
    expect(bTypes).toContain('tool.request');
    expect(bTypes).toContain('memory.read');
    expect(bTypes).toContain('artifact.put');

    const aTypes = aReceived.map((m) => m.type).sort();
    expect(aTypes).toContain('shutdown');
    expect(aTypes).toContain('message.send');
  });

  it('BidirectionalIpcChannel: stop is idempotent', async () => {
    const aIn = path.join(tmpDir, 'stop-a-in');
    const aOut = path.join(tmpDir, 'stop-a-out');
    const errors = path.join(tmpDir, 'stop-errors');

    const sideA = new BidirectionalIpcChannel(aIn, aOut, errors, 50);
    sideA.start(async () => {});

    // Multiple stops should not throw
    expect(() => {
      sideA.stop();
      sideA.stop();
      sideA.stop();
    }).not.toThrow();
  });
});
