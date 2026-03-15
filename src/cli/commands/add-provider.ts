/**
 * `talonctl add-provider` command.
 *
 * Adds a new provider entry to `agentRunner.providers`, `backgroundAgent.providers`,
 * or both in talond.yaml.
 */

import {
  DEFAULT_CONFIG_PATH,
  validateName,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ProviderContext = 'agent-runner' | 'background' | 'both';

export interface AddProviderOptions {
  name: string;
  command: string;
  context?: ProviderContext;
  contextWindowTokens?: number;
  rotationThreshold?: number;
  enabled?: boolean;
  defaultModel?: string;
  configPath?: string;
}

export interface ProviderEntry {
  enabled: boolean;
  command: string;
  contextWindowTokens: number;
  rotationThreshold: number;
  options?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Adds a provider to the config file.
 *
 * Pure business logic — no console output or process.exit.
 * Can be called from CLI, setup skill, or terminal agent.
 *
 * @returns The provider entry that was added.
 * @throws Error with a user-facing message on any failure.
 */
export async function addProvider(options: AddProviderOptions): Promise<{ entry: ProviderEntry; contexts: ProviderContext[] }> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const ctx = options.context ?? 'both';

  // Validate context.
  const validContexts: ProviderContext[] = ['agent-runner', 'background', 'both'];
  if (!validContexts.includes(ctx)) {
    throw new Error(`Invalid context "${ctx}". Must be one of: ${validContexts.join(', ')}.`);
  }

  // Validate name.
  const nameError = validateName(options.name, 'Provider');
  if (nameError) {
    throw new Error(nameError);
  }

  // Validate command.
  if (!options.command || options.command.trim() === '') {
    throw new Error('Provider command must not be empty.');
  }

  // Validate contextWindowTokens.
  const contextWindowTokens = options.contextWindowTokens ?? 200000;
  if (!Number.isFinite(contextWindowTokens) || contextWindowTokens < 1000) {
    throw new Error('contextWindowTokens must be a finite number >= 1000.');
  }

  // Validate rotationThreshold.
  const rotationThreshold = options.rotationThreshold ?? 0.4;
  if (!Number.isFinite(rotationThreshold) || rotationThreshold < 0 || rotationThreshold > 1) {
    throw new Error('rotationThreshold must be a finite number between 0 and 1.');
  }

  // Read existing config.
  const doc = await readConfig(configPath);

  // Build the provider entry.
  const entry: ProviderEntry = {
    enabled: options.enabled ?? false,
    command: options.command.trim(),
    contextWindowTokens,
    rotationThreshold,
  };

  if (options.defaultModel) {
    entry.options = { defaultModel: options.defaultModel };
  }

  const appliedContexts: ProviderContext[] = [];

  // Helper to add to a specific section.
  function applyToSection(sectionKey: 'agentRunner' | 'backgroundAgent', contextLabel: ProviderContext): void {
    // Ensure section exists.
    if (!doc[sectionKey] || typeof doc[sectionKey] !== 'object') {
      doc[sectionKey] = {} as Record<string, unknown>;
    }

    const section = doc[sectionKey] as Record<string, unknown>;

    // Ensure providers object exists.
    if (!section.providers || typeof section.providers !== 'object') {
      section.providers = {} as Record<string, unknown>;
    }

    const providers = section.providers as Record<string, unknown>;

    // Check for duplicate.
    if (options.name in providers) {
      throw new Error(
        `A provider named "${options.name}" already exists in ${sectionKey} context of "${configPath}". Choose a different name or edit the existing entry directly.`,
      );
    }

    providers[options.name] = { ...entry };
    appliedContexts.push(contextLabel);
  }

  if (ctx === 'agent-runner' || ctx === 'both') {
    applyToSection('agentRunner', 'agent-runner');
  }

  if (ctx === 'background' || ctx === 'both') {
    applyToSection('backgroundAgent', 'background');
  }

  // Write atomically.
  await writeConfigAtomic(configPath, doc);

  return { entry, contexts: appliedContexts };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl add-provider`.
 *
 * Thin wrapper around {@link addProvider} that prints output and exits.
 */
export async function addProviderCommand(options: AddProviderOptions): Promise<void> {
  try {
    const { entry, contexts } = await addProvider(options);
    const contextList = contexts.join(', ');
    console.log(`Added provider "${options.name}" (command: ${entry.command}) to context(s): ${contextList} in "${options.configPath ?? DEFAULT_CONFIG_PATH}".`);
    if (!entry.enabled) {
      console.log(`Note: provider is disabled by default. Set enabled: true in "${options.configPath ?? DEFAULT_CONFIG_PATH}" or use --enabled to enable immediately.`);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
