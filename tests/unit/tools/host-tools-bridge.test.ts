/**
 * Unit tests for HostToolsBridge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostToolsBridge } from '../../../src/tools/host-tools-bridge.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import type { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import type { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import { ok } from 'neverthrow';

/** Helper: send an NDJSON request to the bridge and wait for the response. */
function sendRequest(
  socketPath: string,
  request: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const client = createConnection(socketPath, () => {
      client.write(JSON.stringify(request) + '\n');
    });

    let data = '';
    client.on('data', (chunk) => {
      data += chunk.toString();
      const idx = data.indexOf('\n');
      if (idx !== -1) {
        const line = data.slice(0, idx);
        client.end();
        resolve(JSON.parse(line));
      }
    });

    client.on('error', reject);
    setTimeout(() => {
      client.end();
      reject(new Error('Timeout waiting for response'));
    }, 5000);
  });
}

/** Helper: wait for the bridge socket to be ready. */
function waitForSocket(socketPath: string, maxMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + maxMs;
    const check = () => {
      const client = createConnection(socketPath, () => {
        client.end();
        resolve();
      });
      client.on('error', () => {
        if (Date.now() > deadline) {
          reject(new Error('Socket not ready'));
        } else {
          setTimeout(check, 50);
        }
      });
    };
    check();
  });
}

describe('HostToolsBridge', () => {
  let bridge: HostToolsBridge;
  let mockCtx: DaemonContext;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `host-tools-bridge-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });

    const mockScheduleRepo = {
      insert: vi.fn().mockReturnValue(ok({})),
      update: vi.fn().mockReturnValue(ok({})),
      disable: vi.fn().mockReturnValue(ok(undefined)),
    } as unknown as ScheduleRepository;

    const mockChannelRegistry = {
      get: vi.fn().mockReturnValue(null),
    } as unknown as ChannelRegistry;

    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      child: vi.fn().mockReturnThis(),
    };

    mockCtx = {
      db: {} as any,
      config: {} as any,
      configPath: '',
      dataDir: tempDir,
      repos: {
        schedule: mockScheduleRepo,
        queue: {} as any,
        thread: {} as any,
        channel: {} as any,
        persona: {
          findById: vi.fn().mockReturnValue(ok({ id: 'test-persona', name: 'test' })),
        } as any,
        audit: {} as any,
        message: {} as any,
        run: {} as any,
        binding: {} as any,
        memory: {
          findById: vi.fn().mockReturnValue(ok(null)),
          findByThread: vi.fn().mockReturnValue(ok([])),
          insert: vi.fn().mockReturnValue(ok({})),
          update: vi.fn().mockReturnValue(ok(null)),
          delete: vi.fn().mockReturnValue(ok(undefined)),
        } as any,
      },
      channelRegistry: mockChannelRegistry,
      queueManager: {} as any,
      scheduler: {} as any,
      personaLoader: {
        getByName: vi.fn().mockReturnValue(ok({
          resolvedCapabilities: {
            allow: ['schedule.manage', 'channel.send:*', 'memory.access', 'net.http', 'db.query'],
            requireApproval: [],
          },
        })),
      } as any,
      sessionTracker: {} as any,
      threadWorkspace: {} as any,
      auditLogger: {} as any,
      skillResolver: {} as any,
      loadedSkills: [],
      messagePipeline: {} as any,
      hostToolsBridge: {} as any,
      logger: mockLogger as any,
    };
  });

  afterEach(async () => {
    if (bridge) {
      bridge.stop();
    }
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe('start/stop', () => {
    it('starts and creates socket, reports correct path', async () => {
      bridge = new HostToolsBridge(mockCtx);
      expect(bridge.path).toBe(join(tempDir, 'host-tools.sock'));

      bridge.start();
      await waitForSocket(bridge.path);

      expect(mockCtx.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath: bridge.path }),
        'host-tools-bridge: starting',
      );
    });

    it('stops cleanly', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      bridge.stop();
      // Give the close callback time to fire.
      await new Promise((r) => setTimeout(r, 100));

      expect(mockCtx.logger.info).toHaveBeenCalledWith('host-tools-bridge: stopped');
    });
  });

  describe('dispatch', () => {
    it('dispatches schedule.manage create and returns success', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'schedule_manage',
        args: {
          action: 'create',
          cronExpr: '0 9 * * *',
          label: 'Test schedule',
        },
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
        },
      });

      expect(response.result).toBeDefined();
      expect((response.result as any)?.status).toBe('success');
    });

    it('returns error for unknown tool', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'unknown_tool',
        args: {},
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
        },
      });

      expect((response.result as any)?.status).toBe('error');
      expect((response.result as any)?.error).toContain('not allowed');
    });

    it('returns error for malformed JSON', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const client = createConnection(bridge.path, () => {
          client.write('not valid json\n');
        });

        let data = '';
        client.on('data', (chunk) => {
          data += chunk.toString();
          const idx = data.indexOf('\n');
          if (idx !== -1) {
            client.end();
            resolve(JSON.parse(data.slice(0, idx)));
          }
        });

        client.on('error', reject);
        setTimeout(() => {
          client.end();
          reject(new Error('Timeout'));
        }, 5000);
      });

      expect(response.error).toBe('Invalid JSON');
    });

    it('dispatches memory.access to the memory handler', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();
      await waitForSocket(bridge.path);

      const response = await sendRequest(bridge.path, {
        id: randomUUID(),
        tool: 'memory_access',
        args: { operation: 'list' },
        context: {
          runId: 'run-001',
          threadId: 'thread-001',
          personaId: 'persona-001',
          requestId: 'req-001',
        },
      });

      expect((response.result as any)?.status).toBe('success');
      expect((response.result as any)?.result).toHaveProperty('items');
    });
  });
});
