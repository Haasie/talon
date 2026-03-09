/**
 * Terminal channel connector.
 *
 * WebSocket server that accepts authenticated clients and maps each
 * clientId to a persistent thread (externalThreadId). Implements the
 * ChannelConnector interface so it plugs into the existing Talon pipeline.
 */

import { createServer, type Server } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import type pino from 'pino';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import type {
  TerminalConfig,
  ClientMessage,
  ServerMessage,
} from './terminal-types.js';

// ---------------------------------------------------------------------------
// TerminalConnector
// ---------------------------------------------------------------------------

export class TerminalConnector implements ChannelConnector {
  readonly type = 'terminal';
  readonly name: string;

  /** Actual port the server is listening on (useful when config.port = 0). */
  get port(): number {
    const addr = this.httpServer?.address();
    return addr && typeof addr === 'object' ? addr.port : 0;
  }

  private handler?: (event: InboundEvent) => void | Promise<void>;
  private running = false;
  private wss?: WebSocketServer;
  private httpServer?: Server;

  /** Map of clientId → currently connected WebSocket. */
  private clients = new Map<string, WebSocket>();
  /** Track which WebSocket connections have authenticated (ws → clientId). */
  private authenticated = new Map<WebSocket, string>();

  private idempotencyCounter = 0;

  constructor(
    private readonly config: TerminalConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
  ) {
    this.name = channelName;
  }

  // -------------------------------------------------------------------------
  // ChannelConnector lifecycle
  // -------------------------------------------------------------------------

  start(): Promise<void> {
    if (this.running) {
      return Promise.resolve();
    }
    this.running = true;

    return new Promise<void>((resolve) => {
      this.httpServer = createServer();
      this.wss = new WebSocketServer({ server: this.httpServer });

      this.wss.on('connection', (ws) => this.handleConnection(ws));

      const host = this.config.host ?? '127.0.0.1';
      this.httpServer.listen(this.config.port, host, () => {
        this.logger.info(
          { channelName: this.name, port: this.port, host },
          'terminal connector started',
        );
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    if (!this.running) {
      return Promise.resolve();
    }
    this.running = false;

    return new Promise<void>((resolve) => {
      // Close all client connections.
      for (const ws of this.clients.values()) {
        ws.close();
      }
      this.clients.clear();
      this.authenticated.clear();

      // Close the WebSocket server, then the HTTP server.
      if (this.wss) {
        this.wss.close(() => {
          if (this.httpServer) {
            this.httpServer.close(() => resolve());
          } else {
            resolve();
          }
        });
      } else {
        resolve();
      }
    });
  }

  onMessage(handler: (event: InboundEvent) => void | Promise<void>): void {
    this.handler = handler;
  }

  // -------------------------------------------------------------------------
  // Outbound
  // -------------------------------------------------------------------------

  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    const ws = this.clients.get(externalThreadId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return err(new ChannelError(`terminal client "${externalThreadId}" is not connected`));
    }

    const msg: ServerMessage = { type: 'response', body: this.format(output.body) };
    ws.send(JSON.stringify(msg));
    return ok(undefined);
  }

  async sendTyping(externalThreadId: string): Promise<void> {
    const ws = this.clients.get(externalThreadId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      const msg: ServerMessage = { type: 'typing' };
      ws.send(JSON.stringify(msg));
    }
  }

  format(markdown: string): string {
    // Terminal clients render markdown themselves — pass through raw.
    return markdown;
  }

  // -------------------------------------------------------------------------
  // Connection handling
  // -------------------------------------------------------------------------

  private handleConnection(ws: WebSocket): void {
    this.logger.debug({ channelName: this.name }, 'terminal: new connection');

    ws.once('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        this.sendError(ws, 'invalid JSON');
        ws.close();
        return;
      }

      if (msg.type !== 'auth') {
        this.sendError(ws, 'first message must be auth');
        ws.close();
        return;
      }

      if (!this.verifyToken(msg.token)) {
        const authError: ServerMessage = { type: 'auth_error', reason: 'invalid token' };
        ws.send(JSON.stringify(authError));
        ws.close();
        return;
      }

      // Auth succeeded — register the client.
      const clientId = msg.clientId;
      this.authenticated.set(ws, clientId);
      this.clients.set(clientId, ws);

      const authOk: ServerMessage = { type: 'auth_ok' };
      ws.send(JSON.stringify(authOk));

      this.logger.info(
        { channelName: this.name, clientId, persona: msg.persona },
        'terminal: client authenticated',
      );

      // Listen for subsequent messages.
      ws.on('message', (msgData) => {
        this.handleMessage(ws, clientId, msgData.toString());
      });

      ws.on('close', () => {
        this.authenticated.delete(ws);
        // Only remove from clients map if this ws is still the current one.
        if (this.clients.get(clientId) === ws) {
          this.clients.delete(clientId);
        }
        this.logger.debug({ channelName: this.name, clientId }, 'terminal: client disconnected');
      });
    });

    // If the client doesn't send anything within 10s, disconnect.
    const authTimeout = setTimeout(() => {
      if (!this.authenticated.has(ws)) {
        this.sendError(ws, 'auth timeout');
        ws.close();
      }
    }, 10_000);

    ws.on('close', () => clearTimeout(authTimeout));
  }

  private handleMessage(_ws: WebSocket, clientId: string, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      return; // Ignore malformed JSON.
    }

    if (msg.type !== 'message') {
      return; // Ignore non-message types after auth.
    }

    if (!msg.content || msg.content.trim() === '') {
      return; // Ignore empty messages.
    }

    const event: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId: clientId,
      senderId: clientId,
      idempotencyKey: `terminal:${clientId}:${++this.idempotencyCounter}`,
      content: msg.content,
      timestamp: Date.now(),
    };

    if (!this.handler) {
      this.logger.warn(
        { channelName: this.name },
        'terminal: received message but no handler is registered',
      );
      return;
    }

    Promise.resolve(this.handler(event)).catch((handlerErr: unknown) => {
      this.logger.error(
        { channelName: this.name, clientId, err: handlerErr },
        'terminal: handler threw an error',
      );
    });
  }

  // -------------------------------------------------------------------------
  // Utilities
  // -------------------------------------------------------------------------

  /** Constant-time token comparison to prevent timing attacks. */
  private verifyToken(provided: string): boolean {
    const expected = Buffer.from(this.config.token);
    const actual = Buffer.from(provided);
    if (expected.length !== actual.length) {
      return false;
    }
    return timingSafeEqual(expected, actual);
  }

  private sendError(ws: WebSocket, message: string): void {
    const msg: ServerMessage = { type: 'error', message };
    ws.send(JSON.stringify(msg));
  }
}
