/**
 * `talonctl run-subagent` command.
 *
 * Manually invokes a sub-agent for testing/debugging purposes.
 * Loads the sub-agent, resolves the model, and executes it with
 * the provided JSON input. No database, daemon, or persona required.
 *
 * The pure `runSubAgent()` function can be called programmatically.
 * The `runSubAgentCommand()` wrapper handles config loading and console output.
 */

import { join } from 'node:path';
import { SubAgentLoader } from '../../subagents/subagent-loader.js';
import { ModelResolver } from '../../subagents/model-resolver.js';
import type { SubAgentResult } from '../../subagents/subagent-types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunSubAgentOptions {
  name: string;
  input: string;          // JSON string
  subagentsDir: string;
  providers: Record<string, { apiKey?: string; baseURL?: string }>;
}

// ---------------------------------------------------------------------------
// Core logic (importable, no console / process.exit)
// ---------------------------------------------------------------------------

const makeStderrLogger = () =>
  ({
    info: (...args: unknown[]) => { process.stderr.write(`[info] ${args.map(String).join(' ')}\n`); },
    warn: (...args: unknown[]) => { process.stderr.write(`[warn] ${args.map(String).join(' ')}\n`); },
    error: (...args: unknown[]) => { process.stderr.write(`[error] ${args.map(String).join(' ')}\n`); },
    debug: () => {},
    child() { return this; },
  }) as any;

export async function runSubAgent(options: RunSubAgentOptions): Promise<SubAgentResult> {
  const { name, input: inputStr, subagentsDir, providers } = options;

  // Parse input JSON.
  let input: Record<string, unknown>;
  try {
    input = JSON.parse(inputStr);
  } catch {
    throw new Error(`Invalid JSON input: ${inputStr}`);
  }

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    throw new Error('Invalid JSON input: must be a JSON object');
  }

  // Load sub-agents.
  const logger = makeStderrLogger();
  const loader = new SubAgentLoader(logger);
  const loadResult = await loader.loadAll(subagentsDir);
  if (loadResult.isErr()) {
    throw new Error(`Failed to load sub-agents: ${loadResult.error.message}`);
  }

  const agent = loadResult.value.find((a) => a.manifest.name === name);
  if (!agent) {
    const available = loadResult.value.map((a) => a.manifest.name).join(', ') || 'none';
    throw new Error(`Sub-agent "${name}" not found. Available: ${available}`);
  }

  // Resolve model.
  const resolver = new ModelResolver(providers);
  const modelResult = await resolver.resolve(agent.manifest.model);
  if (modelResult.isErr()) {
    throw new Error(`Model resolution failed: ${modelResult.error.message}`);
  }

  // Execute with manifest timeout.
  const systemPrompt = agent.promptContents.join('\n\n');
  const runPromise = agent.run(
    {
      threadId: 'cli-test',
      personaId: 'cli-test',
      systemPrompt,
      model: modelResult.value,
      maxOutputTokens: agent.manifest.model.maxTokens,
      rootPaths: agent.manifest.rootPaths,
      services: {
        memory: {} as any,
        schedules: {} as any,
        personas: {} as any,
        channels: {} as any,
        threads: {} as any,
        messages: {} as any,
        runs: {} as any,
        queue: {} as any,
        logger,
      },
    },
    input,
  );

  const timeoutMs = agent.manifest.timeoutMs;
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`Sub-agent "${name}" timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });

  let result: Awaited<ReturnType<typeof agent.run>>;
  try {
    result = await Promise.race([runPromise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId!);
  }

  if (result.isErr()) {
    throw new Error(`Sub-agent execution failed: ${result.error.message}`);
  }

  return result.value;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function runSubAgentCommand(options: {
  name: string;
  input: string;
  configPath?: string;
  subagentsDir?: string;
}): Promise<void> {
  const { loadConfig } = await import('../../core/config/config-loader.js');

  const configPath = options.configPath ?? 'talond.yaml';
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
  }

  const config = configResult.value;
  const subagentsDir = options.subagentsDir ?? join(config.dataDir, 'subagents');

  try {
    const result = await runSubAgent({
      name: options.name,
      input: options.input,
      subagentsDir,
      providers: config.auth.providers ?? {},
    });

    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
