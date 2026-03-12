/**
 * IPC message type definitions and Zod validation schemas.
 *
 * Defines all message types exchanged between the host daemon and sandboxed
 * containers via the file-based IPC subsystem. Every message carries a common
 * base envelope (id, type, runId, threadId, timestamp) plus a type-specific
 * payload.
 *
 * Message flow:
 *   host -> container: message.new, tool.result, shutdown
 *   container -> host: message.send, tool.request, memory.read, memory.write,
 *                      artifact.put
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Base envelope
// ---------------------------------------------------------------------------

/** Common fields present on every IPC message. */
export const IpcMessageBaseSchema = z.object({
  /** UUID v4 uniquely identifying this message. */
  id: z.uuid(),
  /** Discriminant string; narrows to a specific message type. */
  type: z.string(),
  /** Identifier for the current agent run. */
  runId: z.string().min(1),
  /** Identifier for the conversation thread. */
  threadId: z.string().min(1),
  /** Unix epoch milliseconds when the message was created. */
  timestamp: z.number().int().positive(),
});

export type IpcMessageBase = z.infer<typeof IpcMessageBaseSchema>;

// ---------------------------------------------------------------------------
// message.new  (host -> container)
// ---------------------------------------------------------------------------

/** Delivers a new inbound channel message to the container. */
export const MessageNewSchema = IpcMessageBaseSchema.extend({
  type: z.literal('message.new'),
  payload: z.object({
    /** Raw text content of the inbound message. */
    content: z.string(),
    /** Channel identifier the message arrived on. */
    channelId: z.string().min(1),
    /** Sender identifier (platform-specific). */
    senderId: z.string().optional(),
    /** Optional metadata passed by the channel adapter. */
    metadata: z.record(z.string(), z.unknown()).optional(),
  }),
});

export type MessageNew = z.infer<typeof MessageNewSchema>;

// ---------------------------------------------------------------------------
// message.send  (container -> host)
// ---------------------------------------------------------------------------

/** Requests the host to send a message to a channel on behalf of the agent. */
export const MessageSendSchema = IpcMessageBaseSchema.extend({
  type: z.literal('message.send'),
  payload: z.object({
    /** Target channel identifier. */
    channelId: z.string().min(1),
    /** Markdown content to send. */
    content: z.string(),
    /** Optional reply-to message identifier (platform-specific). */
    replyToId: z.string().optional(),
  }),
});

export type MessageSend = z.infer<typeof MessageSendSchema>;

// ---------------------------------------------------------------------------
// tool.request  (container -> host)
// ---------------------------------------------------------------------------

/** Requests the host to execute a tool and return the result. */
export const ToolRequestSchema = IpcMessageBaseSchema.extend({
  type: z.literal('tool.request'),
  payload: z.object({
    /** Name of the registered tool to invoke. */
    toolName: z.string().min(1),
    /** Tool-specific input arguments. */
    args: z.record(z.string(), z.unknown()),
  }),
});

export type ToolRequest = z.infer<typeof ToolRequestSchema>;

// ---------------------------------------------------------------------------
// tool.result  (host -> container)
// ---------------------------------------------------------------------------

/** Returns the result of a previously requested tool execution. */
export const ToolResultSchema = IpcMessageBaseSchema.extend({
  type: z.literal('tool.result'),
  payload: z.object({
    /** ID of the originating tool.request message. */
    requestId: z.uuid(),
    /** Whether the tool executed successfully. */
    success: z.boolean(),
    /** Tool output on success. */
    result: z.unknown().optional(),
    /** Error message on failure. */
    error: z.string().optional(),
  }),
});

export type ToolResult = z.infer<typeof ToolResultSchema>;

// ---------------------------------------------------------------------------
// memory.read  (container -> host)
// ---------------------------------------------------------------------------

/** Requests the host to read a value from per-thread memory. */
export const MemoryReadSchema = IpcMessageBaseSchema.extend({
  type: z.literal('memory.read'),
  payload: z.object({
    /** Namespaced key to read (e.g. "facts/user-name"). */
    key: z.string().min(1),
  }),
});

export type MemoryRead = z.infer<typeof MemoryReadSchema>;

// ---------------------------------------------------------------------------
// memory.write  (container -> host)
// ---------------------------------------------------------------------------

/** Requests the host to write a value to per-thread memory. */
export const MemoryWriteSchema = IpcMessageBaseSchema.extend({
  type: z.literal('memory.write'),
  payload: z.object({
    /** Namespaced key to write. */
    key: z.string().min(1),
    /** Value to store (must be JSON-serialisable). */
    value: z.unknown(),
    /** TTL in seconds; omit for indefinite retention. */
    ttlSeconds: z.number().int().positive().optional(),
  }),
});

export type MemoryWrite = z.infer<typeof MemoryWriteSchema>;

// ---------------------------------------------------------------------------
// artifact.put  (container -> host)
// ---------------------------------------------------------------------------

/** Requests the host to persist a generated artifact (file, image, etc.). */
export const ArtifactPutSchema = IpcMessageBaseSchema.extend({
  type: z.literal('artifact.put'),
  payload: z.object({
    /** Logical file name for the artifact. */
    name: z.string().min(1),
    /** MIME type of the artifact content. */
    mimeType: z.string().min(1),
    /** Base64-encoded content. */
    content: z.string().min(1),
    /** Optional human-readable description. */
    description: z.string().optional(),
  }),
});

export type ArtifactPut = z.infer<typeof ArtifactPutSchema>;

// ---------------------------------------------------------------------------
// shutdown  (host -> container)
// ---------------------------------------------------------------------------

/** Instructs the container agent to shut down gracefully. */
export const ShutdownSchema = IpcMessageBaseSchema.extend({
  type: z.literal('shutdown'),
  payload: z.object({
    /** Human-readable reason for the shutdown. */
    reason: z.string().optional(),
  }),
});

export type Shutdown = z.infer<typeof ShutdownSchema>;

// ---------------------------------------------------------------------------
// Discriminated union
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all IPC message types.
 * Use {@link IpcMessageSchema} to parse and validate untrusted JSON.
 */
export const IpcMessageSchema = z.discriminatedUnion('type', [
  MessageNewSchema,
  MessageSendSchema,
  ToolRequestSchema,
  ToolResultSchema,
  MemoryReadSchema,
  MemoryWriteSchema,
  ArtifactPutSchema,
  ShutdownSchema,
]);

export type IpcMessage = z.infer<typeof IpcMessageSchema>;

/** Union of all concrete message type strings. */
export type IpcMessageType = IpcMessage['type'];
