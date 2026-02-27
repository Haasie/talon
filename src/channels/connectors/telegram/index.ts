/**
 * Telegram channel connector — public API.
 *
 * Implements the Channel interface for Telegram via the Bot API.
 * Handles long polling, message normalisation, and send with
 * Markdown-to-MarkdownV2 conversion.
 */

export { TelegramConnector } from './telegram-connector.js';
export { telegramEscape, markdownToTelegram } from './telegram-format.js';
export type {
  TelegramConfig,
  TelegramUpdate,
  TelegramMessage,
  TelegramUser,
  TelegramChat,
  TelegramSendResult,
  TelegramUpdatesResult,
} from './telegram-types.js';
