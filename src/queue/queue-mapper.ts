/**
 * Mapping utilities between the database row shape and the application-layer
 * QueueItem type.
 *
 * The database uses snake_case columns and stores JSON payloads as strings.
 * The application layer uses camelCase and parses the payload into
 * Record<string, unknown>. This module provides the conversion functions
 * used by queue components.
 */

import type { QueueItemRow } from '../core/database/repositories/queue-repository.js';
import { type QueueItem, QueueItemStatus } from './queue-types.js';

/**
 * Converts a database row into an application-layer QueueItem.
 *
 * @param row - Raw row from the `queue_items` table.
 * @returns The camelCase domain object.
 */
export function rowToQueueItem(row: QueueItemRow): QueueItem {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(row.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }

  return {
    id: row.id,
    threadId: row.thread_id,
    ...(row.message_id !== null && { messageId: row.message_id }),
    type: row.type,
    status: row.status as QueueItemStatus,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    ...(row.next_retry_at !== null && { nextRetryAt: row.next_retry_at }),
    ...(row.error !== null && { error: row.error }),
    payload,
    ...(row.claimed_at !== null && { claimedAt: row.claimed_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
