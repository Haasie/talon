import { describe, expect, it } from 'vitest';
import { ProviderRegistry } from '../../../src/providers/provider-registry.js';

describe('ProviderRegistry', () => {
  it('registers enabled providers and resolves preferred defaults', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          rotationThreshold: 0.4,
        },
        'gemini-cli': {
          enabled: false,
          command: 'gemini',
          contextWindowTokens: 1000000,
          rotationThreshold: 0.8,
        },
        'codex-cli': {
          enabled: true,
          command: 'codex',
          contextWindowTokens: 200000,
          rotationThreshold: 0.6,
        },
      },
      {
        'claude-code': () => ({ name: 'claude-code' }) as any,
        'gemini-cli': () => ({ name: 'gemini-cli' }) as any,
        'codex-cli': () => ({ name: 'codex-cli' }) as any,
      },
    );

    expect(registry.listEnabled()).toEqual(['claude-code', 'codex-cli']);
    expect(registry.get('claude-code')?.provider.name).toBe('claude-code');
    expect(registry.get('gemini-cli')).toBeUndefined();
    expect(registry.getDefault(['gemini-cli', 'codex-cli'])?.provider.name).toBe('codex-cli');
  });

  it('falls back to the first enabled provider when no preferred provider matches', () => {
    const registry = new ProviderRegistry(
      {
        'claude-code': {
          enabled: true,
          command: 'claude',
          contextWindowTokens: 200000,
          rotationThreshold: 0.4,
        },
      },
      {
        'claude-code': () => ({ name: 'claude-code' }) as any,
      },
    );

    expect(registry.getDefault(['missing-provider'])?.provider.name).toBe('claude-code');
  });
});
