/**
 * Host-side tool: net.http
 *
 * Proxies outbound HTTP/HTTPS requests from the sandbox through the host,
 * enforcing domain allowlists and rate limits defined in the persona policy.
 *
 * The sandbox never has direct network access — all egress goes through this
 * proxy so the host can log, audit, and gate every external request.
 *
 * Gated by `net.http:egress`.
 *
 * @remarks Full implementation in TASK-029.
 */

import type { ToolManifest } from '../tool-types.js';

/** Manifest for the net.http host tool. */
export interface HttpProxyTool {
  readonly manifest: ToolManifest;
}

/** Arguments accepted by the net.http tool. */
export interface HttpProxyArgs {
  /** HTTP method. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD';
  /** Target URL (must match the persona's domain allowlist). */
  url: string;
  /** Optional request headers. */
  headers?: Record<string, string>;
  /** Optional request body (for POST/PUT/PATCH). */
  body?: string;
  /** Request timeout in milliseconds (default: 30 000). */
  timeoutMs?: number;
}
