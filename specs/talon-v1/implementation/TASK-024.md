# Task TASK-024: Discord Channel Connector

## Changes Made

### New source files
- `src/channels/connectors/discord/discord-types.ts` — DiscordConfig interface, Discord API types (DiscordUser, DiscordMessage, DiscordGatewayEvent, etc.), DiscordIntents constants
- `src/channels/connectors/discord/discord-format.ts` — markdownToDiscord() conversion; images converted to alt+URL, tables simplified, everything else passes through
- `src/channels/connectors/discord/discord-connector.ts` — DiscordConnector implementing ChannelConnector; push-based event model via feedEvent(); REST API send with rate-limit retry; encodeThreadId/decodeThreadId utilities

### Updated files
- `src/channels/connectors/discord/index.ts` — Updated stub barrel to export DiscordConnector, markdownToDiscord, all types, and DiscordIntents

## Tests Added

- `tests/unit/channels/connectors/discord/discord-connector.test.ts` — 54 tests covering:
  - Constructor metadata (type, name)
  - Start/stop lifecycle (idempotent start/stop, restart cycle)
  - feedEvent() — normalised InboundEvent, op filtering, non-MESSAGE_CREATE filtering
  - Bot message filtering (bot=true drops, bot=false passes, no bot field passes)
  - Empty content filtering
  - Handler registration (replacement behavior)
  - guildId restriction (allowed, blocked, DMs with no guild_id)
  - allowedChannelIds restriction (allowed, blocked, empty array = all allowed)
  - send() — success path, URL format, Authorization header, JSON body, message_reference encoding, format delegation
  - send() error handling — API errors, network errors, CHANNEL_ERROR code
  - Rate limiting — Retry-After header, X-RateLimit-Reset-After fallback, exceeding max retries, default 1s fallback
  - format() — bold pass-through, image conversion, code block pass-through
  - encodeThreadId / decodeThreadId — round-trip, channelId-only, channelId:messageId

- `tests/unit/channels/connectors/discord/discord-format.test.ts` — 43 tests covering:
  - Plain text pass-through
  - Bold, italic, strikethrough, inline code, fenced code blocks pass-through
  - Headings (#, ##, ###) pass-through
  - Links, block quotes, spoilers, lists pass-through
  - Image conversion (alt+URL, empty alt, whitespace alt, multiple images)
  - Images inside code blocks are NOT converted (protected)
  - Table simplification (separator rows stripped, data rows pipe-joined)
  - Tables inside code blocks are NOT converted
  - Mixed content scenarios

Total: 97 tests, all passing.

## Deviations from Plan

- The connector does not manage a WebSocket itself; it uses the feedEvent() push model as specified, identical to the Slack pattern described in the task.
- Rate limit sleep in tests uses vi.useFakeTimers() for the "default 1s fallback" test to avoid actual delays.

## Status

completed

## Notes

- Discord uses near-standard Markdown so markdownToDiscord() is intentionally minimal — only images and tables require transformation. All other constructs (bold, italic, strikethrough, inline code, code blocks, headings, links, block quotes, spoilers, lists) pass through unchanged.
- Thread ID encoding: externalThreadId is `channelId` for new messages, or `channelId:messageId` when a reply reference is needed for outbound sends.
- Rate limiting: up to 3 retries, respects Retry-After and X-RateLimit-Reset-After headers, falls back to 1 second.
- Bot messages are filtered before reaching the handler (including self-messages where bot=true).
