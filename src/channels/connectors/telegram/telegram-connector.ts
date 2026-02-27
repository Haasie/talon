/**
 * Telegram channel connector.
 *
 * Implements the ChannelConnector interface using the Telegram Bot API with
 * long polling. Translates between the canonical InboundEvent / AgentOutput
 * types and Telegram Bot API payloads.
 */

import type pino from 'pino';
import type { ChannelConnector, InboundEvent, AgentOutput } from '../../channel-types.js';
import type { Result } from '../../../core/types/result.js';
import { ok, err } from '../../../core/types/result.js';
import { ChannelError } from '../../../core/errors/error-types.js';
import type {
  TelegramConfig,
  TelegramUpdate,
  TelegramSendResult,
  TelegramUpdatesResult,
} from './telegram-types.js';
import { markdownToTelegram } from './telegram-format.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_POLLING_TIMEOUT_SEC = 30;
/** Initial backoff after a poll error, in milliseconds. */
const INITIAL_BACKOFF_MS = 1_000;
/** Maximum backoff after repeated poll errors, in milliseconds. */
const MAX_BACKOFF_MS = 60_000;

// ---------------------------------------------------------------------------
// TelegramConnector
// ---------------------------------------------------------------------------

/**
 * Channel connector for Telegram via Bot API long polling.
 *
 * Usage:
 * 1. Construct with a TelegramConfig and a channel name.
 * 2. Call `onMessage()` to register an inbound event handler.
 * 3. Call `start()` to begin polling.
 * 4. Call `stop()` to halt polling gracefully.
 */
export class TelegramConnector implements ChannelConnector {
  readonly type = 'telegram';
  readonly name: string;

  private handler?: (event: InboundEvent) => Promise<void>;
  private running = false;
  /** Offset for getUpdates: last seen update_id + 1. */
  private offset = 0;
  private abortController?: AbortController;
  /** Promise tracking the active poll loop (used for clean shutdown). */
  private pollLoopPromise?: Promise<void>;

  constructor(
    private readonly config: TelegramConfig,
    private readonly channelName: string,
    private readonly logger: pino.Logger,
  ) {
    this.name = channelName;
  }

  // ---------------------------------------------------------------------------
  // ChannelConnector lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start long polling. Idempotent — no-op if already running.
   */
  async start(): Promise<void> {
    if (this.running) {
      this.logger.debug({ channelName: this.name }, 'telegram connector already running');
      return;
    }
    this.running = true;
    this.logger.info({ channelName: this.name }, 'telegram connector starting');
    // Launch the poll loop in the background; store the promise for stop().
    this.pollLoopPromise = this.pollLoop();
  }

  /**
   * Stop polling gracefully. Idempotent — no-op if already stopped.
   * Waits for the current in-flight getUpdates request to be aborted before
   * returning.
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }
    this.running = false;
    this.logger.info({ channelName: this.name }, 'telegram connector stopping');
    // Abort any pending fetch so the poll loop unblocks immediately.
    this.abortController?.abort();
    // Wait for the loop to exit cleanly.
    await this.pollLoopPromise;
    this.pollLoopPromise = undefined;
    this.logger.info({ channelName: this.name }, 'telegram connector stopped');
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
   * Send an AgentOutput to a Telegram chat.
   *
   * @param externalThreadId - Telegram chat_id (as a string).
   * @param output            - Agent output to deliver.
   */
  async send(externalThreadId: string, output: AgentOutput): Promise<Result<void, ChannelError>> {
    const text = this.format(output.body);

    const url = this.apiUrl('sendMessage');
    const body = JSON.stringify({
      chat_id: externalThreadId,
      text,
      parse_mode: 'MarkdownV2',
    });

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
    } catch (fetchErr) {
      const cause = fetchErr instanceof Error ? fetchErr : undefined;
      return err(
        new ChannelError(
          `Telegram sendMessage network error: ${String(fetchErr)}`,
          cause,
        ),
      );
    }

    let data: TelegramSendResult;
    try {
      data = (await response.json()) as TelegramSendResult;
    } catch (parseErr) {
      return err(
        new ChannelError(
          `Telegram sendMessage: could not parse response (HTTP ${response.status})`,
        ),
      );
    }

