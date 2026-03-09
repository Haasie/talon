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
  const markedTerminal = (await import('marked-terminal')).default;
  const { default: ora } = await import('ora');

  const marked = new Marked(markedTerminal());
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
    const authMsg = {
      type: 'auth',
      token: options.token,
      clientId,
      ...(options.persona ? { persona: options.persona } : {}),
    };
    ws.send(JSON.stringify(authMsg));
  });

  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(String(data)) as ServerMessage;

    switch (msg.type) {
      case 'auth_ok':
        authenticated = true;
        console.log('Authenticated. Connected to Talon.');
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
          const rendered = marked.parse(msg.body) as string;
          process.stdout.write(rendered);
          process.stdout.write('\n');
        }
        rl?.prompt();
        break;

      case 'error':
        spinner.stop();
        console.error(`Error: ${msg.message}`);
        rl?.prompt();
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

  ws.on('error', (wsErr) => {
    console.error(`Connection error: ${wsErr.message}`);
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
    });

    rl.on('close', () => {
      cleanup();
    });
  }

  process.on('SIGINT', () => {
    console.log('\nDisconnecting...');
    cleanup();
    process.exit(0);
  });
}
