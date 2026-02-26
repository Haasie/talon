/**
 * Host-side tool: channel.send
 *
 * Sends a message to a channel on behalf of a persona. The tool is gated by
 * the `channel.send:<channel-id>` capability and requires either explicit
 * allow or operator approval depending on the persona policy.
 *
 * @remarks Full implementation in TASK-029.
 */

import type { ToolManifest } from '../tool-types.js';

/** Manifest for the channel.send host tool. */
export interface ChannelSendTool {
  readonly manifest: ToolManifest;
}

/** Arguments accepted by the channel.send tool. */
export interface ChannelSendArgs {
  /** Target channel identifier. */
  channelId: string;
  /** Message content in Markdown format. */
  content: string;
  /** Optional thread or message ID to reply to. */
  replyTo?: string;
}
