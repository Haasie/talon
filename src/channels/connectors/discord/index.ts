/**
 * Discord channel connector — public API.
 *
 * Implements the ChannelConnector interface for Discord via REST API
 * (outbound) and external Gateway event feed (inbound).
 * Handles message normalisation and Markdown pass-through with minimal
 * transformations for Discord-incompatible constructs.
 */

export { DiscordConnector, encodeThreadId, decodeThreadId } from './discord-connector.js';
export { markdownToDiscord } from './discord-format.js';
export type {
  DiscordConfig,
  DiscordUser,
  DiscordGuildMember,
  DiscordMessage,
  DiscordMessageReference,
  DiscordSendMessageBody,
  DiscordSendMessageResult,
  DiscordApiError,
  DiscordRateLimitInfo,
  DiscordGatewayEvent,
  DiscordMessageCreateEvent,
} from './discord-types.js';
export { DiscordIntents, DEFAULT_INTENTS } from './discord-types.js';
