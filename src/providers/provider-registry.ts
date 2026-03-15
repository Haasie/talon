import type { AgentProvider } from './provider.js';
import type { ProviderConfig } from '../core/config/config-types.js';
import type { ProviderName } from './provider-types.js';

interface ProviderFactoryMap {
  [name: string]: (config: ProviderConfig) => AgentProvider;
}

interface ProviderEntry {
  provider: AgentProvider;
  config: ProviderConfig;
}

export class ProviderRegistry {
  private readonly providers = new Map<ProviderName, ProviderEntry>();

  constructor(
    configs: Record<string, ProviderConfig>,
    factories: ProviderFactoryMap,
  ) {
    for (const [name, config] of Object.entries(configs)) {
      if (!config.enabled) {
        continue;
      }

      const factory = factories[name];
      if (!factory) {
        continue;
      }

      this.providers.set(name, {
        provider: factory(config),
        config,
      });
    }
  }

  get(name: ProviderName): ProviderEntry | undefined {
    return this.providers.get(name);
  }

  getDefault(preferredOrder: ProviderName[]): ProviderEntry | undefined {
    for (const name of preferredOrder) {
      const entry = this.providers.get(name);
      if (entry) {
        return entry;
      }
    }

    // Map preserves insertion order, so this falls back to the first enabled
    // provider defined in config when no preferred provider matches.
    return this.providers.values().next().value;
  }

  listEnabled(): ProviderName[] {
    return [...this.providers.keys()];
  }
}
