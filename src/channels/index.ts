/**
 * Channel subsystem.
 *
 * Defines the Channel interface and manages the lifecycle of channel
 * connectors. Inbound messages are normalised to the internal Message type;
 * outbound Markdown is converted to the channel's native format before send.
 */

export type {
  Attachment,
  Action,
  AgentOutput,
  InboundEvent,
  ChannelConnector,
} from './channel-types.js';

export { ChannelRegistry } from './channel-registry.js';
export { ChannelRouter } from './channel-router.js';

export { stripMarkdown, escapeForChannel } from './format/index.js';
