# Task TASK-022: Slack Channel Connector

## Changes Made

### New Files

- `src/channels/connectors/slack/slack-types.ts`
  - Defines `SlackConfig` with `botToken`, `appToken?`, `signingSecret`, and `defaultChannel?`
  - Defines `SlackUser`, `SlackMessage`, `SlackEvent` (event envelope), `SlackApiResponse`, `SlackPostMessageResult`
  - All types focus on fields actually used by the connector; additional Slack API fields omitted

- `src/channels/connectors/slack/slack-format.ts`
  - Exports `markdownToSlackMrkdwn(markdown: string): string`
  - Segment-by-segment processing (same architecture as `markdownToTelegram`)
  - Handles: fenced code blocks (strips language hint), inline code (passthrough), bold (**text** / __text__ → *text*), italic (*text* / _text_ → _text_), strikethrough (~~text~~ → ~text~), links ([label](url) → <url|label>), headings (# text → *text*)
  - Lists and plain text are preserved as-is (Slack does not require escaping plain text)

- `src/channels/connectors/slack/slack-connector.ts`
  - Exports `SlackConnector` implementing `ChannelConnector` interface
  - `type = 'slack'`
  - `start()` / `stop()`: simple state transitions (no polling loop — Slack events are push-based)
  - `onMessage(handler)`: registers an inbound handler
  - `send(externalThreadId, output)`: POSTs to `https://slack.com/api/chat.postMessage` with Bearer auth; decodes compound thread ID (`channelId:thread_ts`) for threaded replies; returns `Result<void, ChannelError>`
  - `format(markdown)`: delegates to `markdownToSlackMrkdwn`
  - `feedEvent(event)`: normalizes raw Slack event payload to `InboundEvent`; drops bot messages (bot_id present); handles idempotency key preference (event_id > client_msg_id > channel:ts); encodes externalThreadId as `channelId:thread_ts` for threads
  - Also exports `encodeThreadId` and `decodeThreadId` helpers

- `src/channels/connectors/slack/index.ts`
  - Replaced empty placeholder with barrel exports for all public types and functions

### Test Files

- `tests/unit/channels/connectors/slack/slack-format.test.ts`
  - 37 tests covering all mrkdwn conversions: plain text, bold, italic, strikethrough, inline code, fenced code blocks, links, headings, lists, mixed content

- `tests/unit/channels/connectors/slack/slack-connector.test.ts`
  - 37 tests covering: constructor metadata, start/stop lifecycle (idempotency), feedEvent normalization, thread ID encoding, bot message filtering, handler error recovery, send() with mocked fetch, thread_ts injection, error cases

## Tests Added

- 74 new tests in 2 new test files
- Full test suite: 1775 tests across 82 files, all passing

## Deviations from Plan

None. The implementation follows the exact pattern of the Telegram connector as specified.

One design choice worth noting: the Slack connector does not have a polling loop because Slack uses a push model (Events API or Socket Mode). The `feedEvent()` method is the injection point for inbound events rather than an internal poll loop. This matches the task description's guidance that "real Socket Mode or Events API webhook integration is external."

## Status

completed

## Notes

- The compound thread ID format (`channelId:thread_ts`) is used consistently between `feedEvent()` and `send()`. Callers can use `encodeThreadId`/`decodeThreadId` helpers if needed.
- Bot message filtering relies on the `bot_id` field being present in the Slack message event, which is the standard Slack API indicator for bot-originated messages.
- The Slack timestamp (`ts`) is a decimal string of Unix seconds; the connector converts to milliseconds by multiplying by 1000 and rounding.
