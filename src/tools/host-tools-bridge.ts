/**
 * HostToolsBridge — Unix domain socket server for dispatching tool calls.
 *
 * Runs inside the daemon process and receives tool call requests from the
 * host-tools MCP server over a Unix domain socket. Dispatches to the
 * appropriate handler classes and returns the result.
 */

import { unlinkSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import net from 'node:net';
import type { DaemonContext } from '../daemon/daemon-context.js';
import type { ToolCallResult } from './tool-types.js';
import type { ToolExecutionContext } from './host-tools/channel-send.js';
import { ScheduleManageHandler, type ScheduleManageArgs } from './host-tools/schedule-manage.js';
import { ChannelSendHandler, type ChannelSendArgs } from './host-tools/channel-send.js';
import { HttpProxyHandler, type HttpProxyArgs } from './host-tools/http-proxy.js';
import { DbQueryHandler, type DbQueryArgs } from './host-tools/db-query.js';
import { MemoryAccessHandler, type MemoryAccessArgs } from './host-tools/memory-access.js';

/** NDJSON request shape from MCP server. */
interface BridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  context: ToolExecutionContext;
}

/** NDJSON response shape to MCP server. */
interface BridgeResponse {
  id: string;
  result?: ToolCallResult;
  error?: string;
}

/** Tool name mapping from MCP (underscores) to handler (dots). */
const TOOL_NAME_MAP: Record<string, string> = {
  schedule_manage: 'schedule.manage',
  channel_send: 'channel.send',
  memory_access: 'memory.access',
  net_http: 'net.http',
  db_query: 'db.query',
};

const REQUEST_TIMEOUT_MS = 30_000;

export class HostToolsBridge {
  private server: net.Server | null = null;
  private readonly socketPath: string;
  private scheduleHandler: ScheduleManageHandler;
  private channelHandler: ChannelSendHandler;
  private httpHandler: HttpProxyHandler;
  private dbHandler: DbQueryHandler;
  private memoryHandler: MemoryAccessHandler;

  constructor(private readonly ctx: DaemonContext) {
    this.socketPath = resolve(join(ctx.dataDir, 'host-tools.sock'));

    this.scheduleHandler = new ScheduleManageHandler({
      scheduleRepository: ctx.repos.schedule,
      logger: ctx.logger,
    });

    this.channelHandler = new ChannelSendHandler({
      channelRegistry: ctx.channelRegistry,
      logger: ctx.logger,
    });

    this.httpHandler = new HttpProxyHandler({
      logger: ctx.logger,
      allowedDomains: [],
    });

    this.dbHandler = new DbQueryHandler({
      db: ctx.db,
      logger: ctx.logger,
    });

    this.memoryHandler = new MemoryAccessHandler({
      memoryRepository: ctx.repos.memory,
      logger: ctx.logger,
    });
  }

  get path(): string {
    return this.socketPath;
  }

  /** Starts listening on the Unix socket. Removes stale socket file if present. */
  start(): void {
    this.ctx.logger.info({ socketPath: this.socketPath }, 'host-tools-bridge: starting');

    // Remove stale socket file from previous run.
    if (existsSync(this.socketPath)) {
      unlinkSync(this.socketPath);
    }

    this.server = net.createServer((socket) => {
      this.handleConnection(socket);
    });

    this.server.listen(this.socketPath, () => {
      this.ctx.logger.info({ socketPath: this.socketPath }, 'host-tools-bridge: listening');
    });

    this.server.on('error', (err) => {
      this.ctx.logger.error({ err }, 'host-tools-bridge: server error');
    });
  }

  /** Stops the server and cleans up the socket file. */
  stop(): void {
    if (this.server) {
      this.server.close(() => {
        this.ctx.logger.info('host-tools-bridge: stopped');
      });
      this.server = null;
    }

    try {
      if (existsSync(this.socketPath)) {
        unlinkSync(this.socketPath);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  private handleConnection(socket: net.Socket): void {
    let buffer = '';

    socket.on('data', (chunk) => {
      buffer += chunk.toString();

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (line.trim() === '') {
          continue;
        }

        this.handleRequest(line, socket);
      }
    });

    socket.on('error', (err) => {
      this.ctx.logger.error({ err }, 'host-tools-bridge: socket error');
    });
  }

  private async handleRequest(line: string, socket: net.Socket): Promise<void> {
    let request: BridgeRequest;

    try {
      request = JSON.parse(line);
    } catch {
      const errorResponse: BridgeResponse = {
        id: 'unknown',
        error: 'Invalid JSON',
      };
      this.sendResponse(socket, errorResponse);
      return;
    }

    const { id, tool, args, context } = request;

    if (!id || !tool || !args || !context) {
      const errorResponse: BridgeResponse = {
        id: id || 'unknown',
        error: 'Missing required fields: id, tool, args, context',
      };
      this.sendResponse(socket, errorResponse);
      return;
    }

    const normalizedTool = TOOL_NAME_MAP[tool] || tool;

    const timeoutHandle = setTimeout(() => {
      const errorResponse: BridgeResponse = {
        id,
        error: 'Request timeout',
      };
      this.sendResponse(socket, errorResponse);
    }, REQUEST_TIMEOUT_MS);

    try {
      const result = await this.dispatch(normalizedTool, args, context);
      clearTimeout(timeoutHandle);
      const response: BridgeResponse = { id, result };
      this.sendResponse(socket, response);
    } catch (err) {
      clearTimeout(timeoutHandle);
      const errorResponse: BridgeResponse = {
        id,
        error: err instanceof Error ? err.message : String(err),
      };
      this.sendResponse(socket, errorResponse);
    }
  }

  private sendResponse(socket: net.Socket, response: BridgeResponse): void {
    socket.write(JSON.stringify(response) + '\n');
  }

  private async dispatch(
    tool: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    switch (tool) {
      case 'schedule.manage':
        return this.scheduleHandler.execute(args as unknown as ScheduleManageArgs, context);

      case 'channel.send':
        return this.channelHandler.execute(args as unknown as ChannelSendArgs, context);

      case 'memory.access':
        return this.memoryHandler.execute(args as unknown as MemoryAccessArgs, context);

      case 'net.http':
        return this.httpHandler.execute(args as unknown as HttpProxyArgs, context);

      case 'db.query':
        return this.dbHandler.execute(args as unknown as DbQueryArgs, context);

      default:
        return {
          requestId: context.requestId ?? 'unknown',
          tool,
          status: 'error',
          error: `Unknown tool: ${tool}`,
        };
    }
  }
}
