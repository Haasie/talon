/**
 * MCP proxy — mediates tool calls from sandboxed agents to external MCP servers.
 *
 * Responsibilities:
 * 1. Validates that the target server exists and is running.
 * 2. Checks that the requested tool is allowed (per-server allowedTools pattern).
 * 3. Checks that the persona has a capability matching this server.
 * 4. Enforces per-server rate limits (in-memory token bucket).
 * 5. Forwards the call to the MCP server over configured transport.
 * 6. Returns Result<McpToolResult, McpError>; never throws.
 *
 * MCP server failures are caught and wrapped in McpError so the sandbox
 * agent receives a structured error rather than an unhandled exception.
 */

import type pino from 'pino';
import { spawn } from 'node:child_process';
import { ok, err, type Result } from '../core/types/result.js';
import { McpError } from '../core/errors/error-types.js';
import type { McpRegistry } from './mcp-registry.js';
import type {
  McpToolCall,
  McpToolResult,
  McpServerConfig,
  McpRateLimitConfig,
} from './mcp-types.js';

// ---------------------------------------------------------------------------
// Token bucket
// ---------------------------------------------------------------------------

/** Default calls per minute when no rate limit is configured. */
const DEFAULT_CALLS_PER_MINUTE = 60;
const STDIO_TIMEOUT_MS = 15_000;

/**
 * Simple in-memory token bucket for per-server rate limiting.
 *
 * Tokens refill linearly over time up to `capacity`. Each call consumes one
 * token. If no tokens remain the call is rejected immediately (no queuing).
 */
class TokenBucket {
  private tokens: number;
  private lastRefillMs: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMs: number,
  ) {
    this.tokens = capacity;
    this.lastRefillMs = Date.now();
  }

  /**
   * Attempt to consume one token.
   * @returns `true` if the token was consumed (call is allowed); `false` if rate-limited.
   */
  consume(): boolean {
    this.refill();
    if (this.tokens < 1) {
      return false;
    }
    this.tokens -= 1;
    return true;
  }

  /** Returns the current token count (after a refill). */
  available(): number {
    this.refill();
    return this.tokens;
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefillMs;
    const added = elapsed * this.refillPerMs;
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefillMs = now;
  }
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

/**
 * Host-side proxy for MCP tool calls originating from sandbox agents.
 *
 * Each instance maintains one token bucket per registered server. Buckets are
 * created lazily on the first call to a given server.
 */
export class McpProxy {
  private readonly rateBuckets = new Map<string, TokenBucket>();

