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
import { isToolAllowed, MCP_TO_INTERNAL } from './tool-filter.js';
import type { ResolvedCapabilities } from '../personas/persona-types.js';

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

/** Tool name mapping from MCP (underscores) to handler (dots). Derived from HOST_TOOL_REGISTRY. */
const TOOL_NAME_MAP = Object.fromEntries(MCP_TO_INTERNAL);

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
      threadRepository: ctx.repos.thread,
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

    // Defense-in-depth: enforce persona capabilities at the bridge level.
    // Even if the MCP server somehow exposes a disallowed tool, the bridge
    // will reject it here. Uses fail-closed semantics — if the persona
    // cannot be resolved, no tools are allowed.
    const resolvedCaps = this.resolvePersonaCapabilities(context.personaId);
    if (!isToolAllowed(normalizedTool, resolvedCaps)) {
      const errorResponse: BridgeResponse = {
        id,
        result: {
          requestId: context.requestId ?? 'unknown',
          tool: normalizedTool,
          status: 'error',
          error: `Tool "${normalizedTool}" is not allowed for persona "${context.personaId}"`,
        },
      };
      this.sendResponse(socket, errorResponse);
      this.ctx.logger.warn(
        { personaId: context.personaId, tool: normalizedTool },
        'host-tools-bridge: rejected disallowed tool call',
      );
      return;
    }

    let responded = false;

    const timeoutHandle = setTimeout(() => {
      if (responded) return;
      responded = true;
      this.ctx.logger.warn({ id, tool: normalizedTool }, 'host-tools-bridge: request timed out');
      this.sendResponse(socket, { id, error: 'Request timeout' });
    }, REQUEST_TIMEOUT_MS);

    try {
      const result = await this.dispatch(normalizedTool, args, context);
      clearTimeout(timeoutHandle);
      if (responded) return; // Timeout already fired
      responded = true;
      this.sendResponse(socket, { id, result });
    } catch (err) {
      clearTimeout(timeoutHandle);
      if (responded) return; // Timeout already fired
      responded = true;
      this.sendResponse(socket, {
        id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private sendResponse(socket: net.Socket, response: BridgeResponse): void {
    socket.write(JSON.stringify(response) + '\n');
  }

  /**
   * Resolves persona capabilities by looking up the persona name from the
   * database and then fetching the loaded persona from the PersonaLoader cache.
   *
   * Returns a fail-closed empty capabilities object if the persona cannot be
   * found — this means NO tools will be allowed, which is the secure default.
   * The MCP server layer already filters tools at listing time, so this is a
   * defense-in-depth measure.
   */
  private resolvePersonaCapabilities(personaId: string): ResolvedCapabilities {
    try {
      const personaRowResult = this.ctx.repos.persona.findById(personaId);
      if (personaRowResult.isErr() || personaRowResult.value === null) {
        this.ctx.logger.warn(
          { personaId },
          'host-tools-bridge: persona not found in DB, failing closed (no tools allowed)',
        );
        return { allow: [], requireApproval: [] };
      }

      const personaName = personaRowResult.value.name;
      const loadedResult = this.ctx.personaLoader.getByName(personaName);
      if (loadedResult.isErr() || loadedResult.value === undefined) {
        this.ctx.logger.warn(
          { personaId, personaName },
          'host-tools-bridge: loaded persona not found, failing closed (no tools allowed)',
        );
        return { allow: [], requireApproval: [] };
      }

      return loadedResult.value.resolvedCapabilities;
    } catch (err) {
      this.ctx.logger.error(
        { personaId, err },
        'host-tools-bridge: error resolving persona capabilities, failing closed (no tools allowed)',
      );
      return { allow: [], requireApproval: [] };
    }
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
