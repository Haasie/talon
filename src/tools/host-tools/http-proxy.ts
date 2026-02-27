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
 */

import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolExecutionContext } from './channel-send.js';

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

/** Default request timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Maximum allowed timeout in milliseconds. */
const MAX_TIMEOUT_MS = 120_000;

/** Valid HTTP methods for this proxy tool. */
const VALID_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']);

/**
 * Handler class for the net.http host tool.
 *
 * Validates the target URL against a domain allowlist before making the
 * request using Node.js built-in fetch(). Returns the HTTP status, headers,
 * and body text to the caller.
 */
export class HttpProxyHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: 'net.http',
    description:
      'Proxies outbound HTTP/HTTPS requests from the sandbox through the host, enforcing domain allowlists.',
    capabilities: ['net.http:egress'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      logger: pino.Logger;
      /** Allowed domains (e.g. ['api.example.com', 'example.com']). Empty array = deny all. */
      allowedDomains: string[];
    },
  ) {}

  /**
   * Execute the net.http proxy tool.
   *
   * @param args    - Validated tool arguments.
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  async execute(args: HttpProxyArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';
    const { method, url, headers, body, timeoutMs } = args;

    this.deps.logger.info(
      { requestId, runId: context.runId, personaId: context.personaId, method, url },
      'net.http: executing',
    );

    // Validate method
    if (!method || !VALID_METHODS.has(method)) {
      const error = new ToolError(
        `net.http: invalid method "${method}". Must be one of: ${[...VALID_METHODS].join(', ')}`,
      );
      this.deps.logger.warn({ requestId, method }, error.message);
      return { requestId, tool: 'net.http', status: 'error', error: error.message };
    }

    // Validate URL
    if (!url || typeof url !== 'string' || url.trim() === '') {
      const error = new ToolError('net.http: url is required and must be a non-empty string');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'net.http', status: 'error', error: error.message };
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      const error = new ToolError(`net.http: invalid URL "${url}"`);
      this.deps.logger.warn({ requestId, url }, error.message);
      return { requestId, tool: 'net.http', status: 'error', error: error.message };
    }

    // Only allow HTTP and HTTPS
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      const error = new ToolError(
        `net.http: unsupported protocol "${parsedUrl.protocol}". Only http: and https: are allowed`,
      );
      this.deps.logger.warn({ requestId, url }, error.message);
      return { requestId, tool: 'net.http', status: 'error', error: error.message };
    }

    // Validate against domain allowlist
    const hostname = parsedUrl.hostname;
    if (!this.isDomainAllowed(hostname)) {
      const error = new ToolError(
        `net.http: domain "${hostname}" is not in the allowed domains list`,
      );
      this.deps.logger.warn({ requestId, url, hostname }, error.message);
      return { requestId, tool: 'net.http', status: 'error', error: error.message };
    }

    // Determine timeout
    const timeout = Math.min(timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);

    // Execute the request with a timeout signal
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(url, {
        method,
        headers: headers ?? {},
        body: body ?? undefined,
        signal: controller.signal,
      });

      clearTimeout(timeoutHandle);

      // Collect response headers as a plain object
      const responseHeaders: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        responseHeaders[key] = value;
      });

      const responseBody = await response.text();

      this.deps.logger.info(
        { requestId, url, status: response.status },
        'net.http: request completed',
      );

      return {
        requestId,
        tool: 'net.http',
        status: 'success',
        result: {
          status: response.status,
          headers: responseHeaders,
          body: responseBody,
        },
      };
    } catch (cause) {
      clearTimeout(timeoutHandle);

      if (cause instanceof Error && cause.name === 'AbortError') {
        this.deps.logger.warn({ requestId, url, timeoutMs: timeout }, 'net.http: request timed out');
        return { requestId, tool: 'net.http', status: 'timeout' };
      }

      const msg = `net.http: request failed — ${cause instanceof Error ? cause.message : String(cause)}`;
      this.deps.logger.error({ requestId, url, err: cause }, msg);
      return { requestId, tool: 'net.http', status: 'error', error: msg };
    }
  }

  /**
   * Check whether the given hostname is in the allowedDomains list.
   *
   * A domain entry matches if the hostname equals it exactly or is a
   * subdomain of it (e.g. allowedDomains: ['example.com'] matches
   * 'api.example.com' and 'example.com').
   *
   * @param hostname - Parsed hostname from the request URL.
   */
  private isDomainAllowed(hostname: string): boolean {
    for (const allowed of this.deps.allowedDomains) {
      if (hostname === allowed || hostname.endsWith(`.${allowed}`)) {
        return true;
      }
    }
    return false;
  }
}
