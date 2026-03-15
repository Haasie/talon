/**
 * `talonctl set-default-provider` command.
 *
 * Switches the default provider for `agentRunner` or `backgroundAgent`
 * in talond.yaml. The named provider must exist and be enabled in the
 * specified context.
 */

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SetDefaultProviderContext = 'agent-runner' | 'background';

export interface SetDefaultProviderOptions {
  name: string;
  context: SetDefaultProviderContext;
  configPath?: string;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Sets the default provider for the specified context.
 *
 * Pure business logic — no console output or process.exit.
 *
 * @throws Error with a user-facing message on any failure.
 */
export async function setDefaultProvider(options: SetDefaultProviderOptions): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  if (!options.name || options.name.trim() === '') {
    throw new Error('Provider name must not be empty.');
  }

  const doc = await readConfig(configPath);

  const sectionKey = options.context === 'agent-runner' ? 'agentRunner' : 'backgroundAgent';
  const section = doc[sectionKey] as Record<string, unknown> | undefined;

  if (!section || typeof section !== 'object') {
    throw new Error(
      `No "${sectionKey}" section found in "${configPath}". Add providers first.`,
    );
  }

  const providers = section.providers as Record<string, unknown> | undefined;
  if (!providers || typeof providers !== 'object') {
    throw new Error(
      `No providers configured in "${sectionKey}" context of "${configPath}".`,
    );
  }

  if (!(options.name in providers)) {
    const available = Object.keys(providers).join(', ') || 'none';
    throw new Error(
      `Provider "${options.name}" not found in "${sectionKey}" context of "${configPath}". Available: ${available}.`,
    );
  }

  const providerEntry = providers[options.name] as Record<string, unknown>;
  if (providerEntry.enabled === false) {
    throw new Error(
      `Provider "${options.name}" is disabled in "${sectionKey}" context. Enable it before setting it as default.`,
    );
  }

  section.defaultProvider = options.name;

  await writeConfigAtomic(configPath, doc);
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl set-default-provider`.
 *
 * Thin wrapper around {@link setDefaultProvider} that prints output and exits.
 */
export async function setDefaultProviderCommand(options: SetDefaultProviderOptions): Promise<void> {
  try {
    await setDefaultProvider(options);
    console.log(
      `Set "${options.name}" as default provider for context "${options.context}" in "${options.configPath ?? DEFAULT_CONFIG_PATH}".`,
    );
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}
