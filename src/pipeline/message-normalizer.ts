/**
 * MessageNormalizer — converts raw InboundEvents to canonical NormalizedMessages.
 *
 * This is a pure, stateless transformation. No I/O is performed; the caller
 * is responsible for supplying the resolved internal channelId and threadId.
 */

import { v4 as uuidv4 } from 'uuid';
import type { InboundEvent } from '../channels/channel-types.js';
import type { NormalizedMessage } from './pipeline-types.js';

/**
 * Converts an InboundEvent into the pipeline's canonical NormalizedMessage.
 *
 * The normalizer is intentionally a plain class (not a singleton) so it is
 * easy to construct and test in isolation.
 */
export class MessageNormalizer {
  /**
   * Normalizes a raw InboundEvent into a NormalizedMessage.
   *
   * @param event     - The inbound event emitted by a channel connector.
   * @param channelId - The internal channel UUID resolved from event.channelName.
   * @param threadId  - The internal thread UUID resolved or created for this event.
   * @returns A fully populated NormalizedMessage ready for persistence.
   */
  normalize(event: InboundEvent, channelId: string, threadId: string): NormalizedMessage {
    return {
      id: uuidv4(),
      threadId,
      channelId,
      senderId: event.senderId,
      content: event.content,
      idempotencyKey: event.idempotencyKey,
      // Use the event's timestamp if provided, otherwise fall back to now.
      timestamp: event.timestamp > 0 ? event.timestamp : Date.now(),
      raw: event.raw,
    };
  }
}