  constructor(
    private readonly registry: McpRegistry,
    private readonly logger: pino.Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Handle an MCP tool call from a sandbox agent.
   *
   * Validates the call against policy (server existence, tool allowlist, persona
   * capabilities, rate limit) and forwards it to the backing MCP server.
   *
   * @param call                 - The tool call request from the sandbox.
   * @param personaCapabilities  - Capability labels held by the requesting persona.
   * @returns `Ok(McpToolResult)` on success, `Err(McpError)` on any failure.
   */
  async handleToolCall(
    call: McpToolCall,
    personaCapabilities: string[],
  ): Promise<Result<McpToolResult, McpError>> {
    try {
      // Step 1: Validate the server exists and is running.
      const entry = this.registry.get(call.serverName);
      if (!entry) {
        return err(new McpError(`MCP server "${call.serverName}" is not registered`));
      }

      if (entry.status !== 'running') {
        return err(
          new McpError(`MCP server "${call.serverName}" is not running (status: ${entry.status})`),
        );
      }

      // Step 2: Check persona capabilities — persona must hold a capability that
      // matches this server (capability label: `mcp.<serverName>`).
      const requiredCapability = `mcp.${call.serverName}`;
      if (!personaCapabilities.includes(requiredCapability)) {
        this.logger.warn(
          {
            requestId: call.requestId,
            serverName: call.serverName,
            toolName: call.toolName,
            requiredCapability,
          },
          'MCP call denied: persona lacks required capability',
        );
        return err(
          new McpError(
            `Persona does not have capability "${requiredCapability}" required to access MCP server "${call.serverName}"`,
          ),
        );
      }

      // Step 3: Check tool allowlist.
      const toolAllowed = this.isToolAllowed(call.toolName, entry.config.allowedTools);
      if (!toolAllowed) {
        this.logger.warn(
          {
            requestId: call.requestId,
            serverName: call.serverName,
            toolName: call.toolName,
          },
          'MCP call denied: tool not in allowlist',
        );
        return err(
          new McpError(`Tool "${call.toolName}" is not allowed on MCP server "${call.serverName}"`),
        );
      }

      // Step 4: Rate limit check.
      const bucket = this.getOrCreateBucket(call.serverName, entry.config.rateLimit);
      if (!bucket.consume()) {
        this.logger.warn(
          {
            requestId: call.requestId,
            serverName: call.serverName,
            toolName: call.toolName,
          },
          'MCP call denied: rate limit exceeded',
        );
        return err(new McpError(`Rate limit exceeded for MCP server "${call.serverName}"`));
      }

      // Step 5: Forward the call.
      this.logger.debug(
        {
          requestId: call.requestId,
          serverName: call.serverName,
          toolName: call.toolName,
        },
        'forwarding MCP tool call',
      );

      const result = await this.forwardCall(call, entry.config);

      this.logger.debug(
        {
          requestId: call.requestId,
          serverName: call.serverName,
          toolName: call.toolName,
          durationMs: result.durationMs,
        },
        'MCP tool call completed',
      );

      return ok(result);
    } catch (caught) {
      // MCP server failures must never crash the daemon.
      const message = caught instanceof Error ? caught.message : String(caught);
      this.logger.error(
        {
          requestId: call.requestId,
          serverName: call.serverName,
          toolName: call.toolName,
          err: caught,
        },
        'unexpected error during MCP tool call',
      );
      return err(
        new McpError(
          `Unexpected error forwarding call to MCP server "${call.serverName}": ${message}`,
          caught instanceof Error ? caught : undefined,
        ),
      );
    }
  }

  /**
   * Filter a list of MCP server configs to those accessible by a persona.
   *
   * A server is accessible if the persona holds the capability label
   * `mcp.<serverName>`.
   *
   * @param personaCapabilities - Capability labels held by the persona.
   * @param allServers          - Full list of server configs to filter.
   * @returns The subset of servers the persona may access.
   */
  buildAllowedServers(
    personaCapabilities: string[],
    allServers: McpServerConfig[],
  ): McpServerConfig[] {
    return allServers.filter((server) => personaCapabilities.includes(`mcp.${server.name}`));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Check whether a tool name is permitted by the server's allowedTools config.
   *
   * If `allowedTools` is undefined or empty, all tools are allowed (open policy).
   * Otherwise, the tool name must match at least one pattern. Patterns support
   * simple glob-style matching: `*` matches any sequence of non-`.` characters.
   *
   * @param toolName     - The bare tool name to check.
   * @param allowedTools - Optional list of allowed tool patterns.
   */
  private isToolAllowed(toolName: string, allowedTools?: string[]): boolean {
    if (!allowedTools || allowedTools.length === 0) {
      return true;
    }

    return allowedTools.some((pattern) => this.matchesPattern(toolName, pattern));
  }

  /**
   * Simple glob pattern matcher.
   * Supports `*` (matches any characters) and exact string matching.
   *
   * @param value   - The string to test.
   * @param pattern - The pattern to match against.
   */
  private matchesPattern(value: string, pattern: string): boolean {
    // Convert glob pattern to regex: escape special chars, replace * with .*
    const regexSource = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape regex special chars except *
      .replace(/\*/g, '.*'); // glob * -> regex .*
    const regex = new RegExp(`^${regexSource}$`);
    return regex.test(value);
  }

  /**
   * Get or lazily create the token bucket for a server.
   *
   * @param serverName  - Server name (used as bucket key).
   * @param rateLimit   - Rate limit config from the server's config.
   */
  private getOrCreateBucket(serverName: string, rateLimit?: McpRateLimitConfig): TokenBucket {
    let bucket = this.rateBuckets.get(serverName);
    if (!bucket) {
      const callsPerMinute = rateLimit?.callsPerMinute ?? DEFAULT_CALLS_PER_MINUTE;
      const refillPerMs = callsPerMinute / 60_000;
      bucket = new TokenBucket(callsPerMinute, refillPerMs);
      this.rateBuckets.set(serverName, bucket);
    }
    return bucket;
  }

  /**
   * Forward the MCP tool call to the backing server.
   */
  private async forwardCall(
    call: McpToolCall,
    serverConfig: McpServerConfig,
  ): Promise<McpToolResult> {
    const startMs = Date.now();

    if (serverConfig.transport === 'stdio') {
      const content = await this.forwardStdioCall(call, serverConfig);
      return {
        requestId: call.requestId,
        serverName: call.serverName,
        toolName: call.toolName,
        content,
        durationMs: Date.now() - startMs,
      };
    }

    if (serverConfig.transport === 'http' || serverConfig.transport === 'sse') {
      if (!serverConfig.url) {
        throw new McpError(`MCP server "${call.serverName}" is missing a URL`);
      }

      const abortController = new AbortController();
      const timeout = setTimeout(() => abortController.abort(), 15_000);

      try {
        const response = await fetch(serverConfig.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            requestId: call.requestId,
            toolName: call.toolName,
            args: call.args,
          }),
          signal: abortController.signal,
        });

        if (!response.ok) {
          throw new McpError(`MCP server "${call.serverName}" returned HTTP ${response.status}`);
        }

        const contentType = response.headers.get('content-type') ?? '';
        const content = contentType.includes('application/json')
          ? await response.json()
          : await response.text();

        return {
          requestId: call.requestId,
          serverName: call.serverName,
          toolName: call.toolName,
          content,
          durationMs: Date.now() - startMs,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new McpError(`Unsupported MCP transport: ${String(serverConfig.transport)}`);
  }

  private forwardStdioCall(call: McpToolCall, serverConfig: McpServerConfig): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (!serverConfig.command) {
        reject(new McpError(`MCP server "${call.serverName}" is missing stdio command`));
        return;
      }

      const child = spawn(serverConfig.command, serverConfig.args ?? [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(serverConfig.env ?? {}) },
      });

      let stdout = '';
      let stderr = '';
      let settled = false;

      const settleError = (error: McpError): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill('SIGKILL');
        reject(error);
      };

      const settleSuccess = (value: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve(value);
      };

      const timeout = setTimeout(() => {
        settleError(new McpError(`MCP stdio call timed out for server "${call.serverName}"`));
      }, STDIO_TIMEOUT_MS);

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });

      child.on('error', (cause) => {
        settleError(new McpError(`Failed to start MCP stdio process: ${cause.message}`, cause));
      });

      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          settleError(
            new McpError(
              `MCP stdio process exited with code ${code} for server "${call.serverName}": ${stderr.trim() || 'no stderr'}`,
            ),
          );
          return;
        }

        const trimmed = stdout.trim();
        if (!trimmed) {
          settleSuccess({});
          return;
        }

        try {
          settleSuccess(JSON.parse(trimmed));
        } catch {
          settleSuccess(trimmed);
        }
      });

      const payload = JSON.stringify({
        requestId: call.requestId,
        toolName: call.toolName,
        args: call.args,
      });
      child.stdin.write(payload + '\n', 'utf8', (error) => {
        if (error) {
          settleError(new McpError(`Failed writing to MCP stdio stdin: ${error.message}`, error));
          return;
        }
        child.stdin.end();
      });
    });
  }
}
