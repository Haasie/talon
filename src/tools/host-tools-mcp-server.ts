#!/usr/bin/env node

/**
 * Host Tools MCP Server
 *
 * A standalone Node.js script that implements the MCP protocol over stdio.
 * The Agent SDK spawns this as a child process. It connects to the talond
 * Unix domain socket and proxies tool calls from the agent to the daemon.
 *
 * Environment variables:
 *   TALOND_SOCKET   - Path to the Unix socket (required)
 *   TALOND_RUN_ID   - Current run ID (required)
 *   TALOND_THREAD_ID - Current thread ID (required)
 *   TALOND_PERSONA_ID - Current persona ID (required)
 */

import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

/** Tool name mapping from MCP (underscores) to handler (dots). */
const TOOL_NAME_MAP: Record<string, string> = {
  schedule_manage: 'schedule.manage',
  channel_send: 'channel.send',
  memory_access: 'memory.access',
  net_http: 'net.http',
  db_query: 'db.query',
};

/** NDJSON request to bridge. */
interface BridgeRequest {
  id: string;
  tool: string;
  args: Record<string, unknown>;
  context: {
    runId: string;
    threadId: string;
    personaId: string;
    requestId: string;
  };
}

/** NDJSON response from bridge. */
interface BridgeResponse {
  id: string;
  result?: {
    requestId: string;
    tool: string;
    status: 'success' | 'error' | 'timeout';
    result?: unknown;
    error?: string;
  };
  error?: string;
}

const REQUEST_TIMEOUT_MS = 30_000;

/** Socket client that maintains a persistent connection to the bridge. */
class SocketClient {
  private socket: ReturnType<typeof createConnection> | null = null;
  private readonly socketPath: string;
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: BridgeResponse) => void;
      reject: (reason: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private buffer = '';
  private connected = false;
  private connectResolve: ((value: void) => void) | null = null;
  private connectedPromise: Promise<void>;

  constructor(socketPath: string) {
    this.socketPath = socketPath;
    this.connectedPromise = new Promise((resolve) => {
      this.connectResolve = resolve;
    });
    this.connect();
  }

  private connect(): void {
    this.socket = createConnection(this.socketPath, () => {
      this.connected = true;
      if (this.connectResolve) {
        this.connectResolve();
        this.connectResolve = null;
      }
      console.error('[host-tools-mcp] Connected to bridge');
    });

    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.socket.on('close', () => {
      this.connected = false;
      console.error('[host-tools-mcp] Connection closed');
    });

    this.socket.on('error', (err) => {
      console.error('[host-tools-mcp] Socket error:', err.message);
      this.connected = false;
    });
  }

  private processBuffer(): void {
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (line.trim() === '') {
        continue;
      }

      try {
        const response: BridgeResponse = JSON.parse(line);
        const pending = this.pendingRequests.get(response.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(response.id);
          pending.resolve(response); // Resolve with full response
        }
      } catch {
        console.error('[host-tools-mcp] Failed to parse response:', line);
      }
    }
  }

  async sendRequest(
    tool: string,
    args: Record<string, unknown>,
    context: { runId: string; threadId: string; personaId: string },
  ): Promise<BridgeResponse['result']> {
    if (!this.connected) {
      await this.connectedPromise;
    }

    const id = randomUUID();
    const request: BridgeRequest = {
      id,
      tool,
      args,
      context: {
        runId: context.runId,
        threadId: context.threadId,
        personaId: context.personaId,
        requestId: randomUUID(),
      },
    };

    return new Promise<BridgeResponse['result']>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error('Request timeout'));
      }, REQUEST_TIMEOUT_MS);

      this.pendingRequests.set(id, {
        resolve: (response: BridgeResponse) => resolve(response.result),
        reject,
        timeout,
      });

      this.socket?.write(JSON.stringify(request) + '\n');
    });
  }

  close(): void {
    this.socket?.end();
  }
}