    if (!data.ok) {
      const description = data.description ?? 'unknown error';
      const code = data.error_code ?? response.status;
      return err(
        new ChannelError(
          `Telegram sendMessage failed (${code}): ${description}`,
        ),
      );
    }

    return ok(undefined);
  }

  /**
   * Convert a Markdown string to Telegram MarkdownV2 format.
   */
  format(markdown: string): string {
    return markdownToTelegram(markdown);
  }

  // ---------------------------------------------------------------------------
  // Polling loop
  // ---------------------------------------------------------------------------

  /**
   * Long-poll loop. Runs until `running` is set to false.
   * Applies exponential backoff on errors with a maximum cap.
   */
  private async pollLoop(): Promise<void> {
    let backoffMs = INITIAL_BACKOFF_MS;

    while (this.running) {
      try {
        const updates = await this.getUpdates();
        // Reset backoff after a successful request.
        backoffMs = INITIAL_BACKOFF_MS;

        for (const update of updates) {
          // Always advance offset regardless of whether we handle the update,
          // to avoid re-processing updates that fail validation.
          this.offset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        if (!this.running) {
          // Aborted by stop() — exit the loop cleanly.
          break;
        }

        this.logger.warn(
          { channelName: this.name, err, backoffMs },
          'telegram poll error, backing off',
        );

        await this.sleep(backoffMs);
        // Exponential backoff capped at MAX_BACKOFF_MS.
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      }
    }
  }

  /**
   * Fetch the next batch of updates from the Telegram Bot API.
   * Uses AbortController so that stop() can cancel an in-flight request.
   */
  private async getUpdates(): Promise<TelegramUpdate[]> {
    const timeoutSec = this.config.pollingTimeoutSec ?? DEFAULT_POLLING_TIMEOUT_SEC;
    const url = this.apiUrl('getUpdates');
    const params = new URLSearchParams({
      offset: String(this.offset),
      timeout: String(timeoutSec),
    });

    this.abortController = new AbortController();

    const response = await fetch(`${url}?${params}`, {
      signal: this.abortController.signal,
    });

    const data = (await response.json()) as TelegramUpdatesResult;

    if (!data.ok) {
      throw new ChannelError(
        `Telegram getUpdates failed (${data.error_code ?? response.status}): ${data.description ?? 'unknown error'}`,
      );
    }

    return data.result ?? [];
  }

  // ---------------------------------------------------------------------------
  // Update handling
  // ---------------------------------------------------------------------------

  /**
   * Normalise a TelegramUpdate into an InboundEvent and invoke the handler.
   * Updates without a text message (e.g. photos, stickers) are dropped.
   */
  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;

    if (!message?.text) {
      this.logger.debug(
        { channelName: this.name, updateId: update.update_id },
        'telegram update has no text, skipping',
      );
      return;
    }

    const chatId = String(message.chat.id);

    // Enforce allowedChatIds restriction if configured.
    if (
      this.config.allowedChatIds &&
      this.config.allowedChatIds.length > 0 &&
      !this.config.allowedChatIds.includes(chatId)
    ) {
      this.logger.warn(
        { channelName: this.name, chatId },
        'telegram message from disallowed chat, dropping',
      );
      return;
    }

    const senderId = message.from ? String(message.from.id) : chatId;

    const event: InboundEvent = {
      channelType: this.type,
      channelName: this.name,
      externalThreadId: chatId,
      senderId,
      idempotencyKey: String(update.update_id),
      content: message.text,
      timestamp: message.date * 1000, // Telegram sends seconds; we want ms
      raw: update,
    };

    if (!this.handler) {
      this.logger.warn(
        { channelName: this.name },
        'telegram connector received message but no handler is registered',
      );
      return;
    }

    try {
      await this.handler(event);
    } catch (handlerErr) {
      this.logger.error(
        { channelName: this.name, err: handlerErr },
        'telegram connector handler threw an error',
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Internal utilities
  // ---------------------------------------------------------------------------

  /**
   * Build a Telegram Bot API URL for the given method.
   */
  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.config.botToken}/${method}`;
  }

  /**
   * Resolve after `ms` milliseconds. Respects abort during shutdown.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
