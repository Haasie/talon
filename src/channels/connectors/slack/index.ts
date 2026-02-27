/**
 * Slack channel connector — public API.
 *
 * Implements the Channel interface for Slack via the Web API.
 * Handles event ingestion via feedEvent(), message normalisation,
 * and outbound sends with Markdown-to-mrkdwn conversion.
 */

export { SlackConnector, encodeThreadId, decodeThreadId } from './slack-connector.js';
export { markdownToSlackMrkdwn } from './slack-format.js';
export type {
  SlackConfig,
  SlackEvent,
  SlackMessage,
  SlackUser,
  SlackApiResponse,
  SlackPostMessageResult,
} from './slack-types.js';