/** MCP tool definitions with JSON schemas. */
const TOOLS = [
  {
    name: 'schedule_manage',
    description: 'Creates, updates, or cancels scheduled tasks on behalf of a persona.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        action: {
          type: 'string' as const,
          enum: ['create', 'update', 'cancel'],
          description: 'Action to perform on the schedule entry',
        },
        scheduleId: {
          type: 'string' as const,
          description: 'Unique schedule identifier (required for update/cancel)',
        },
        cronExpr: {
          type: 'string' as const,
          description: 'Cron expression defining when the task fires (required for create/update)',
        },
        label: {
          type: 'string' as const,
          description: 'Human-readable label for the scheduled task',
        },
        prompt: {
          type: 'string' as const,
          description: 'Prompt or instruction to execute when the schedule fires',
        },
      },
      required: ['action'],
    },
  },
  {
    name: 'channel_send',
    description: 'Sends a message to a channel on behalf of a persona.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        channelId: {
          type: 'string' as const,
          description: 'Target channel identifier',
        },
        content: {
          type: 'string' as const,
          description: 'Message content in Markdown format',
        },
        replyTo: {
          type: 'string' as const,
          description: 'Optional thread or message ID to reply to',
        },
      },
      required: ['channelId', 'content'],
    },
  },
  {
    name: 'memory_access',
    description: 'Reads from or writes to the per-thread layered memory store.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        operation: {
          type: 'string' as const,
          enum: ['read', 'write', 'delete', 'list'],
          description: 'Operation to perform',
        },
        key: {
          type: 'string' as const,
          description: 'Memory key to read, write, or delete',
        },
        value: {
          description: 'Value to store (required for write)',
        },
        namespace: {
          type: 'string' as const,
          description: 'Optional namespace/layer to scope the operation',
        },
      },
      required: ['operation'],
    },
  },
  {
    name: 'net_http',
    description: 'Proxies outbound HTTP/HTTPS requests from the sandbox through the host.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        method: {
          type: 'string' as const,
          enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'],
          description: 'HTTP method',
        },
        url: {
          type: 'string' as const,
          description: 'Target URL',
        },
        headers: {
          type: 'object' as const,
          description: 'Optional request headers',
        },
        body: {
          type: 'string' as const,
          description: 'Optional request body (for POST/PUT/PATCH)',
        },
        timeoutMs: {
          type: 'number' as const,
          description: 'Request timeout in milliseconds',
        },
      },
      required: ['method', 'url'],
    },
  },
  {
    name: 'db_query',
    description: 'Executes read-only SQL SELECT queries against the talond SQLite database.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sql: {
          type: 'string' as const,
          description: 'SQL SELECT statement',
        },
        params: {
          type: 'array' as const,
          description: 'Positional or named parameters for the prepared statement',
        },
        limit: {
          type: 'number' as const,
          description: 'Maximum number of rows to return (default: 100, max: 1000)',
        },
      },
      required: ['sql'],
    },
  },
];

function getEnvRequired(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main(): Promise<void> {
  const socketPath = getEnvRequired('TALOND_SOCKET');
  const runId = getEnvRequired('TALOND_RUN_ID');
  const threadId = getEnvRequired('TALOND_THREAD_ID');
  const personaId = getEnvRequired('TALOND_PERSONA_ID');

  console.error('[host-tools-mcp] Starting with socket:', socketPath);
  console.error(
    '[host-tools-mcp] Context: runId=%s threadId=%s personaId=%s',
    runId,
    threadId,
    personaId,
  );

  const client = new SocketClient(socketPath);

  const server = new Server(
    {
      name: 'host-tools',
      version: '1.0.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: TOOLS,
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const handlerName = TOOL_NAME_MAP[name];
    if (!handlerName) {
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              error: `Unknown tool: ${name}`,
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      const result = await client.sendRequest(handlerName, args as Record<string, unknown>, {
        runId,
        threadId,
        personaId,
      });

      if (!result) {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: 'No response from bridge' }),
            },
          ],
          isError: true,
        };
      }

      if (result.status === 'error') {
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ error: result.error }),
            },
          ],
          isError: true,
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(result.result),
          },
        ],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error('[host-tools-mcp] MCP server ready');
}

main().catch((err) => {
  console.error('[host-tools-mcp] Fatal error:', err);
  process.exit(1);
});
