/**
 * SDK process spawner — execute Claude Code inside Docker containers.
 *
 * Wraps Dockerode's container.exec() to run a Claude Code CLI process inside
 * a pre-warmed container. Configuration is delivered via stdin JSON so that
 * secrets never appear in environment variables or on disk. Output is parsed
 * using sentinel markers written by the in-container agent entrypoint.
 *
 * Architecture:
 *   talond calls spawn() -> dockerode exec -> Claude Code CLI inside container
 *   Claude Code writes output framed by sentinel markers to stdout
 *   talond parses the sentinel-framed output, extracts session ID, strips
 *   internal tags, and returns a structured SdkProcessResult.
 */

import type Dockerode from 'dockerode';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import { SandboxError } from '../core/errors/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Marks the beginning of structured agent output in stdout. */
export const OUTPUT_START_SENTINEL = '---TALOND_OUTPUT_START---';
/** Marks the end of structured agent output in stdout. */
export const OUTPUT_END_SENTINEL = '---TALOND_OUTPUT_END---';

/** Regex to strip <internal>...</internal> blocks from agent output. */
const INTERNAL_TAG_RE = /<internal>[\s\S]*?<\/internal>/g;

/**
 * Regex to extract the SDK session ID from the output metadata block.
 * The in-container agent is expected to emit a line: SESSION_ID:<id>
 */
const SESSION_ID_RE = /^SESSION_ID:(.+)$/m;

/**
 * Regex to extract token usage from the output metadata block.
 * Format: TOKEN_USAGE:<inputTokens>,<outputTokens>,<cacheReadTokens>,<cacheWriteTokens>
 */
const TOKEN_USAGE_RE = /^TOKEN_USAGE:(\d+),(\d+),(\d+),(\d+)$/m;

/**
 * Regex to extract a single tool call result line.
 * Format: TOOL_CALL:<tool>,<requestId>,<status>
 */
const TOOL_CALL_RE = /^TOOL_CALL:([^,]+),([^,]+),(success|error)$/gm;

/** Default per-run timeout in milliseconds (5 minutes). */
const DEFAULT_RUN_TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration passed to the Claude Code process inside the container.
 *
 * Delivered as a JSON object written to the exec's stdin so that secrets
 * (API keys) are never exposed as environment variables or command-line args.
 */
export interface SdkSpawnConfig {
  /** Persona identifier driving this run. */
  personaId: string;
  /** System prompt content assembled for this persona. */
  systemPrompt: string;
  /** Anthropic model ID to use (e.g. "claude-sonnet-4-6"). */
  model: string;
  /** SDK session ID for resuming a prior conversation within this thread. */
  sessionId?: string;
  /** Authentication mode — subscription uses Claude.ai OAuth; api_key uses a raw key. */
  authMode: 'subscription' | 'api_key';
  /** Anthropic API key; only present when authMode is 'api_key'. */
  apiKey?: string;
  /** Skill identifiers loaded into this run. */
  skills: string[];
  /** Tool names the agent is allowed to call. */
  allowedTools: string[];
  /** Additional environment variables forwarded to the agent process. */
  env?: Record<string, string>;
}

/**
 * Structured result returned after a completed SDK process run.
 */
export interface SdkProcessResult {
  /** Parsed agent output (markdown), with internal tags stripped. */
  output: string;
  /** SDK session ID to pass to the next run for conversation continuity. */
  sessionId: string;
  /** Token consumption breakdown for this run; absent if not emitted. */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
  };
  /** Summary of every tool call made during the run. */
  toolCalls: Array<{
    tool: string;
    requestId: string;
    status: 'success' | 'error';
  }>;
}

// ---------------------------------------------------------------------------
// SdkProcessSpawner
// ---------------------------------------------------------------------------

/**
 * Executes Claude Code CLI runs inside existing Docker containers.
 *
 * Each call to spawn() creates a new `docker exec` in the specified container,
 * delivers the run configuration via stdin, then parses and returns the
 * structured output.  The container itself is kept alive between calls
 * (managed by SandboxManager / ContainerFactory).
 */
