/**
 * Inter-process communication (IPC) subsystem.
 *
 * Implements file-based atomic IPC between the daemon and sandboxed containers,
 * and between talonctl and talond. Uses write-file-atomic for crash-safe writes
 * and a configurable poll interval (default 500 ms).
 *
 * Public surface:
 *   - {@link IpcMessage} / {@link IpcMessageSchema} — message types and validation
 *   - {@link IpcWriter} — atomic file writer
 *   - {@link IpcReader} — directory poller
 *   - {@link BidirectionalIpcChannel} — combined channel abstraction
 *   - {@link DaemonCommand} / {@link DaemonResponse} — daemon control protocol
 */

// Message types and schemas
export {
  IpcMessageBaseSchema,
  MessageNewSchema,
  MessageSendSchema,
  ToolRequestSchema,
  ToolResultSchema,
  MemoryReadSchema,
  MemoryWriteSchema,
  ArtifactPutSchema,
  ShutdownSchema,
  IpcMessageSchema,
} from './ipc-types.js';

export type {
  IpcMessageBase,
  IpcMessage,
  IpcMessageType,
  MessageNew,
  MessageSend,
  ToolRequest,
  ToolResult,
  MemoryRead,
  MemoryWrite,
  ArtifactPut,
  Shutdown,
} from './ipc-types.js';

// Writer
export { IpcWriter, buildFilename } from './ipc-writer.js';

// Reader
export { IpcReader, DEFAULT_READER_OPTIONS } from './ipc-reader.js';
export type { IpcReaderOptions } from './ipc-reader.js';

// Bidirectional channel
export { BidirectionalIpcChannel } from './ipc-channel.js';

// Daemon IPC
export {
  DaemonCommandSchema,
  DaemonResponseSchema,
} from './daemon-ipc.js';
export type {
  DaemonCommandType,
  DaemonCommand,
  DaemonResponse,
} from './daemon-ipc.js';
