/**
 * Unit tests for TerminalConnector.
 *
 * Uses the ws library's WebSocket client to connect to the connector's
 * WebSocket server. No external services needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import WebSocket from 'ws';
import { TerminalConnector } from '../../../../../src/channels/connectors/terminal/terminal-connector.js';
import type { TerminalConfig } from '../../../../../src/channels/connectors/terminal/terminal-types.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';
import type { ServerMessage } from '../../../../../src/channels/connectors/terminal/terminal-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

function defaultConfig(overrides?: Partial<TerminalConfig>): TerminalConfig {
  return {
    port: 0, // OS assigns a free port
    host: '127.0.0.1',
    token: 'test-secret-token',
    ...overrides,
  };
}

/** Connect a WS client and return it once open. */
function connectClient(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

/** Send a JSON message over WebSocket. */
function sendJson(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}

/** Wait for the next JSON message from the server. */
function nextMessage(ws: WebSocket): Promise<ServerMessage> {
  return new Promise((resolve) => {
    ws.once('message', (data) => {
      resolve(JSON.parse(data.toString()) as ServerMessage);
    });
  });
}

/** Authenticate a client. Returns the auth response. */
async function authenticate(
  ws: WebSocket,
  token: string,
  clientId: string,
  persona?: string,
): Promise<ServerMessage> {
  const responsePromise = nextMessage(ws);
  sendJson(ws, { type: 'auth', token, clientId, ...(persona ? { persona } : {}) });
  return responsePromise;
}

/** Wait until a condition is true, polling every 10ms. */
function waitFor(fn: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (fn()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error('waitFor timed out'));
      }
    }, 10);
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TerminalConnector', () => {
  let connector: TerminalConnector;
  let clients: WebSocket[];

  beforeEach(() => {
    clients = [];
  });

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    if (connector) {
      await connector.stop();
    }
  });

  // -------------------------------------------------------------------------
  // Constructor / metadata
  // -------------------------------------------------------------------------

  describe('constructor', () => {
    it('exposes type = "terminal"', () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      expect(connector.type).toBe('terminal');
    });

    it('exposes the channel name', () => {
      connector = new TerminalConnector(defaultConfig(), 'my-term', silentLogger());
      expect(connector.name).toBe('my-term');
    });
  });

  // -------------------------------------------------------------------------
  // Start / stop lifecycle
  // -------------------------------------------------------------------------

  describe('start/stop lifecycle', () => {
    it('starts a WebSocket server and stops cleanly', async () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      await connector.start();
      expect(connector.port).toBeGreaterThan(0);
      await connector.stop();
    });

    it('start() is idempotent', async () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      await connector.start();
      const port1 = connector.port;
      await connector.start(); // no-op
      expect(connector.port).toBe(port1);
      await connector.stop();
    });

    it('stop() is idempotent when not running', async () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      await connector.stop(); // should not throw
    });
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  describe('authentication', () => {
    it('sends auth_ok for valid token', async () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      await connector.start();

      const ws = await connectClient(connector.port);
      clients.push(ws);

      const response = await authenticate(ws, 'test-secret-token', 'laptop-1');
      expect(response.type).toBe('auth_ok');
    });

    it('sends auth_error and closes for invalid token', async () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      await connector.start();

      const ws = await connectClient(connector.port);
      clients.push(ws);

      const response = await authenticate(ws, 'wrong-token', 'laptop-1');
      expect(response.type).toBe('auth_error');

      // Wait for close.
      await new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });
    });

    it('closes connection if first message is not auth', async () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      await connector.start();

      const ws = await connectClient(connector.port);
      clients.push(ws);

      const closePromise = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });
      sendJson(ws, { type: 'message', content: 'hello' });
      await closePromise;
    });
  });

  // -------------------------------------------------------------------------
  // Inbound messages
  // -------------------------------------------------------------------------

  describe('inbound messages', () => {
    it('calls handler with correctly normalised InboundEvent', async () => {
      const received: InboundEvent[] = [];
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      connector.onMessage(async (event) => received.push(event));
      await connector.start();

      const ws = await connectClient(connector.port);
      clients.push(ws);

      await authenticate(ws, 'test-secret-token', 'laptop-1');
      sendJson(ws, { type: 'message', content: 'Hello agent!' });

      await waitFor(() => received.length > 0);

      const event = received[0];
      expect(event.channelType).toBe('terminal');
      expect(event.channelName).toBe('test-terminal');
      expect(event.externalThreadId).toBe('laptop-1');
      expect(event.senderId).toBe('laptop-1');
      expect(event.content).toBe('Hello agent!');
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it('ignores messages from unauthenticated clients', async () => {
      const received: InboundEvent[] = [];
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      connector.onMessage(async (event) => received.push(event));
      await connector.start();

      const ws = await connectClient(connector.port);
      clients.push(ws);

      // Send message without authenticating first.
      const closePromise = new Promise<void>((resolve) => {
        ws.on('close', () => resolve());
      });
      sendJson(ws, { type: 'message', content: 'sneaky' });
      await closePromise;

      expect(received).toHaveLength(0);
    });

    it('uses clientId as externalThreadId for persistent threads', async () => {
      const received: InboundEvent[] = [];
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      connector.onMessage(async (event) => received.push(event));
      await connector.start();

      // First connection.
      const ws1 = await connectClient(connector.port);
      clients.push(ws1);
      await authenticate(ws1, 'test-secret-token', 'my-laptop');
      sendJson(ws1, { type: 'message', content: 'msg1' });

      await waitFor(() => received.length >= 1);

      ws1.close();
      await new Promise<void>((resolve) => ws1.on('close', () => resolve()));

      // Second connection with same clientId.
      const ws2 = await connectClient(connector.port);
      clients.push(ws2);
      await authenticate(ws2, 'test-secret-token', 'my-laptop');
      sendJson(ws2, { type: 'message', content: 'msg2' });

      await waitFor(() => received.length >= 2);

      // Both messages should have the same externalThreadId.
      expect(received[0].externalThreadId).toBe('my-laptop');
      expect(received[1].externalThreadId).toBe('my-laptop');
    });
  });

  // -------------------------------------------------------------------------
  // Outbound: send()
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('sends a response message to the connected client', async () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      await connector.start();

      const ws = await connectClient(connector.port);
      clients.push(ws);
      await authenticate(ws, 'test-secret-token', 'laptop-1');

      const responsePromise = nextMessage(ws);
      const result = await connector.send('laptop-1', { body: '## Hello\nWorld' });

      expect(result.isOk()).toBe(true);
      const msg = await responsePromise;
      expect(msg.type).toBe('response');
      expect((msg as { body: string }).body).toBe('## Hello\nWorld');
    });

    it('returns Err when client is not connected', async () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      await connector.start();

      const result = await connector.send('nonexistent-client', { body: 'hello' });
      expect(result.isErr()).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // sendTyping()
  // -------------------------------------------------------------------------

  describe('sendTyping()', () => {
    it('sends a typing indicator to the connected client', async () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      await connector.start();

      const ws = await connectClient(connector.port);
      clients.push(ws);
      await authenticate(ws, 'test-secret-token', 'laptop-1');

      const msgPromise = nextMessage(ws);
      await connector.sendTyping('laptop-1');

      const msg = await msgPromise;
      expect(msg.type).toBe('typing');
    });
  });

  // -------------------------------------------------------------------------
  // format()
  // -------------------------------------------------------------------------

  describe('format()', () => {
    it('passes through markdown unchanged', () => {
      connector = new TerminalConnector(defaultConfig(), 'test-terminal', silentLogger());
      expect(connector.format('**bold** text')).toBe('**bold** text');
    });
  });
});
