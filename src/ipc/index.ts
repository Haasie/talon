/**
 * Inter-process communication (IPC) subsystem.
 *
 * Provides the daemon control protocol used by talonctl for
 * status, reload, and shutdown commands.
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

// Daemon IPC
export {
  DaemonCommandSchema,
  DaemonResponseSchema,
  DaemonIpcServer,
  DaemonIpcClient,
} from './daemon-ipc.js';
export type {
  DaemonCommandType,
  DaemonCommand,
  DaemonResponse,
  DaemonIpcServerOptions,
  DaemonIpcClientOptions,
} from './daemon-ipc.js';
