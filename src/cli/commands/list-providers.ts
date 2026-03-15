/**
 * `talonctl list-providers` command.
 *
 * Prints all providers from both `agentRunner.providers` and
 * `backgroundAgent.providers` in talond.yaml in table format.
 */

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListProvidersOptions {
  configPath?: string;
}

export interface ProviderInfo {
  context: 'agent-runner' | 'background';
  name: string;
  enabled: boolean;
  command: string;
  contextWindowTokens: number;
  isDefault: boolean;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Returns all providers from both agentRunner and backgroundAgent config sections.
 *
 * @throws Error if the config file can't be read.
 */
export async function listProviders(options: ListProvidersOptions = {}): Promise<ProviderInfo[]> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const doc = await readConfig(configPath);

  const results: ProviderInfo[] = [];

  // agentRunner.providers
  const agentRunnerSection = doc.agentRunner as Record<string, unknown> | undefined;
  const agentRunnerDefault = typeof agentRunnerSection?.defaultProvider === 'string'
    ? agentRunnerSection.defaultProvider
    : undefined;
  const agentRunnerProviders = agentRunnerSection?.providers as Record<string, unknown> | undefined;
  if (agentRunnerProviders && typeof agentRunnerProviders === 'object') {
    for (const [name, entry] of Object.entries(agentRunnerProviders)) {
      const p = entry as Record<string, unknown>;
      results.push({
        context: 'agent-runner',
        name,
        enabled: p.enabled !== false,
        command: typeof p.command === 'string' ? p.command : '',
        contextWindowTokens: typeof p.contextWindowTokens === 'number' ? p.contextWindowTokens : 200000,
        isDefault: agentRunnerDefault === name,
      });
    }
  }

  // backgroundAgent.providers
  const backgroundSection = doc.backgroundAgent as Record<string, unknown> | undefined;
  const backgroundDefault = typeof backgroundSection?.defaultProvider === 'string'
    ? backgroundSection.defaultProvider
    : undefined;
  const backgroundProviders = backgroundSection?.providers as Record<string, unknown> | undefined;
  if (backgroundProviders && typeof backgroundProviders === 'object') {
    for (const [name, entry] of Object.entries(backgroundProviders)) {
      const p = entry as Record<string, unknown>;
      results.push({
        context: 'background',
        name,
        enabled: p.enabled !== false,
        command: typeof p.command === 'string' ? p.command : '',
        contextWindowTokens: typeof p.contextWindowTokens === 'number' ? p.contextWindowTokens : 200000,
        isDefault: backgroundDefault === name,
      });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function listProvidersCommand(options: ListProvidersOptions = {}): Promise<void> {
  try {
    const providers = await listProviders(options);

    if (providers.length === 0) {
      console.log('No providers configured.');
      return;
    }

    // Column widths
    const COL_CONTEXT = 14;
    const COL_NAME = 14;
    const COL_ENABLED = 7;
    const COL_COMMAND = 12;
    const COL_CW = 14;
    const COL_DEFAULT = 7;

    // Header
    console.log(
      `${'CONTEXT'.padEnd(COL_CONTEXT)} ${'NAME'.padEnd(COL_NAME)} ${'ENABLED'.padEnd(COL_ENABLED)} ${'COMMAND'.padEnd(COL_COMMAND)} ${'CONTEXT WINDOW'.padEnd(COL_CW)} DEFAULT`,
    );
    console.log(
      `${'─'.repeat(COL_CONTEXT)} ${'─'.repeat(COL_NAME)} ${'─'.repeat(COL_ENABLED)} ${'─'.repeat(COL_COMMAND)} ${'─'.repeat(COL_CW)} ${'─'.repeat(COL_DEFAULT)}`,
    );

    for (const p of providers) {
      console.log(
        `${p.context.padEnd(COL_CONTEXT)} ${p.name.padEnd(COL_NAME)} ${(p.enabled ? 'yes' : 'no').padEnd(COL_ENABLED)} ${p.command.padEnd(COL_COMMAND)} ${String(p.contextWindowTokens).padEnd(COL_CW)} ${p.isDefault ? 'yes' : 'no'}`,
      );
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
