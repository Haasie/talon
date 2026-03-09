# Terminal Channel Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a WebSocket-based terminal channel so users can connect to any Talon persona from any machine via `talonctl chat`.

**Architecture:** A `TerminalConnector` implements `ChannelConnector` and runs a WebSocket server (`ws` library). Clients authenticate with a shared token, get a persistent thread per `clientId`, and can override which persona they talk to. The `talonctl chat` CLI command is a WebSocket client with readline input, `marked-terminal` for rendered markdown, and `ora` for typing spinners.

**Tech Stack:** `ws` (WebSocket server/client), `marked` + `marked-terminal` (client markdown rendering), `ora` (client spinner), `commander` (CLI registration)

**Design Doc:** `docs/plans/2026-03-09-terminal-channel-design.md`

---

## Task 1: Install dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install production deps**

```bash
npm install ws marked marked-terminal ora
```

**Step 2: Install dev deps**

```bash
npm install -D @types/ws
```

Note: `marked-terminal` and `ora` don't have separate `@types` packages — they ship their own types.

**Step 3: Verify**

```bash
node -e "require('ws'); console.log('ws ok')"
```

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add ws, marked, marked-terminal, ora dependencies"
```

---

## Task 2: Terminal types

**Files:**
- Create: `src/channels/connectors/terminal/terminal-types.ts`

**Step 1: Write the types file**

```typescript
/**
 * Types for the terminal channel connector.
 *
 * Defines the config shape and WebSocket wire protocol messages.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Channel config for the terminal connector (from talond.yaml). */
export interface TerminalConfig {
  /** WebSocket server port. */
  port: number;
  /** WebSocket server bind address (default: '127.0.0.1'). */
  host?: string;
  /** Shared secret token for client authentication. */
  token: string;
}

// ---------------------------------------------------------------------------
// Wire protocol — Client → Server
// ---------------------------------------------------------------------------

export interface AuthMessage {
  type: 'auth';
  token: string;
  clientId: string;
  /** Optional persona override — changes channel→persona binding on connect. */
  persona?: string;
}

export interface TextMessage {
  type: 'message';
  content: string;
}

export type ClientMessage = AuthMessage | TextMessage;

// ---------------------------------------------------------------------------
// Wire protocol — Server → Client
// ---------------------------------------------------------------------------

export interface AuthOkMessage {
  type: 'auth_ok';
}

export interface AuthErrorMessage {
  type: 'auth_error';
  reason: string;
}

export interface TypingMessage {
  type: 'typing';
}

