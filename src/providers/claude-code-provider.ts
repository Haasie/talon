import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { err, ok, type Result } from 'neverthrow';
import { BackgroundAgentError } from '../core/errors/error-types.js';
import type { AgentProvider, AgentRunInput, AgentStreamEvent } from './provider.js';
import type {
  AgentUsage,
  CanonicalMcpServer,
  ContextUsage,
  PreparedProviderInvocation,
  ProviderResult,
  ProviderSpawnInput,
} from './provider-types.js';
import type { ProviderConfig } from '../core/config/config-types.js';

export class ClaudeCodeProvider implements AgentProvider {
  readonly name = 'claude-code';

  constructor(private readonly config: ProviderConfig) {}

  createExecutionStrategy() {
    return {
      type: 'sdk' as const,
      supportsSessionResumption: true as const,
      run: (input: AgentRunInput): AsyncIterable<AgentStreamEvent> => this.runSdkStrategy(input),
    };
  }

  prepareBackgroundInvocation(
    input: ProviderSpawnInput,
  ): Result<PreparedProviderInvocation, BackgroundAgentError> {
    let tempDir: string | undefined;

    try {
      tempDir = join(tmpdir(), `talon-provider-claude-code-${randomUUID()}`);
      mkdirSync(tempDir, { recursive: true, mode: 0o700 });

      const mcpConfigPath = join(tempDir, 'mcp-config.json');
      writeFileSync(
        mcpConfigPath,
        JSON.stringify({ mcpServers: this.toClaudeMcpServers(input.mcpServers) }, null, 2),
        { encoding: 'utf8', mode: 0o600 },
      );

      return ok({
        command: this.config.command,
        args: [
          '--print',
          '--output-format',
          'json',
          '--append-system-prompt',
          input.systemPrompt,
          '--mcp-config',
          mcpConfigPath,
          '--strict-mcp-config',
          '--dangerously-skip-permissions',
          '--no-session-persistence',
        ],
        stdin: input.prompt,
        cwd: input.cwd,
        timeoutMs: input.timeoutMs,
        cleanupPaths: [tempDir],
      });
    } catch (cause) {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }

      return err(
        new BackgroundAgentError(
          `Claude Code: failed to prepare background invocation: ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  parseBackgroundResult(raw: {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    timedOut: boolean;
  }): ProviderResult {
    let output = raw.stdout;
    let usage: AgentUsage | undefined;

    try {
      const parsed = JSON.parse(raw.stdout) as {
        result?: string;
        total_cost_usd?: number;
        usage?: {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
      };

      if (typeof parsed.result === 'string' && parsed.result.length > 0) {
        output = parsed.result;
      }

      if (parsed.usage) {
        usage = {
          inputTokens: parsed.usage.input_tokens ?? 0,
          outputTokens: parsed.usage.output_tokens ?? 0,
          cacheReadTokens: parsed.usage.cache_read_input_tokens,
          cacheWriteTokens: parsed.usage.cache_creation_input_tokens,
          totalCostUsd: parsed.total_cost_usd,
        };
      }
    } catch {
      // Plain-text output is valid fallback behavior.
    }

    return {
      output,
      stderr: raw.stderr,
      exitCode: raw.exitCode,
      timedOut: raw.timedOut,
      usage,
    };
  }

  estimateContextUsage(usage: AgentUsage): ContextUsage {
    const cacheReadTokens = usage.cacheReadTokens ?? 0;
    return {
      ratio: cacheReadTokens / Math.max(1, this.config.contextWindowTokens),
      inputTokens: usage.inputTokens,
      rawMetric: cacheReadTokens,
      rawMetricName: 'cache_read_input_tokens',
    };
  }

  private async *runSdkStrategy(input: AgentRunInput): AsyncIterable<AgentStreamEvent> {
    const { query } = await import('@anthropic-ai/claude-agent-sdk');
    const options: Record<string, unknown> = {
      model: input.model,
      systemPrompt: input.systemPrompt,
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      cwd: input.cwd,
      maxTurns: input.maxTurns,
    };

    if (Object.keys(input.mcpServers).length > 0) {
      options.mcpServers = this.toClaudeMcpServers(input.mcpServers);
    }

    if (input.sessionId) {
      options.resume = input.sessionId;
    }

    const agentQuery = query({
      prompt: input.prompt,
      options: options as Parameters<typeof query>[0]['options'],
    });

    try {
      for await (const message of agentQuery) {
        if (message.type === 'assistant' && message.message?.content) {
          for (const block of message.message.content) {
            if ('text' in block && typeof block.text === 'string') {
              yield { type: 'text', content: block.text };
            }
          }
          continue;
        }

        if (message.type === 'result') {
          const result = message as {
            result?: string;
            session_id?: string;
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            };
            total_cost_usd?: number;
            is_error?: boolean;
          };

          yield {
            type: 'result',
            result: {
              output: result.result ?? '',
              sessionId: result.session_id,
              usage: {
                inputTokens: result.usage?.input_tokens ?? 0,
                outputTokens: result.usage?.output_tokens ?? 0,
                cacheReadTokens: result.usage?.cache_read_input_tokens,
                cacheWriteTokens: result.usage?.cache_creation_input_tokens,
                totalCostUsd: result.total_cost_usd,
              },
              isError: result.is_error ?? false,
            },
          };
          continue;
        }

        const toolMessage = message as { type?: string; tool?: string; subtype?: string };
        if (toolMessage.type && toolMessage.type !== 'assistant' && toolMessage.type !== 'result') {
          yield {
            type: 'tool_event',
            messageType: toolMessage.type,
            tool: toolMessage.tool,
            subtype: toolMessage.subtype,
          };
        }
      }
    } finally {
      if (typeof agentQuery.return === 'function') {
        agentQuery.return(undefined).catch(() => {});
      }
    }
  }

  private toClaudeMcpServers(
    mcpServers: Record<string, CanonicalMcpServer>,
  ): Record<string, unknown> {
    const nativeServers: Record<string, unknown> = {};

    for (const [name, server] of Object.entries(mcpServers)) {
      if (server.transport === 'stdio') {
        nativeServers[name] = {
          type: 'stdio',
          command: server.command,
          args: server.args,
          ...(server.env ? { env: server.env } : {}),
        };
        continue;
      }

      nativeServers[name] = {
        type: server.transport,
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
      };
    }

    return nativeServers;
  }
}
