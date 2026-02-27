/**
 * Slack channel connector.
 *
 * Implements the ChannelConnector interface for Slack via the Web API.
 * This connector is designed to work with Slack's Events API or Socket Mode,
 * where inbound events are pushed to the connector via `feedEvent()`.
 *
 * Outbound messages are sent via the `chat.postMessage` Web API endpoint
 * using the bot token for Bearer authentication.
 */

import type pino from 'pino';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import type {
  SlackConfig,
  SlackEvent,
  SlackPostMessageResult,
} from './slack-types.js';
import { markdownToSlackMrkdwn } from './slack-format.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Slack Web API base URL. */
const SLACK_API_BASE = 'https://slack.com/api';

// ---------------------------------------------------------------------------
// SlackConnector
// ---------------------------------------------------------------------------

/**
 * Channel connector for Slack via the Web API.
 *
 * Unlike the Telegram connector (which uses long polling), the Slack connector
 * is event-driven: inbound events are delivered externally (via Events API
 * webhooks or Socket Mode) and fed into the connector via `feedEvent()`.
 *
 * Usage:
 * 1. Construct with a SlackConfig and a channel name.
 * 2. Call `onMessage()` to register an inbound event handler.
 * 3. Call `start()` to mark the connector as active.
 * 4. Call `feedEvent()` with raw Slack event payloads to process inbound events.
 * 5. Call `stop()` to mark the connector as inactive.
 */
export class SlackConnector implements ChannelConnector {
  readonly type = 'slack';
  readonly name: string;

  private handler?: (event: InboundEvent) => Promise<void>;
  private running = false;

  constructor(
    private readonly config: SlackConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
  ) {
    this.name = channelName;
  }