export interface ResponseMessage {
  type: 'response';
  body: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | TypingMessage
  | ResponseMessage
  | ErrorMessage;
```

**Step 2: Commit**

```bash
git add src/channels/connectors/terminal/terminal-types.ts
git commit -m "feat(terminal): add wire protocol and config types"
```

---

## Task 3: Terminal connector — test and implement

This is the core task. TDD: write tests first, then implement.

**Files:**
- Create: `tests/unit/channels/connectors/terminal/terminal-connector.test.ts`
- Create: `src/channels/connectors/terminal/terminal-connector.ts`
- Create: `src/channels/connectors/terminal/index.ts`

**Step 1: Write the failing tests**

```typescript
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
    // Close all test clients.
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    }
    // Stop the connector (idempotent).
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

      // Wait for close
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

      // Wait for handler to be called.
      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (received.length > 0) {
            clearInterval(interval);
            resolve();
          }
        }, 10);
      });

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

      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (received.length >= 1) { clearInterval(interval); resolve(); }
        }, 10);
      });

      ws1.close();
      await new Promise<void>((resolve) => ws1.on('close', () => resolve()));

      // Second connection with same clientId.
      const ws2 = await connectClient(connector.port);
      clients.push(ws2);
      await authenticate(ws2, 'test-secret-token', 'my-laptop');
      sendJson(ws2, { type: 'message', content: 'msg2' });

      await new Promise<void>((resolve) => {
        const interval = setInterval(() => {
          if (received.length >= 2) { clearInterval(interval); resolve(); }
        }, 10);
      });

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
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/unit/channels/connectors/terminal/terminal-connector.test.ts
```

Expected: FAIL — module `terminal-connector.js` does not exist.

**Step 3: Implement TerminalConnector**

Create `src/channels/connectors/terminal/terminal-connector.ts`:

```typescript
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
        // Only remove from clients map if this ws is still the current one for this clientId.
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

  private handleMessage(ws: WebSocket, clientId: string, raw: string): void {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw) as ClientMessage;
    } catch {
      this.sendError(ws, 'invalid JSON');
      return;
    }

    if (msg.type !== 'message') {
      this.sendError(ws, `unexpected message type: ${msg.type}`);
      return;
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
```

Create `src/channels/connectors/terminal/index.ts`:

```typescript
export { TerminalConnector } from './terminal-connector.js';
export type { TerminalConfig } from './terminal-types.js';
export type * from './terminal-types.js';
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run tests/unit/channels/connectors/terminal/terminal-connector.test.ts
```

Expected: all PASS.

**Step 5: Commit**

```bash
git add src/channels/connectors/terminal/ tests/unit/channels/connectors/terminal/
git commit -m "feat(terminal): add TerminalConnector with WebSocket server and tests"
```

---

## Task 4: Wire connector into factory and CLI

**Files:**
- Modify: `src/daemon/channel-factory.ts:36-49` — add `case 'terminal'`
- Modify: `src/cli/commands/add-channel.ts:140-158` — add terminal placeholder
- Modify: `tests/unit/daemon/channel-factory.test.ts` — add terminal test
- Modify: `src/cli/index.ts` — register `chat` command (after Task 5)

**Step 1: Write failing factory test**

Add to `tests/unit/daemon/channel-factory.test.ts`:

```typescript
// Add mock at top with the other mocks:
vi.mock('../../../src/channels/connectors/terminal/terminal-connector.js', () => ({
  TerminalConnector: vi.fn().mockImplementation(() => ({ type: 'terminal' })),
}));

// Add import:
import { TerminalConnector } from '../../../src/channels/connectors/terminal/terminal-connector.js';

// Add test:
it('creates TerminalConnector for type "terminal"', () => {
  const connector = createConnector('terminal', name, config, logger);
  expect(connector).not.toBeNull();
  expect(TerminalConnector).toHaveBeenCalledWith(config, name, logger);
});
```

**Step 2: Run test to verify it fails**

```bash
npx vitest run tests/unit/daemon/channel-factory.test.ts
```

Expected: FAIL — no `case 'terminal'` in factory.

**Step 3: Add terminal case to channel-factory.ts**

Add import at top of `src/daemon/channel-factory.ts`:

```typescript
import { TerminalConnector } from '../channels/connectors/terminal/terminal-connector.js';
import type { TerminalConfig } from '../channels/connectors/terminal/terminal-types.js';
```

Add case before `default:`:

```typescript
    case 'terminal':
      return new TerminalConnector(config as unknown as TerminalConfig, name, logger);
```

**Step 4: Add terminal placeholder to add-channel.ts**

In `buildPlaceholderConfig()`, add before `default:`:

```typescript
    case 'terminal':
      return { port: 7700, host: '0.0.0.0', token: '${TERMINAL_TOKEN}' };
```

**Step 5: Run tests**

```bash
npx vitest run tests/unit/daemon/channel-factory.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add src/daemon/channel-factory.ts src/cli/commands/add-channel.ts tests/unit/daemon/channel-factory.test.ts
git commit -m "feat(terminal): wire connector into factory and add-channel CLI"
```

---

## Task 5: talonctl chat command

**Files:**
- Create: `src/cli/commands/chat.ts`
- Modify: `src/cli/index.ts` — register `chat` command

**Step 1: Implement the chat command**

Create `src/cli/commands/chat.ts`:

```typescript
/**
 * `talonctl chat` — WebSocket client for the terminal channel.
 *
 * Connects to a running Talon terminal connector, authenticates,
 * and provides a readline-based chat interface with markdown rendering.
 */

import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import WebSocket from 'ws';

interface ChatOptions {
  host: string;
  port: number;
  token: string;
  clientId?: string;
  persona?: string;
}

interface ServerMessage {
  type: string;
  body?: string;
  reason?: string;
  message?: string;
}

export async function chatCommand(options: ChatOptions): Promise<void> {
  const clientId = options.clientId ?? `${hostname()}-${randomUUID().slice(0, 8)}`;
  const url = `ws://${options.host}:${options.port}`;

  console.log(`Connecting to ${url} as "${clientId}"...`);

  const ws = new WebSocket(url);

  // Dynamic imports for ESM-only packages.
  const { Marked } = await import('marked');
  const { default: markedTerminal } = await import('marked-terminal');
  const { default: ora } = await import('ora');

  const marked = new Marked(markedTerminal() as Parameters<Marked['use']>[0]);
  const spinner = ora({ text: 'Thinking...', spinner: 'dots' });

  let authenticated = false;
  let rl: ReturnType<typeof createInterface> | undefined;

  function cleanup(): void {
    spinner.stop();
    rl?.close();
    if (ws.readyState === WebSocket.OPEN) {
      ws.close();
    }
  }

  ws.on('open', () => {
    // Send auth message.
    const authMsg = {
      type: 'auth',
      token: options.token,
      clientId,
      ...(options.persona ? { persona: options.persona } : {}),
    };
    ws.send(JSON.stringify(authMsg));
  });

  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as ServerMessage;

    switch (msg.type) {
      case 'auth_ok':
        authenticated = true;
        console.log(`Authenticated. Connected to Talon.`);
        if (options.persona) {
          console.log(`Persona: ${options.persona}`);
        }
        console.log('Type your message (Ctrl+C to exit):\n');
        startReadline();
        break;

      case 'auth_error':
        console.error(`Authentication failed: ${msg.reason}`);
        cleanup();
        process.exit(1);
        break;

      case 'typing':
        if (!spinner.isSpinning) {
          spinner.start();
        }
        break;

      case 'response':
        spinner.stop();
        if (msg.body) {
          const rendered = marked.parse(msg.body);
          process.stdout.write(String(rendered));
          process.stdout.write('\n');
        }
        break;

      case 'error':
        spinner.stop();
        console.error(`Error: ${msg.message}`);
        break;

      default:
        break;
    }
  });

  ws.on('close', () => {
    console.log('\nDisconnected.');
    cleanup();
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error(`Connection error: ${err.message}`);
    cleanup();
    process.exit(1);
  });

  function startReadline(): void {
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> ',
    });

    rl.prompt();

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        rl!.prompt();
        return;
      }
      if (!authenticated || ws.readyState !== WebSocket.OPEN) {
        console.error('Not connected.');
        rl!.prompt();
        return;
      }

      ws.send(JSON.stringify({ type: 'message', content: trimmed }));
      // Don't prompt — wait for response.
    });

    rl.on('close', () => {
      cleanup();
    });
  }

  // Handle Ctrl+C gracefully.
  process.on('SIGINT', () => {
    console.log('\nDisconnecting...');
    cleanup();
    process.exit(0);
  });
}
```

**Step 2: Register in CLI index**

In `src/cli/index.ts`, add import:

```typescript
import { chatCommand } from './commands/chat.js';
```

Add command registration before `program.parse()`:

```typescript
program
  .command('chat')
  .description('Connect to a Talon persona via terminal channel')
  .option('--host <host>', 'Terminal connector host', '127.0.0.1')
  .option('--port <port>', 'Terminal connector port', '7700')
  .option('--token <token>', 'Authentication token (or set TERMINAL_TOKEN env var)')
  .option('--client-id <id>', 'Client identity for persistent threads')
  .option('--persona <name>', 'Persona to connect to (overrides channel default)')
  .action(async (opts: { host: string; port: string; token?: string; clientId?: string; persona?: string }) => {
    const token = opts.token ?? process.env.TERMINAL_TOKEN;
    if (!token) {
      console.error('Error: --token is required (or set TERMINAL_TOKEN env var).');
      process.exit(1);
    }
    await chatCommand({
      host: opts.host,
      port: parseInt(opts.port, 10),
      token,
      clientId: opts.clientId,
      persona: opts.persona,
    });
  });
