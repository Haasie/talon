/**
 * Integration test for TerminalConnector — full round trip.
 *
 * Starts a connector, connects a ws client, sends a message,
 * verifies the handler receives it, echoes back via send(),
 * and verifies the client gets the response.
 */

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

    // Handler echoes back via send().
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

  it('typing indicator arrives before response', async () => {
    connector = new TerminalConnector(
      { port: 0, host: '127.0.0.1', token: 'secret' },
      'typing-test',
      silentLogger(),
    );

    connector.onMessage(async (event: InboundEvent) => {
      await connector.sendTyping(event.externalThreadId);
      await connector.send(event.externalThreadId, { body: 'done' });
    });

    await connector.start();

    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const client = new WebSocket(`ws://127.0.0.1:${connector.port}`);
      client.on('open', () => resolve(client));
      client.on('error', reject);
    });
    clients.push(ws);

    ws.send(JSON.stringify({ type: 'auth', token: 'secret', clientId: 'typing-client' }));
    await new Promise<void>((resolve) => { ws.once('message', () => resolve()); });

    // Send message.
    ws.send(JSON.stringify({ type: 'message', content: 'work' }));

    // Collect two messages: typing + response.
    const messages: unknown[] = [];
    await new Promise<void>((resolve) => {
      ws.on('message', (data) => {
        messages.push(JSON.parse(data.toString()));
        if (messages.length === 2) resolve();
      });
    });

    expect((messages[0] as { type: string }).type).toBe('typing');
    expect((messages[1] as { type: string }).type).toBe('response');
    expect((messages[1] as { body: string }).body).toBe('done');
  });
});