  // ---------------------------------------------------------------------------
  // ChannelConnector lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Mark the connector as started. Idempotent — no-op if already running.
   *
   * The actual webhook registration or Socket Mode connection is managed
   * externally (e.g. by the Slack Bolt SDK or a webhook handler). This method
   * records the started state so that the connector can guard against processing
   * events while stopped.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.debug({ channelName: this.name }, 'slack connector already running');
      return;
    }
    this.running = true;
    this.logger.info({ channelName: this.name }, 'slack connector started');
  }

  /**
   * Mark the connector as stopped. Idempotent — no-op if already stopped.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.logger.info({ channelName: this.name }, 'slack connector stopped');
  }

  /**
   * Register the inbound message handler.
   * A second call replaces the previous handler.
   */
  onMessage(handler: (event: InboundEvent) => Promise<void>): void {
    this.handler = handler;
  }

  // ---------------------------------------------------------------------------
  // Outbound
  // ---------------------------------------------------------------------------

  /**
   * Send an AgentOutput to a Slack channel or thread.
   *
   * The `externalThreadId` encodes both the channel and the optional thread_ts
   * in the format `<channelId>:<thread_ts>`. If no colon is present, the entire
   * string is treated as a channel ID with no thread reply.
   *
   * @param externalThreadId - Encoded as `<channelId>` or `<channelId>:<thread_ts>`.
   * @param output            - Agent output to deliver.
   */
  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    const text = this.format(output.body);

    // Decode the compound thread ID.
    const { channelId, threadTs } = decodeThreadId(externalThreadId);

    const payload: Record<string, unknown> = {
      channel: channelId,
      text,
    };

    if (threadTs) {
      payload.thread_ts = threadTs;
    }

    let response: Response;
    try {
      response = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.config.botToken}`,
        },
        body: JSON.stringify(payload),
      });
    } catch (fetchErr) {
      const cause = fetchErr instanceof Error ? fetchErr : undefined;
      return err(
        new ChannelError(
          `Slack chat.postMessage network error: ${String(fetchErr)}`,
          cause,
        ),
      );
    }

    let data: SlackPostMessageResult;
    try {
      data = (await response.json()) as SlackPostMessageResult;
    } catch (_parseErr) {
      return err(
        new ChannelError(
          `Slack chat.postMessage: could not parse response (HTTP ${response.status})`,
        ),
      );
    }

    if (!data.ok) {
      const errorCode = data.error ?? 'unknown_error';
      return err(
        new ChannelError(
          `Slack chat.postMessage failed: ${errorCode}`,
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * Convert a Markdown string to Slack mrkdwn format.
   */
  format(markdown: string): string {
    return markdownToSlackMrkdwn(markdown);
  }

  // ---------------------------------------------------------------------------
  // Inbound event ingestion
  // ---------------------------------------------------------------------------

  /**
   * Feed a raw Slack event payload into the connector.
   *
   * This method is the entry point for inbound events from the Slack Events API
   * or Socket Mode. It normalizes the Slack event into an `InboundEvent` and
   * invokes the registered handler.
   *
   * Thread mapping:
   * - `externalThreadId` = `<channel>:<thread_ts>` when `thread_ts` is present
   * - `externalThreadId` = `<channel>` when there is no thread context
   *
   * Idempotency key:
   * - Prefers `event_id` from the envelope (globally unique per delivery)
   * - Falls back to `client_msg_id` from the message
   * - Falls back to `<channel>:<ts>` as a last resort
   *
   * Bot messages (those with a `bot_id` field) are silently dropped to prevent
   * the connector from reacting to its own outbound messages.
   *
   * @param event - Raw Slack event envelope payload.
   */
  async feedEvent(event: SlackEvent): Promise<void> {
    const message = event.event;

    if (!message) {
      this.logger.debug(
        { channelName: this.name },
        'slack event has no inner event object, skipping',
      );
      return;
    }

    // Only process message events.
    if (message.subtype && message.subtype !== 'bot_message') {
      this.logger.debug(
        { channelName: this.name, subtype: message.subtype },
        'slack message has non-standard subtype, skipping',
      );
      return;
    }

    // Drop bot messages (including from this bot itself).
    if (message.bot_id) {
      this.logger.debug(
        { channelName: this.name, botId: message.bot_id },
        'slack message from bot, skipping',
      );
      return;
    }

    if (!message.text) {
      this.logger.debug(
        { channelName: this.name },
        'slack message has no text, skipping',
      );
      return;
    }

    const channelId = message.channel;
    const threadTs = message.thread_ts;

    // Build a compound external thread ID that encodes both channel and thread.
    const externalThreadId = threadTs
      ? encodeThreadId(channelId, threadTs)
      : channelId;

    // Determine sender ID.
    const senderId = message.user ?? channelId;

    // Determine idempotency key.
    const idempotencyKey =
      event.event_id ??
      message.client_msg_id ??
      `${channelId}:${message.ts}`;

    // Determine timestamp (Slack ts is a decimal string of Unix seconds).
    const timestamp = parseSlackTimestamp(message.ts);

    const inboundEvent: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId,
      senderId,
      idempotencyKey,
      content: message.text,
      timestamp,
      raw: event,
    };

    if (!this.handler) {
      this.logger.warn(
        { channelName: this.name },
        'slack connector received message but no handler is registered',
      );
      return;
    }

    try {
      await this.handler(inboundEvent);
    } catch (handlerErr) {
      this.logger.error(
        { channelName: this.name, err: handlerErr },
        'slack connector handler threw an error',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Encode a channel ID and optional thread timestamp into a compound thread ID.
 *
 * The format is `<channelId>:<thread_ts>`. If `thread_ts` is not provided the
 * result is just the `channelId`.
 */
export function encodeThreadId(channelId: string, threadTs?: string): string {
  if (!threadTs) return channelId;
  return `${channelId}:${threadTs}`;
}

/**
 * Decode a compound thread ID back into channel ID and optional thread_ts.
 *
 * Slack thread_ts values look like "1234567890.123456" (contains a dot).
 * Channel IDs look like "C01234567" (no colon). The first colon is the separator.
 */
export function decodeThreadId(externalThreadId: string): {
  channelId: string;
  threadTs: string | undefined;
} {
  const colonIndex = externalThreadId.indexOf(':');
  if (colonIndex === -1) {
    return { channelId: externalThreadId, threadTs: undefined };
  }
  return {
    channelId: externalThreadId.slice(0, colonIndex),
    threadTs: externalThreadId.slice(colonIndex + 1),
  };
}

/**
 * Parse a Slack message timestamp string into Unix epoch milliseconds.
 *
 * Slack ts values are decimal strings of Unix seconds, e.g. "1700000000.123456".
 */
function parseSlackTimestamp(ts: string): number {
  const seconds = parseFloat(ts);
  return Math.round(seconds * 1000);
}