```

**Step 3: Verify build**

```bash
npx tsc --noEmit
```

**Step 4: Commit**

```bash
git add src/cli/commands/chat.ts src/cli/index.ts
git commit -m "feat(terminal): add talonctl chat CLI command"
```

---

## Task 6: Integration test — full round trip

**Files:**
- Create: `tests/unit/channels/connectors/terminal/terminal-integration.test.ts`

**Step 1: Write the integration test**

This test starts a `TerminalConnector`, connects a `ws` client, sends a message,
verifies the handler receives it, calls `send()` back, and verifies the client gets it.

```typescript
import { describe, it, expect, afterEach } from 'vitest';
import pino from 'pino';
import WebSocket from 'ws';
import { TerminalConnector } from '../../../../../src/channels/connectors/terminal/terminal-connector.js';
import type { InboundEvent } from '../../../../../src/channels/channel-types.js';

function silentLogger(): pino.Logger {
  return pino({ level: 'silent' });
}

describe('TerminalConnector integration', () => {
  let connector: TerminalConnector;
  const clients: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.close();
    }
    clients.length = 0;
    if (connector) await connector.stop();
  });

  it('full round trip: client → handler → send() → client', async () => {
    connector = new TerminalConnector(
      { port: 0, host: '127.0.0.1', token: 'secret' },
      'integration-test',
      silentLogger(),
    );

    // Set up handler that echoes back via send().
    connector.onMessage(async (event: InboundEvent) => {
      await connector.send(event.externalThreadId, {
        body: `Echo: ${event.content}`,
      });
    });

    await connector.start();

    // Connect and authenticate.
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${connector.port}`);
      client.on('open', () => resolve(client));
      client.on('error', reject);
    });
    clients.push(ws);

    // Auth.
    ws.send(JSON.stringify({ type: 'auth', token: 'secret', clientId: 'test-client' }));
    const authResp = await new Promise<string>((resolve) => {
      ws.once('message', (data) => resolve(data.toString()));
    });
    expect(JSON.parse(authResp).type).toBe('auth_ok');

    // Send message and wait for echo.
    ws.send(JSON.stringify({ type: 'message', content: 'ping' }));
    const echoResp = await new Promise<string>((resolve) => {
      ws.once('message', (data) => resolve(data.toString()));
    });

    const parsed = JSON.parse(echoResp);
    expect(parsed.type).toBe('response');
    expect(parsed.body).toBe('Echo: ping');
  });
});
```

**Step 2: Run test**

```bash
npx vitest run tests/unit/channels/connectors/terminal/
```

Expected: all PASS.

**Step 3: Commit**

```bash
git add tests/unit/channels/connectors/terminal/
git commit -m "test(terminal): add integration test for full round trip"
```

---

## Task 7: Build verification and final commit

**Step 1: Run full type check**

```bash
npx tsc --noEmit
```

**Step 2: Run all terminal tests**

```bash
npx vitest run tests/unit/channels/connectors/terminal/ tests/unit/daemon/channel-factory.test.ts
```

**Step 3: Run lint**

```bash
npx eslint src/channels/connectors/terminal/ src/cli/commands/chat.ts src/daemon/channel-factory.ts
```

**Step 4: Fix any issues found**

**Step 5: Final commit (if any fixes)**

```bash
git add -A
git commit -m "chore(terminal): lint and type fixes"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | Install deps | `package.json` |
| 2 | Wire protocol types | `terminal-types.ts` |
| 3 | Connector + tests (TDD) | `terminal-connector.ts`, `index.ts`, test |
| 4 | Factory + CLI wiring | `channel-factory.ts`, `add-channel.ts`, test |
| 5 | `talonctl chat` command | `chat.ts`, `index.ts` |
| 6 | Integration test | `terminal-integration.test.ts` |
| 7 | Build verification | — |
