/**
 * Types for the terminal channel connector.
 *
 * Defines the config shape and WebSocket wire protocol messages.
 */

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Channel config for the terminal connector (from talond.yaml). */
export interface TerminalConfig {
  /** WebSocket server port. */
  port: number;
  /** WebSocket server bind address (default: '127.0.0.1'). */
  host?: string;
  /** Shared secret token for client authentication. */
  token: string;
}

// ---------------------------------------------------------------------------
// Wire protocol — Client → Server
// ---------------------------------------------------------------------------

export interface AuthMessage {
  type: 'auth';
  token: string;
  clientId: string;
  /** Optional persona override — changes channel→persona binding on connect. */
  persona?: string;
}

export interface TextMessage {
  type: 'message';
  content: string;
}

export type ClientMessage = AuthMessage | TextMessage;

// ---------------------------------------------------------------------------
// Wire protocol — Server → Client
// ---------------------------------------------------------------------------

export interface AuthOkMessage {
  type: 'auth_ok';
}

export interface AuthErrorMessage {
  type: 'auth_error';
  reason: string;
}

export interface TypingMessage {
  type: 'typing';
}

export interface ResponseMessage {
  type: 'response';
  body: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | AuthOkMessage
  | AuthErrorMessage
  | TypingMessage
  | ResponseMessage
  | ErrorMessage;
