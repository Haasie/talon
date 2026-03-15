# Terminal Channel Design

> Date: 2026-03-09

## Overview

WebSocket-based channel connector that lets you connect to any Talon persona from any machine via `talonctl chat`. One persistent thread per client identity, token-authenticated, with rendered markdown output.

## Server Side: `TerminalConnector`

- New connector type `terminal` in `channel-factory.ts`
- Starts a WebSocket server on a configurable `host:port`
- **Auth**: Client sends `{ type: 'auth', token: '...', clientId: 'ivo-laptop' }` as first message. Server validates against configured token. Disconnects on failure.
- **Thread mapping**: `clientId` becomes the `externalThreadId`. Same client always gets the same thread — conversation persists across connections.
- **Inbound**: Authenticated text messages become `InboundEvent` and flow through the normal pipeline (dedup → route → queue → agent)
- **Outbound**: `send()` writes the agent response as JSON over the WebSocket to the connected client
- **sendTyping**: Sends a `{ type: 'typing' }` message so the client can show a spinner
- **Persona override**: Client sends `{ type: 'auth', ..., persona: 'researcher' }` — the connector creates/updates the channel→persona binding on connect
- **format()**: Pass through raw markdown (client renders it)

### Config

```yaml
channels:
  - name: terminal
    type: terminal
    enabled: true
    config:
      port: 7700
      host: 0.0.0.0
      token: ${TERMINAL_TOKEN}
```

## Client Side: `talonctl chat`

- New CLI command under `src/cli/commands/chat.ts`
- Connects via WebSocket
- Usage: `talonctl chat --host 10.0.1.95 --port 7700 --token <token> --persona assistant`
- Readline loop for input
- Renders agent responses with `marked-terminal` for pretty markdown
- Shows a spinner/indicator when receiving `typing` messages
- Graceful disconnect on Ctrl+C
- Token can also be set via `TERMINAL_TOKEN` env var to avoid passing on command line

## Wire Protocol (WebSocket JSON)

```
Client → Server:
  { type: 'auth', token: '...', clientId: 'ivo-laptop', persona?: 'researcher' }
  { type: 'message', content: 'do research on X' }

Server → Client:
  { type: 'auth_ok' }
  { type: 'auth_error', reason: 'invalid token' }
  { type: 'typing' }
  { type: 'response', body: '## Research Results\n...' }
  { type: 'error', message: '...' }
```

## Files to Create/Modify

### New files
- `src/channels/connectors/terminal/terminal-connector.ts` — WebSocket server, ChannelConnector impl
- `src/channels/connectors/terminal/terminal-types.ts` — TerminalConfig interface
- `src/cli/commands/chat.ts` — talonctl chat command (WebSocket client + readline + marked-terminal)
- `tests/unit/tools/host-tools/terminal-connector.test.ts` — unit tests

### Modified files
- `src/daemon/channel-factory.ts` — add `case 'terminal'` to createConnector
- `package.json` — add deps: `ws`, `marked`, `marked-terminal`, `ora`
- `README.md` — document the terminal channel and talonctl chat

## Dependencies

- `ws` — WebSocket server (lightweight, well-maintained)
- `marked` + `marked-terminal` — client-side markdown rendering
- `ora` — client-side spinner for typing indicator

## Architecture Notes

- The connector manages multiple simultaneous WebSocket connections (one per clientId)
- Each connection maps to one thread via clientId as externalThreadId
- If a client reconnects, they get the same thread — agent remembers everything
- Persona override on connect changes the channel→persona binding dynamically
- The server side is a standard ChannelConnector — plugs into the existing pipeline with zero changes to agent-runner, queue, or pipeline code
- No streaming for v1 — full response sent after agent completes (same as Telegram)

## Security

- Token auth required on every connection (constant-time comparison)
- Bind to 127.0.0.1 for local-only, 0.0.0.0 for remote access
- Token delivered via env var substitution in config, never hardcoded
- Consider adding rate limiting in a future iteration
