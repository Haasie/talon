/**
 * Unit tests for HostToolsBridge.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createConnection } from 'node:net';
import { unlink, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HostToolsBridge } from '../../../src/tools/host-tools-bridge.js';
import type { DaemonContext } from '../../../src/daemon/daemon-context.js';
import type { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import type { ChannelRegistry } from '../../../src/channels/channel-registry.js';
import { ok, err } from 'neverthrow';

describe('HostToolsBridge', () => {
  let bridge: HostToolsBridge;
  let mockCtx: DaemonContext;
  let tempDir: string;
  let socketPath: string;

  beforeEach(async () => {
    tempDir = join('/tmp', `host-tools-bridge-test-${randomUUID()}`);
    await mkdir(tempDir, { recursive: true });
    socketPath = join(tempDir, 'test.sock');

    const mockScheduleRepo = {
      insert: vi.fn().mockReturnValue(ok({})),
      update: vi.fn().mockReturnValue(ok({})),
      disable: vi.fn().mockReturnValue(ok(undefined)),
      enable: vi.fn().mockReturnValue(ok(undefined)),
      findByPersona: vi.fn().mockReturnValue(ok([])),
      findDue: vi.fn().mockReturnValue(ok([])),
      updateNextRun: vi.fn().mockReturnValue(ok(null)),
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
        persona: {} as any,
        audit: {} as any,
        message: {} as any,
        run: {} as any,
        binding: {} as any,
      },
      channelRegistry: mockChannelRegistry,
      queueManager: {} as any,
      scheduler: {} as any,
      personaLoader: {} as any,
      sessionTracker: {} as any,
      threadWorkspace: {} as any,
      auditLogger: {} as any,
      skillResolver: {} as any,
      loadedSkills: [],
      logger: mockLogger as any,
    };
  });

  afterEach(async () => {
    if (bridge) {
      bridge.stop();
    }
    await unlink(socketPath).catch(() => {});
    await unlink(tempDir).catch(() => {});
  });

  describe('start/stop', () => {
    it('starts and creates socket file', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });

      expect(mockCtx.logger.info).toHaveBeenCalledWith(
        expect.objectContaining({ socketPath }),
        expect.any(String),
      );
    });

    it('stops and removes socket file', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });

      bridge.stop();

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });

      expect(mockCtx.logger.info).toHaveBeenCalledWith(
        expect.any(String),
        'host-tools-bridge: stopped',
      );
    });
  });

  describe('dispatch', () => {
    it('dispatches schedule.manage create call and returns success', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });

      const client = createConnection(socketPath, () => {
        const request = {
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
        };

        client.write(JSON.stringify(request) + '\n');
      });

      const response = await new Promise<any>((resolve) => {
        let data = '';
        client.on('data', (chunk) => {
          data += chunk.toString();
          const lines = data.split('\n').filter((l) => l.trim());
          if (lines.length > 0) {
            resolve(JSON.parse(lines[0]));
            client.end();
          }
        });
      });

      expect(response.result).toBeDefined();
      expect(response.result?.status).toBe('success');
    });

    it('returns error for unknown tool', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });

      const client = createConnection(socketPath, () => {
        const request = {
          id: randomUUID(),
          tool: 'unknown_tool',
          args: {},
          context: {
            runId: 'run-001',
            threadId: 'thread-001',
            personaId: 'persona-001',
            requestId: 'req-001',
          },
        };

        client.write(JSON.stringify(request) + '\n');
      });

      const response = await new Promise<any>((resolve) => {
        let data = '';
        client.on('data', (chunk) => {
          data += chunk.toString();
          const lines = data.split('\n').filter((l) => l.trim());
          if (lines.length > 0) {
            resolve(JSON.parse(lines[0]));
            client.end();
          }
        });
      });

      expect(response.result?.status).toBe('error');
      expect(response.result?.error).toContain('Unknown tool');
    });

    it('returns error for malformed JSON', async () => {
      bridge = new HostToolsBridge(mockCtx);
      bridge.start();

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });

      const client = createConnection(socketPath, () => {
        client.write('not valid json\n');
      });

      const response = await new Promise<any>((resolve) => {
        let data = '';
        client.on('data', (chunk) => {
          data += chunk.toString();
          const lines = data.split('\n').filter((l) => l.trim());
          if (lines.length > 0) {
            resolve(JSON.parse(lines[0]));
            client.end();
          }
        });
      });

      expect(response.error).toBe('Invalid JSON');
    });
  });
});
