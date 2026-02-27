# Task TASK-021: WhatsApp Channel Connector

## Changes Made

### Source files

- `src/channels/connectors/whatsapp/whatsapp-types.ts` — WhatsApp Cloud API type definitions:
  - `WhatsAppConfig` — connector configuration (phoneNumberId, accessToken, verifyToken, apiVersion, webhookPort)
  - `WhatsAppMessage` / `WhatsAppMediaMessage` — inbound message shapes
  - `WhatsAppWebhookPayload` / `WhatsAppWebhookEntry` / `WhatsAppWebhookChange` / `WhatsAppWebhookValue` — full webhook envelope types
  - `WhatsAppContact`, `WhatsAppTextBody`, `WhatsAppMediaBody` — nested payload types
  - `WhatsAppSendResult` — outbound API response type with error envelope

- `src/channels/connectors/whatsapp/whatsapp-format.ts` — Markdown-to-WhatsApp format converter:
  - `markdownToWhatsApp(markdown: string): string` — segment-by-segment conversion
  - Bold `**text**` → `*text*`
  - Italic `*text*` / `_text_` → `_text_`
  - Strikethrough `~~text~~` → `~text~`
  - Inline code `` `code` `` → ` ```code``` `
  - Fenced code blocks — preserved verbatim (WhatsApp supports triple backtick)
  - Links `[label](url)` → `label (url)` (WhatsApp auto-links bare URLs)
  - Headings `# text` → `*text*` (bold fallback)
  - Plain text — passed through unchanged

- `src/channels/connectors/whatsapp/whatsapp-connector.ts` — `WhatsAppConnector` class:
  - Implements `ChannelConnector` interface
  - `type = 'whatsapp'`
  - `start()` / `stop()` — lightweight lifecycle (mark running flag; no embedded HTTP server)
  - `onMessage(handler)` — register inbound event handler (replaces previous)
  - `send(externalThreadId, output)` — POST to `https://graph.facebook.com/{apiVersion}/{phoneNumberId}/messages` with Bearer auth; returns `Result<void, ChannelError>`
  - `format(markdown)` — delegates to `markdownToWhatsApp()`
  - `feedWebhook(payload)` — public ingestion point for raw webhook payloads; normalises each text message into `InboundEvent` and calls the registered handler; logs and skips non-text types (image, document, audio)

- `src/channels/connectors/whatsapp/index.ts` — barrel exports replacing the empty placeholder

### Test files

- `tests/unit/channels/connectors/whatsapp/whatsapp-format.test.ts` — 34 tests covering all conversion rules, edge cases, and mixed-content documents
- `tests/unit/channels/connectors/whatsapp/whatsapp-connector.test.ts` — 31 tests covering:
  - Constructor metadata (type, name)
  - Start/stop lifecycle idempotency
  - `feedWebhook()` — text messages, multiple messages per payload, media skipping, wrong object type, wrong field, no handler, handler errors, raw field presence
  - `send()` — success, correct URL construction, API version override, default version, Bearer auth header, JSON body structure, Markdown conversion, API error, network error, JSON parse error, non-ok HTTP with no error field
  - `format()` — delegates correctly

## Tests Added

- `tests/unit/channels/connectors/whatsapp/whatsapp-format.test.ts` — 34 tests
- `tests/unit/channels/connectors/whatsapp/whatsapp-connector.test.ts` — 31 tests
- Total: 65 new tests; all 1766 tests in the suite pass

## Deviations from Plan

- None. The implementation follows the task spec exactly.
- The `feedWebhook()` design matches the described intent: no embedded HTTP server; connector relies on an external proxy (nginx or daemon HTTP endpoint) to forward webhook payloads.
- `feedWebhook()` accepts the typed `WhatsAppWebhookPayload` directly rather than `unknown` for stronger type safety at the call site.

## Status

completed

## Notes

- The WhatsApp thread ID is the sender's `wa_id` (phone number). This is appropriate for direct (1:1) conversations via the Cloud API. Group conversation support would require a different model and is deferred to a future task.
- The `webhookPort` config field is preserved for forward compatibility but marked as deprecated — it is never used by this connector.
- Idempotency key is the WhatsApp `message.id` (`wamid.*` prefix), which is stable and unique per message per business account.