export class SdkProcessSpawner {
  private readonly timeoutMs: number;

  /**
   * @param docker     - Dockerode client connected to the Docker daemon.
   * @param logger     - Pino logger for structured log output.
   * @param timeoutMs  - Maximum wall-clock time for a single run (default 5 min).
   */
  constructor(
    private readonly docker: Dockerode,
    private readonly logger: pino.Logger,
    timeoutMs: number = DEFAULT_RUN_TIMEOUT_MS,
  ) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Execute Claude Code inside a running container and return parsed output.
   *
   * Steps:
   *  1. Create a docker exec for the Claude Code entrypoint.
   *  2. Start the exec with stdin/stdout/stderr attached.
   *  3. Write the JSON-serialised SdkSpawnConfig to stdin, then close stdin.
   *  4. Collect stdout / stderr with a timeout guard.
   *  5. Parse sentinel-framed output; extract session ID, token usage, tool calls.
   *  6. Strip <internal> tags from the visible output portion.
   *
   * @param containerId   - ID of the running Docker container.
   * @param config        - Persona / auth / skill configuration for this run.
   * @param ipcInputDir   - Host path where talond writes tool results back to the agent.
   * @param ipcOutputDir  - Host path where the agent writes tool requests for talond.
   * @returns Ok<SdkProcessResult> on success, Err<SandboxError> on failure.
   */
  async spawn(
    containerId: string,
    config: SdkSpawnConfig,
    ipcInputDir: string,
    ipcOutputDir: string,
  ): Promise<Result<SdkProcessResult, SandboxError>> {
    const spawnLog = this.logger.child({
      containerId,
      personaId: config.personaId,
      sessionId: config.sessionId,
    });

    spawnLog.info({ ipcInputDir, ipcOutputDir }, 'Spawning SDK process in container');

    try {
      // ------------------------------------------------------------------
      // 1. Create exec
      // ------------------------------------------------------------------
      const container = this.docker.getContainer(containerId);

      const envVars = buildEnvArray({
        TALON_IPC_INPUT_DIR: ipcInputDir,
        TALON_IPC_OUTPUT_DIR: ipcOutputDir,
        ...config.env,
      });

      const exec = await container.exec({
        Cmd: ['node', '/app/node_modules/.bin/claude-code', '--sdk-mode'],
        AttachStdin: true,
        AttachStdout: true,
        AttachStderr: true,
        Env: envVars,
      });

      // ------------------------------------------------------------------
      // 2. Start exec and attach streams
      // ------------------------------------------------------------------
      const stream = await exec.start({ hijack: true, stdin: true });

      // ------------------------------------------------------------------
      // 3. Deliver config via stdin, then close stdin
      // ------------------------------------------------------------------
      const configJson = JSON.stringify(config);
      await writeToStream(stream, configJson + '\n');
      // Signal end-of-input so the agent knows the config is complete.
      stream.end();

      // ------------------------------------------------------------------
      // 4. Collect stdout / stderr with timeout
      // ------------------------------------------------------------------
      const collected = await this.collectOutput(stream, spawnLog);

      if (collected.isErr()) {
        return err(collected.error);
      }

      const { stdout, stderr } = collected.value;

      if (stderr.length > 0) {
        spawnLog.warn({ stderr }, 'Claude Code process emitted stderr');
      }

      // ------------------------------------------------------------------
      // 5. Parse structured output
      // ------------------------------------------------------------------
      const parsed = parseOutput(stdout);

      if (parsed.isErr()) {
        spawnLog.error({ stdout, err: parsed.error.message }, 'Failed to parse agent output');
        return err(parsed.error);
      }

      spawnLog.info(
        {
          sessionId: parsed.value.sessionId,
          toolCallCount: parsed.value.toolCalls.length,
        },
        'SDK process completed successfully',
      );

      return ok(parsed.value);
    } catch (error) {
      const cause = error instanceof Error ? error : new Error(String(error));
      spawnLog.error({ err: cause.message }, 'SDK process spawn failed');
      return err(new SandboxError(`SDK process spawn failed in container ${containerId}: ${cause.message}`, cause));
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Collect all stdout and stderr from a docker exec stream with a timeout.
   *
   * Docker multiplexes stdout and stderr over a single stream using an 8-byte
   * header prefix per chunk: [stream_type(1), reserved(3), size(4)].
   * We demultiplex manually so we can capture stderr separately for logging.
   *
   * @param stream   - The hijacked exec stream.
   * @param log      - Child logger for this execution context.
   * @returns Ok<{stdout, stderr}> or Err<SandboxError> on timeout/error.
   */
  private collectOutput(
    stream: NodeJS.ReadWriteStream,
    log: pino.Logger,
  ): Promise<Result<{ stdout: string; stderr: string }, SandboxError>> {
    return new Promise((resolve) => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;

      const settle = (result: Result<{ stdout: string; stderr: string }, SandboxError>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        log.warn({ timeoutMs: this.timeoutMs }, 'SDK process timed out');
        settle(err(new SandboxError(`SDK process timed out after ${this.timeoutMs}ms`)));
      }, this.timeoutMs);

      // Docker exec stream uses a multiplexed format when TTY is false.
      // We need to demultiplex stdout (stream type 1) and stderr (stream type 2).
      let header: Buffer | null = null;
      let remaining = 0;
      let currentStream = 0;
      const chunks: Buffer[] = [];

      const processBuffer = (): void => {
        const combined = Buffer.concat(chunks);
        chunks.length = 0;

        let offset = 0;

        while (offset < combined.length) {
          // Read header if we don't have a pending frame.
          if (remaining === 0) {
            if (combined.length - offset < 8) {
              // Incomplete header; save leftovers for next chunk.
              chunks.push(combined.slice(offset));
              break;
            }
            header = combined.slice(offset, offset + 8);
            currentStream = header[0] ?? 0;
            remaining =
              ((header[4] ?? 0) << 24) |
              ((header[5] ?? 0) << 16) |
              ((header[6] ?? 0) << 8) |
              (header[7] ?? 0);
            offset += 8;
          }

          // Read frame payload.
          const available = combined.length - offset;
          const take = Math.min(available, remaining);
          const payload = combined.slice(offset, offset + take).toString('utf8');

          if (currentStream === 1) {
            stdoutBuf += payload;
          } else if (currentStream === 2) {
            stderrBuf += payload;
          }

          remaining -= take;
          offset += take;
        }
      };

      stream.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
        processBuffer();
      });

      stream.on('end', () => {
        // Process any remaining buffered data.
        if (chunks.length > 0) {
          processBuffer();
        }
        settle(ok({ stdout: stdoutBuf, stderr: stderrBuf }));
      });

      stream.on('error', (error: Error) => {
        settle(err(new SandboxError(`SDK process stream error: ${error.message}`, error)));
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Module-level parsing helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse the sentinel-framed stdout from a Claude Code container run.
 *
 * Expected stdout structure:
 * ```
 * ... (any preamble before the sentinel) ...
 * ---TALOND_OUTPUT_START---
 * SESSION_ID:<sessionId>
 * TOKEN_USAGE:<in>,<out>,<cacheRead>,<cacheWrite>   (optional)
 * TOOL_CALL:<tool>,<requestId>,<status>              (zero or more)
 * <markdown output content>
 * <internal>...</internal>                           (stripped before return)
 * ---TALOND_OUTPUT_END---
 * ... (any trailing data after the sentinel) ...
 * ```
 *
 * @param stdout - Raw stdout string from the container exec.
 * @returns Ok<SdkProcessResult> or Err<SandboxError> if parsing fails.
 */
export function parseOutput(stdout: string): Result<SdkProcessResult, SandboxError> {
  const startIdx = stdout.indexOf(OUTPUT_START_SENTINEL);
  const endIdx = stdout.indexOf(OUTPUT_END_SENTINEL);

  if (startIdx === -1) {
    return err(new SandboxError(`Missing output start sentinel in agent output`));
  }
  if (endIdx === -1) {
    return err(new SandboxError(`Missing output end sentinel in agent output`));
  }
  if (endIdx <= startIdx) {
    return err(new SandboxError(`Output end sentinel appears before start sentinel`));
  }

  // Extract the framed block (excluding the sentinel lines themselves).
  const framedContent = stdout.slice(startIdx + OUTPUT_START_SENTINEL.length, endIdx);

  // Extract session ID (required).
  const sessionMatch = SESSION_ID_RE.exec(framedContent);
  if (!sessionMatch) {
    return err(new SandboxError(`Missing SESSION_ID in agent output`));
  }
  const sessionId = (sessionMatch[1] ?? '').trim();

  // Extract optional token usage.
  const tokenMatch = TOKEN_USAGE_RE.exec(framedContent);
  const tokenUsage = tokenMatch
    ? {
        inputTokens: parseInt(tokenMatch[1] ?? '0', 10),
        outputTokens: parseInt(tokenMatch[2] ?? '0', 10),
        cacheReadTokens: parseInt(tokenMatch[3] ?? '0', 10),
        cacheWriteTokens: parseInt(tokenMatch[4] ?? '0', 10),
      }
    : undefined;

  // Extract tool calls.
  const toolCalls: SdkProcessResult['toolCalls'] = [];
  let toolMatch: RegExpExecArray | null;
  // Reset lastIndex since we use the 'g' flag.
  TOOL_CALL_RE.lastIndex = 0;
  while ((toolMatch = TOOL_CALL_RE.exec(framedContent)) !== null) {
    toolCalls.push({
      tool: toolMatch[1] ?? '',
      requestId: toolMatch[2] ?? '',
      status: (toolMatch[3] ?? 'error') as 'success' | 'error',
    });
  }

  // Strip metadata lines and <internal> tags to produce clean markdown output.
  const output = stripMetadataAndInternalTags(framedContent);

  return ok({ output, sessionId, tokenUsage, toolCalls });
}

/**
 * Remove metadata lines (SESSION_ID, TOKEN_USAGE, TOOL_CALL) and
 * <internal>...</internal> blocks from the framed output block.
 *
 * What remains is the visible markdown content that should be returned to the
 * caller as the agent's reply.
 *
 * @param content - The raw framed content between the two sentinels.
 * @returns Clean output text with leading/trailing whitespace trimmed.
 */
export function stripMetadataAndInternalTags(content: string): string {
  const lines = content.split('\n');
  const metadataLineRe = /^(SESSION_ID:|TOKEN_USAGE:|TOOL_CALL:)/;

  const filtered = lines.filter((line) => !metadataLineRe.test(line));
  const joined = filtered.join('\n');

  // Remove <internal> blocks (may span multiple lines).
  const stripped = joined.replace(INTERNAL_TAG_RE, '');

  return stripped.trim();
}

// ---------------------------------------------------------------------------
// Internal utilities
// ---------------------------------------------------------------------------

/**
 * Build a `KEY=value` environment array for docker exec from a plain object.
 *
 * Skips keys whose value is undefined.
 *
 * @param env - Key/value environment variables.
 * @returns Array of `KEY=value` strings.
 */
function buildEnvArray(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([k, v]) => `${k}=${v}`);
}

/**
 * Write a string to a writable stream and wait for the drain event if needed.
 *
 * @param stream - Writable stream (e.g. exec stdin).
 * @param data   - UTF-8 string to write.
 */
function writeToStream(stream: NodeJS.WritableStream, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const canContinue = stream.write(data, 'utf8', (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });

    if (!canContinue) {
      // Back-pressure: wait for drain before resolving.
      stream.once('drain', resolve);
      stream.once('error', reject);
    }
  });
}
