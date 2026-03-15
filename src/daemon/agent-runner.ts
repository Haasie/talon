import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, type Result } from 'neverthrow';

import type { DaemonContext } from './daemon-context.js';
import type { QueueItem } from '../queue/queue-types.js';
import { filterAllowedMcpTools } from '../tools/tool-filter.js';
import { buildPersonaRuntimeContext } from '../personas/persona-runtime-context.js';

/** Default maximum time (ms) an Agent SDK query may run before being aborted. */
const DEFAULT_QUERY_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes

class AgentQueryAttemptError extends Error {
  constructor(
    message: string,
    readonly resumeSessionId: string | undefined,
    readonly sawEvents: boolean,
  ) {
    super(message);
    this.name = 'AgentQueryAttemptError';
  }
}

/**
 * AgentRunner — executes queue items by running the Claude Agent SDK.
 *
 * Extracted from TalondDaemon.handleQueueItem to enable isolated testing
 * and cleaner separation of concerns.
 */
export class AgentRunner {
  private readonly ctx: DaemonContext;
  private readonly queryTimeoutMs: number;

  constructor(ctx: DaemonContext, options?: { queryTimeoutMs?: number }) {
    this.ctx = ctx;
    this.queryTimeoutMs = options?.queryTimeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
  }

  /**
   * Processes a single queue item by loading the persona, initializing
   * the workspace, running the Agent SDK query, and sending the response
   * back through the channel connector.
   */
  async run(item: QueueItem): Promise<Result<void, Error>> {
    const personaId = typeof item.payload.personaId === 'string' ? item.payload.personaId : null;
    if (personaId === null) {
      return err(new Error(`queue item ${item.id} is missing payload.personaId`));
    }

    const backgroundTaskNotification = this.parseBackgroundTaskNotification(item);
    if (backgroundTaskNotification) {
      return this.deliverBackgroundTaskNotification(item.threadId, backgroundTaskNotification);
    }

    const personaRowResult = this.ctx.repos.persona.findById(personaId);
    if (personaRowResult.isErr() || personaRowResult.value === null) {
      return err(new Error(`persona not found for id ${personaId}`));
    }

    const personaName = personaRowResult.value.name;
    const loadedPersonaResult = this.ctx.personaLoader.getByName(personaName);
    if (loadedPersonaResult.isErr() || loadedPersonaResult.value === undefined) {
      return err(new Error(`loaded persona not found for ${personaName}`));
    }
    const loadedPersona = loadedPersonaResult.value;

    // Resolve session ID: check in-memory tracker first, fall back to DB.
    // We do NOT seed the tracker here — only after a successful run (line ~335)
    // to avoid stranding a thread on a stale/expired session ID.
    // Skip DB fallback if the session was explicitly rotated by ContextRoller.
    let resolvedSessionId = this.ctx.sessionTracker.getSessionId(item.threadId);
    if (!resolvedSessionId && !this.ctx.sessionTracker.wasRotated(item.threadId)) {
      const dbSessionResult = this.ctx.repos.run.getLatestSessionId(item.threadId);
      if (dbSessionResult.isOk() && dbSessionResult.value) {
        resolvedSessionId = dbSessionResult.value;
        this.ctx.logger.info(
          { threadId: item.threadId, sessionId: resolvedSessionId },
          'agent-sdk: restored session from DB after restart',
        );
      }
    }

    const runId = uuidv4();
    const now = Date.now();
    const runInsert = this.ctx.repos.run.insert({
      id: runId,
      thread_id: item.threadId,
      persona_id: personaId,
      sandbox_id: null,
      session_id: resolvedSessionId ?? null,
      status: 'running',
      parent_run_id: null,
      queue_item_id: item.id,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      cost_usd: 0,
      error: null,
      started_at: now,
      ended_at: null,
    });

    if (runInsert.isErr()) {
      return err(new Error(`failed to create run record: ${runInsert.error.message}`));
    }

    const workspaceResult = this.ctx.threadWorkspace.ensureDirectories(item.threadId);
    if (workspaceResult.isErr()) {
      this.ctx.repos.run.updateStatus(runId, 'failed', {
        ended_at: Date.now(),
        error: workspaceResult.error.message,
      });
      return err(new Error(workspaceResult.error.message));
    }

    let typingInterval: ReturnType<typeof setInterval> | undefined;
    try {
      const content = typeof item.payload.content === 'string' ? item.payload.content : '';
      const personaSkills = this.ctx.loadedSkills.filter((skill) =>
        loadedPersona.config.skills.includes(skill.manifest.name),
      );
      const personaRuntimeContext = buildPersonaRuntimeContext({
        loadedPersona,
        resolvedSkills: personaSkills,
        skillResolver: this.ctx.skillResolver,
        logger: this.ctx.logger,
      });

      const model = loadedPersona.config.model;

      // Build channel context so the agent knows which channels are available.
      const threadRow = this.ctx.repos.thread.findById(item.threadId);
      const currentChannelRow =
        threadRow.isOk() && threadRow.value
          ? this.ctx.repos.channel.findById(threadRow.value.channel_id)
          : null;
      const currentChannelName =
        currentChannelRow && currentChannelRow.isOk() && currentChannelRow.value
          ? currentChannelRow.value.name
          : undefined;
      const allChannels = this.ctx.channelRegistry
        .listAll()
        .map((c) => c.name);

      const channelContext = [
        'Available channels for channel_send tool:',
        ...allChannels.map((name) =>
          name === currentChannelName ? `  - ${name} (current thread)` : `  - ${name}`,
        ),
        currentChannelName
          ? `When sending messages, use channelId: "${currentChannelName}".`
          : '',
      ]
        .filter(Boolean)
        .join('\n');

      // Generate fresh timestamp per run so the agent can reason about time.
      const now_ = new Date();
      const pad = (n: number): string => String(n).padStart(2, '0');
      const offsetMin = now_.getTimezoneOffset();
      const offsetSign = offsetMin <= 0 ? '+' : '-';
      const absOffset = Math.abs(offsetMin);
      const offsetStr = `${offsetSign}${pad(Math.floor(absOffset / 60))}:${pad(absOffset % 60)}`;
      const localISO = `${now_.getFullYear()}-${pad(now_.getMonth() + 1)}-${pad(now_.getDate())}T${pad(now_.getHours())}:${pad(now_.getMinutes())}:${pad(now_.getSeconds())}${offsetStr}`;
      const tzAbbr = Intl.DateTimeFormat('en', { timeZoneName: 'short' }).formatToParts(now_).find((p) => p.type === 'timeZoneName')?.value ?? 'UTC';
      const dayName = now_.toLocaleDateString('en', { weekday: 'long' });
      const timeContext = `Current time: ${localISO} (${tzAbbr}, ${dayName})`;

      // ----------------------------------------------------------------
      // Agent SDK mode: run Claude Code as a full autonomous agent with
      // tools, hooks, MCP servers, session resumption, and permissions.
      // ----------------------------------------------------------------

      // Use the session ID resolved earlier (in-memory or DB fallback).
      const existingSessionId = resolvedSessionId;

      const { query } = await import('@anthropic-ai/claude-agent-sdk');

      const mcpServers: Record<string, unknown> = { ...personaRuntimeContext.mcpServers };

      // Determine which host tools this persona may use based on capabilities.
      let allowedMcpTools = filterAllowedMcpTools(
        loadedPersona.resolvedCapabilities ?? { allow: [], requireApproval: [] },
      );
      if (!this.ctx.backgroundAgentManager) {
        allowedMcpTools = allowedMcpTools.filter((toolName) => toolName !== 'background_agent');
      }

      // Add built-in host-tools MCP server (schedule, channel, memory, http, db).
      // Only tools allowed by persona capabilities are exposed via TALOND_ALLOWED_TOOLS.
      mcpServers['host-tools'] = {
        type: 'stdio',
        command: 'node',
        args: [join(import.meta.dirname, '../../dist/tools/host-tools-mcp-server.js')],
        env: {
          ...process.env,
          TALOND_SOCKET: this.ctx.hostToolsBridge.path,
          TALOND_RUN_ID: runId,
          TALOND_THREAD_ID: item.threadId,
          TALOND_PERSONA_ID: personaId,
          TALOND_ALLOWED_TOOLS: allowedMcpTools.join(','),
        },
      };

      this.ctx.logger.info(
        { runId, personaId, allowedMcpTools },
        'agent-sdk: persona tool restrictions applied',
      );

      // Resolve channel connector early so we can send typing indicators.
      const threadResult = this.ctx.repos.thread.findById(item.threadId);
      const channelRow =
        threadResult.isOk() && threadResult.value
          ? this.ctx.repos.channel.findById(threadResult.value.channel_id)
          : null;
      const connector =
        channelRow && channelRow.isOk() && channelRow.value
          ? this.ctx.channelRegistry.get(channelRow.value.name)
          : undefined;
      const externalId =
        threadResult.isOk() && threadResult.value ? threadResult.value.external_id : undefined;

      // Send typing indicator and keep it alive every 4s while the agent works.
      if (connector?.sendTyping && externalId) {
        connector.sendTyping(externalId).catch((e: unknown) => {
          this.ctx.logger.debug({ err: e }, 'sendTyping failed');
        });
        typingInterval = setInterval(() => {
          connector.sendTyping!(externalId).catch((e: unknown) => {
            this.ctx.logger.debug({ err: e }, 'sendTyping failed');
          });
        }, 4000);
      }

      let previousContextResolved = false;
      let previousContext: string | undefined;
      const getPreviousContext = (): string | undefined => {
        if (!previousContextResolved) {
          previousContext = this.ctx.contextAssembler.assemble(item.threadId) || undefined;
          previousContextResolved = true;
        }
        return previousContext;
      };

      const executeAgentQuery = async (resumeSessionId?: string): Promise<{
        outputText: string;
        resultSessionId: string | undefined;
        totalCostUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
      }> => {
        const systemPromptParts = [
          personaRuntimeContext.personaPrompt,
          channelContext,
          timeContext,
        ];
        if (!resumeSessionId) {
          const previous = getPreviousContext();
          if (previous) {
            systemPromptParts.push(previous);
          }
        }

        const agentOptions: Record<string, unknown> = {
          model,
          systemPrompt: systemPromptParts.filter(Boolean).join('\n\n'),
          permissionMode: 'bypassPermissions' as const,
          allowDangerouslySkipPermissions: true,
          cwd: workspaceResult.value,
          maxTurns: 25,
        };

        if (Object.keys(mcpServers).length > 0) {
          agentOptions.mcpServers = mcpServers;
          this.ctx.logger.info(
            { runId, mcpServers: Object.keys(mcpServers), resumeSession: resumeSessionId ?? null },
            'agent-sdk: attaching MCP servers from skills',
          );
        }

        if (resumeSessionId) {
          agentOptions.resume = resumeSessionId;
        }

        this.ctx.logger.info(
          {
            runId,
            personaId,
            model,
            threadId: item.threadId,
            resumeSession: resumeSessionId ?? null,
          },
          'agent-sdk: starting query',
        );

        let agentQuery: ReturnType<typeof query>;
        try {
          agentQuery = query({
            prompt: content,
            options: agentOptions as Parameters<typeof query>[0]['options'],
          });
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new AgentQueryAttemptError(message, resumeSessionId, false);
        }

        let outputText = '';
        let resultSessionId: string | undefined;
        let totalCostUsd = 0;
        let inputTokens = 0;
        let outputTokens = 0;
        let cacheReadTokens = 0;
        let cacheWriteTokens = 0;
        let sawEvents = false;

        const queryPromise = (async (): Promise<void> => {
          for await (const message of agentQuery) {
            sawEvents = true;
            if (message.type === 'assistant' && message.message?.content) {
              for (const block of message.message.content) {
                if ('text' in block && typeof (block as { text: string }).text === 'string') {
                  outputText += (block as { text: string }).text;
                }
              }
            } else if (message.type === 'result') {
              const result = message as {
                subtype: string;
                result?: string;
                session_id?: string;
                total_cost_usd?: number;
                usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number };
                is_error?: boolean;
              };
              resultSessionId = result.session_id;
              totalCostUsd = result.total_cost_usd ?? 0;
              inputTokens = result.usage?.input_tokens ?? 0;
              outputTokens = result.usage?.output_tokens ?? 0;
              cacheReadTokens = result.usage?.cache_read_input_tokens ?? 0;
              cacheWriteTokens = result.usage?.cache_creation_input_tokens ?? 0;

              if (!outputText && result.result) {
                outputText = result.result;
              }

              if (result.is_error) {
                this.ctx.logger.warn(
                  { runId, result: result.result },
                  'agent-sdk: run ended with error',
                );
              }
            } else {
              const msg = message as { type: string; tool?: string; subtype?: string };
              this.ctx.logger.debug(
                { runId, messageType: msg.type, tool: msg.tool, subtype: msg.subtype },
                'agent-sdk: streaming event',
              );
            }
          }
        })();

        let timeoutId: ReturnType<typeof setTimeout>;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error(`agent-sdk query timed out after ${this.queryTimeoutMs / 1000}s`)),
            this.queryTimeoutMs,
          );
        });

        try {
          await Promise.race([queryPromise, timeoutPromise]);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          throw new AgentQueryAttemptError(message, resumeSessionId, sawEvents);
        } finally {
          clearTimeout(timeoutId!);
          if (typeof agentQuery.return === 'function') {
            agentQuery.return(undefined).catch(() => {});
          }
        }

        return {
          outputText,
          resultSessionId,
          totalCostUsd,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        };
      };

      let outputText = '';
      let resultSessionId: string | undefined;
      let totalCostUsd = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let cacheReadTokens = 0;
      let cacheWriteTokens = 0;

      try {
        ({
          outputText,
          resultSessionId,
          totalCostUsd,
          inputTokens,
          outputTokens,
          cacheReadTokens,
          cacheWriteTokens,
        } = await executeAgentQuery(existingSessionId));
      } catch (cause) {
        if (this.shouldRetryFreshSession(cause)) {
          this.ctx.sessionTracker.rotateSession(item.threadId);
          this.ctx.logger.warn(
            {
              threadId: item.threadId,
              sessionId: cause.resumeSessionId,
              error: cause.message,
            },
            'agent-sdk: resumed session failed before any events, retrying fresh session',
          );
          ({
            outputText,
            resultSessionId,
            totalCostUsd,
            inputTokens,
            outputTokens,
            cacheReadTokens,
            cacheWriteTokens,
          } = await executeAgentQuery(undefined));
        } else {
          throw cause;
        }
      }

      // Store session ID for future conversation resumption (memory + DB).
      if (resultSessionId) {
        this.ctx.sessionTracker.setSessionId(item.threadId, resultSessionId);
        this.ctx.repos.run.updateSessionId(runId, resultSessionId);
      }

      // Stop typing indicator.
      if (typingInterval) clearInterval(typingInterval);

      this.ctx.logger.info(
        { runId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, totalCostUsd, sessionId: resultSessionId },
        'agent-sdk: query completed',
      );

      // Persist token usage to the run record.
      const tokenResult = this.ctx.repos.run.updateTokens(runId, {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: cacheReadTokens,
        cache_write_tokens: cacheWriteTokens,
        cost_usd: totalCostUsd,
      });
      if (tokenResult.isErr()) {
        this.ctx.logger.error({ runId, err: tokenResult.error }, 'agent-sdk: failed to persist token usage');
      }

      // Check if context needs rotation (rolling window).
      // Awaited to prevent race with next queue item for the same thread.
      if (this.ctx.contextRoller && cacheReadTokens > 0) {
        try {
          await this.ctx.contextRoller.checkAndRotate(item.threadId, personaId, cacheReadTokens);
        } catch (e: unknown) {
          this.ctx.logger.error(
            { threadId: item.threadId, err: e },
            'agent-runner: context rotation failed',
          );
        }
      }

      if (item.type === 'schedule') {
        this.ctx.logger.info(
          { runId, outputLength: outputText.length },
          'agent-sdk: skipping outbound reply for schedule item (agent already sent via channel_send)',
        );
      } else if (connector !== undefined && externalId) {
        const sendResult = await connector.send(externalId, {
          body: outputText,
        });
        if (sendResult.isErr()) {
          throw new Error(`channel send failed: ${sendResult.error.message}`);
        }
      }

      this.ctx.repos.message.insert({
        id: uuidv4(),
        thread_id: item.threadId,
        direction: 'outbound',
        content: JSON.stringify({ body: outputText }),
        idempotency_key: `outbound:${runId}`,
        provider_id: null,
        run_id: runId,
      });

      this.ctx.repos.run.updateStatus(runId, 'completed', {
        ended_at: Date.now(),
      });
      return ok(undefined);
    } catch (cause) {
      if (typingInterval) clearInterval(typingInterval);
      const message = cause instanceof Error ? cause.message : String(cause);
      this.ctx.repos.run.updateStatus(runId, 'failed', { ended_at: Date.now(), error: message });
      return err(new Error(message));
    }
  }

  private shouldRetryFreshSession(cause: unknown): cause is AgentQueryAttemptError {
    if (!(cause instanceof AgentQueryAttemptError)) {
      return false;
    }
    if (!cause.resumeSessionId || cause.sawEvents) {
      return false;
    }

    const message = cause.message.toLowerCase();
    return (
      message.includes('session') ||
      message.includes('resume') ||
      message.includes('expired') ||
      message.includes('not found') ||
      message.includes('timed out')
    );
  }

  private parseBackgroundTaskNotification(item: QueueItem): {
    content: string;
    taskId: string;
    status: string;
  } | null {
    if (item.type !== 'collaboration') {
      return null;
    }

    const kind =
      typeof item.payload.kind === 'string'
        ? item.payload.kind
        : null;
    const content =
      typeof item.payload.content === 'string'
        ? item.payload.content
        : null;
    const taskId =
      typeof item.payload.taskId === 'string'
        ? item.payload.taskId
        : null;
    const status =
      typeof item.payload.status === 'string'
        ? item.payload.status
        : null;

    if (
      kind !== 'background_task_notification' ||
      content === null ||
      taskId === null ||
      status === null
    ) {
      return null;
    }

    return { content, taskId, status };
  }

  private async deliverBackgroundTaskNotification(
    threadId: string,
    notification: { content: string; taskId: string; status: string },
  ): Promise<Result<void, Error>> {
    const threadResult = this.ctx.repos.thread.findById(threadId);
    if (threadResult.isErr() || threadResult.value === null) {
      return err(new Error(`thread not found for id ${threadId}`));
    }

    const channelResult = this.ctx.repos.channel.findById(threadResult.value.channel_id);
    if (channelResult.isErr() || channelResult.value === null) {
      return err(new Error(`channel not found for id ${threadResult.value.channel_id}`));
    }

    const connector = this.ctx.channelRegistry.get(channelResult.value.name);
    if (!connector) {
      return err(new Error(`channel connector not found: ${channelResult.value.name}`));
    }

    const sendResult = await connector.send(threadResult.value.external_id, {
      body: notification.content,
    });
    if (sendResult.isErr()) {
      return err(new Error(`channel send failed: ${sendResult.error.message}`));
    }

    this.ctx.repos.message.insert({
      id: uuidv4(),
      thread_id: threadId,
      direction: 'outbound',
      content: JSON.stringify({ body: notification.content }),
      idempotency_key: `background-task:${notification.taskId}:${notification.status}`,
      provider_id: null,
      run_id: null,
    });

    return ok(undefined);
  }
}
