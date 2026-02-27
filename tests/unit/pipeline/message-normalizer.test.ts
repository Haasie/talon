/**
 * Unit tests for MessageNormalizer.
 *
 * The normalizer is a pure, stateless transformation with no external
 * dependencies. All tests use plain in-memory data without a database.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MessageNormalizer } from '../../../src/pipeline/message-normalizer.js';
import type { InboundEvent } from '../../../src/channels/channel-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a minimal valid InboundEvent with optional overrides. */
function makeEvent(overrides: Partial<InboundEvent> = {}): InboundEvent {
  return {
    channelType: 'telegram',
    channelName: 'my-telegram-bot',
    externalThreadId: 'ext-thread-123',
    senderId: 'user-456',
    idempotencyKey: 'idempotency-abc',
    content: 'Hello, world!',
    timestamp: 1700000000000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MessageNormalizer', () => {
  let normalizer: MessageNormalizer;

  beforeEach(() => {
    normalizer = new MessageNormalizer();
  });

  // -------------------------------------------------------------------------
  // Field mapping
  // -------------------------------------------------------------------------

  describe('field mapping', () => {
    it('maps event content to the normalized content field', () => {
      const event = makeEvent({ content: 'test message content' });
      const result = normalizer.normalize(event, 'chan-1', 'thread-1');
      expect(result.content).toBe('test message content');
    });

    it('maps event senderId to the normalized senderId field', () => {
      const event = makeEvent({ senderId: 'user-999' });
      const result = normalizer.normalize(event, 'chan-1', 'thread-1');
      expect(result.senderId).toBe('user-999');
    });

    it('maps event idempotencyKey verbatim to the normalized message', () => {
      const event = makeEvent({ idempotencyKey: 'unique-key-xyz' });
      const result = normalizer.normalize(event, 'chan-1', 'thread-1');
      expect(result.idempotencyKey).toBe('unique-key-xyz');
    });

    it('uses the provided channelId (not from the event)', () => {
      const event = makeEvent();
      const result = normalizer.normalize(event, 'resolved-channel-uuid', 'thread-1');
      expect(result.channelId).toBe('resolved-channel-uuid');
    });

    it('uses the provided threadId (not derived from the event)', () => {
      const event = makeEvent();
      const result = normalizer.normalize(event, 'chan-1', 'resolved-thread-uuid');
      expect(result.threadId).toBe('resolved-thread-uuid');
    });

    it('preserves the raw field from the event', () => {
      const raw = { update_id: 12345, message: { text: 'hi' } };
      const event = makeEvent({ raw });
      const result = normalizer.normalize(event, 'chan-1', 'thread-1');
      expect(result.raw).toBe(raw);
    });

    it('preserves a null/undefined raw field', () => {
      const event = makeEvent({ raw: undefined });
      const result = normalizer.normalize(event, 'chan-1', 'thread-1');
      expect(result.raw).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // ID generation
  // -------------------------------------------------------------------------

  describe('id generation', () => {
    it('generates a UUID v4 for the message id', () => {
      const result = normalizer.normalize(makeEvent(), 'chan-1', 'thread-1');
      expect(result.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it('generates a unique id on each call', () => {
      const event = makeEvent();
      const a = normalizer.normalize(event, 'chan-1', 'thread-1');
      const b = normalizer.normalize(event, 'chan-1', 'thread-1');
      expect(a.id).not.toBe(b.id);
    });
  });

  // -------------------------------------------------------------------------
  // Timestamp handling
  // -------------------------------------------------------------------------

  describe('timestamp handling', () => {
    it('uses the event timestamp when it is a positive number', () => {
      const event = makeEvent({ timestamp: 1_700_000_000_000 });
      const result = normalizer.normalize(event, 'chan-1', 'thread-1');
      expect(result.timestamp).toBe(1_700_000_000_000);
    });

    it('falls back to Date.now() when event timestamp is 0', () => {
      const now = 1_700_500_000_000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const event = makeEvent({ timestamp: 0 });
      const result = normalizer.normalize(event, 'chan-1', 'thread-1');
      expect(result.timestamp).toBe(now);

      vi.restoreAllMocks();
    });

    it('falls back to Date.now() when event timestamp is negative', () => {
      const now = 1_700_500_000_001;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const event = makeEvent({ timestamp: -1 });
      const result = normalizer.normalize(event, 'chan-1', 'thread-1');
      expect(result.timestamp).toBe(now);

      vi.restoreAllMocks();
    });
  });

  // -------------------------------------------------------------------------
  // Shape completeness
  // -------------------------------------------------------------------------

  describe('output shape', () => {
    it('returns a complete NormalizedMessage with all required fields', () => {
      const event = makeEvent();
      const result = normalizer.normalize(event, 'chan-uuid', 'thread-uuid');

      expect(result).toMatchObject({
        id: expect.any(String),
        threadId: 'thread-uuid',
        channelId: 'chan-uuid',
        senderId: event.senderId,
        content: event.content,
        idempotencyKey: event.idempotencyKey,
        timestamp: event.timestamp,
      });
    });

    it('handles an event with all optional fields populated', () => {
      const event = makeEvent({
        attachments: [{ filename: 'file.txt', mimeType: 'text/plain', data: Buffer.from(''), size: 0 }],
        raw: { extra: true },
      });
      const result = normalizer.normalize(event, 'c', 't');
      expect(result.raw).toEqual({ extra: true });
      // attachments are not part of NormalizedMessage — they are not forwarded.
      expect(Object.keys(result)).not.toContain('attachments');
    });
  });
});
