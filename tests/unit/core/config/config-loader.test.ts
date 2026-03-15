import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadConfigFromString, validateConfig } from '../../../../src/core/config/config-loader.js';
import { ConfigError } from '../../../../src/core/errors/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpFile: string;

beforeEach(() => {
  // Create a unique temporary file path for each test
  tmpFile = join(tmpdir(), `talon-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}.yaml`);
});

afterEach(() => {
  // Clean up the temp file if it was created
  try {
    unlinkSync(tmpFile);
  } catch {
    // File may not have been created in every test
  }
});

function writeTempConfig(content: string): string {
  writeFileSync(tmpFile, content, 'utf-8');
  return tmpFile;
}

// ---------------------------------------------------------------------------
// loadConfigFromString
// ---------------------------------------------------------------------------

describe('loadConfigFromString', () => {
  it('returns Ok with all defaults for an empty YAML document', () => {
    const result = loadConfigFromString('');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('info');
      expect(result.value.storage.type).toBe('sqlite');
    }
  });

  it('returns Ok with all defaults for an explicit empty mapping', () => {
    const result = loadConfigFromString('{}');
    expect(result.isOk()).toBe(true);
  });

  it('parses a minimal valid YAML config', () => {
    const yaml = `
logLevel: debug
dataDir: /tmp/talon
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('debug');
      expect(result.value.dataDir).toBe('/tmp/talon');
    }
  });

  it('parses channels array from YAML', () => {
    const yaml = `
channels:
  - type: telegram
    name: main
    tokenRef: TELEGRAM_BOT_TOKEN
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.channels).toHaveLength(1);
      expect(result.value.channels[0].type).toBe('telegram');
      expect(result.value.channels[0].tokenRef).toBe('TELEGRAM_BOT_TOKEN');
    }
  });

  it('parses personas array from YAML', () => {
    const yaml = `
personas:
  - name: helper
    model: claude-opus-4-6
    skills:
      - web-search
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.personas).toHaveLength(1);
      expect(result.value.personas[0].name).toBe('helper');
      expect(result.value.personas[0].model).toBe('claude-opus-4-6');
      expect(result.value.personas[0].skills).toContain('web-search');
    }
  });

  it('returns Err(ConfigError) for invalid YAML syntax', () => {
    const result = loadConfigFromString('key: [unclosed');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/Failed to parse YAML/);
    }
  });

  it('truncates error message and appends "and N more" when more than 5 issues are present', () => {
    // Provide more than 5 simultaneously invalid fields to trigger the
    // `issues.length > 5 ? ` (and ${issues.length - 5} more)` : ''` true branch.
    // Each channel entry missing its required 'type' produces an issue; adding
    // multiple invalid top-level fields alongside channels pushes the count above 5.
    const yaml = `
logLevel: bad-level
sandbox:
  maxConcurrent: 0
  runtime: invalid-runtime
ipc:
  pollIntervalMs: 50
queue:
  maxAttempts: 0
  concurrencyLimit: 0
`;
    const result = loadConfigFromString(yaml);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/and \d+ more/);
    }
  });

  it('returns Err(ConfigError) with field path for schema violations', () => {
    const result = loadConfigFromString('logLevel: not-a-valid-level');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/validation failed/i);
      expect(result.error.message).toMatch(/logLevel/);
    }
  });

  it('returns Err(ConfigError) for invalid sandbox.maxConcurrent', () => {
    const result = loadConfigFromString('sandbox:\n  maxConcurrent: 0');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/sandbox\.maxConcurrent/);
    }
  });

  it('returns Err(ConfigError) for a missing required channel field', () => {
    const yaml = `
channels:
  - name: no-type-channel
`;
    const result = loadConfigFromString(yaml);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
    }
  });

  it('strips extra (unknown) fields from the config', () => {
    const result = loadConfigFromString('unknownTopLevelKey: 42');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect((result.value as Record<string, unknown>)['unknownTopLevelKey']).toBeUndefined();
    }
  });

  it('returns Err(ConfigError) for a persona with an empty name', () => {
    const yaml = `
personas:
  - name: ""
`;
    const result = loadConfigFromString(yaml);
    expect(result.isErr()).toBe(true);
  });

  it('handles a null YAML document (treated as empty config)', () => {
    const result = loadConfigFromString('null');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.personas).toEqual([]);
    }
  });

  it('maps deprecated backgroundAgent.claudePath to providers when providers are omitted', () => {
    const yaml = `
backgroundAgent:
  claudePath: /usr/local/bin/claude
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.backgroundAgent.defaultProvider).toBe('claude-code');
      expect(result.value.backgroundAgent.providers).toEqual({
        'claude-code': {
          enabled: true,
          command: '/usr/local/bin/claude',
          contextWindowTokens: 200000,
          rotationThreshold: 0.4,
        },
      });
      expect(result.value.backgroundAgent.claudePath).toBe('/usr/local/bin/claude');
    }
  });

  it('prefers explicit backgroundAgent.providers over deprecated claudePath', () => {
    const yaml = `
backgroundAgent:
  claudePath: /usr/local/bin/claude
  providers:
    claude-code:
      enabled: true
      command: /custom/claude
      contextWindowTokens: 210000
      rotationThreshold: 0.5
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.backgroundAgent.providers['claude-code']).toEqual({
        enabled: true,
        command: '/custom/claude',
        contextWindowTokens: 210000,
        rotationThreshold: 0.5,
      });
    }
  });

  it('maps deprecated context.thresholdTokens to the default provider rotation threshold', () => {
    const yaml = `
context:
  thresholdTokens: 100000
agentRunner:
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.agentRunner.providers['claude-code']).toEqual({
        enabled: true,
        command: 'claude',
        contextWindowTokens: 200000,
        rotationThreshold: 0.5,
      });
    }
  });

  it('keeps explicit provider rotationThreshold over deprecated context.thresholdTokens', () => {
    const yaml = `
context:
  thresholdTokens: 100000
agentRunner:
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
      rotationThreshold: 0.65
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.agentRunner.providers['claude-code']?.rotationThreshold).toBe(0.65);
    }
  });

  // -------------------------------------------------------------------------
  // Provider normalization — edge cases
  // -------------------------------------------------------------------------

  it('clamps rotationThreshold to 1.0 when thresholdTokens exceeds contextWindowTokens', () => {
    // thresholdTokens (300000) > contextWindowTokens (200000) → ratio 1.5 → clamped to 1.0
    const yaml = `
context:
  thresholdTokens: 300000
agentRunner:
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.agentRunner.providers['claude-code']?.rotationThreshold).toBe(1);
    }
  });

  it('sets rotationThreshold to 0 when thresholdTokens is zero', () => {
    // thresholdTokens of 0 is below the schema min(10000) so we use validateConfig
    // directly to bypass YAML string parsing and reach the normalization code path
    // where Math.max(0, 0/200000) = 0.
    const raw = {
      context: { thresholdTokens: 0 },
      agentRunner: {
        providers: {
          'claude-code': {
            enabled: true,
            command: 'claude',
            contextWindowTokens: 200000,
          },
        },
      },
    };
    const result = validateConfig(raw);
    // Zod schema enforces min(10000) on thresholdTokens, so this should fail validation.
    // The normalization runs before Zod validation, so the rotationThreshold 0 is set,
    // but the config is ultimately rejected by the schema.
    expect(result.isErr()).toBe(true);
  });

  it('explicit agentRunner.providers with rotationThreshold is not overwritten by thresholdTokens', () => {
    // This exercises the Object.hasOwn(rawProviderConfig, 'rotationThreshold') === true branch,
    // which causes the entire normalization to be skipped for that provider.
    const yaml = `
context:
  thresholdTokens: 50000
agentRunner:
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
      rotationThreshold: 0.9
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // rotationThreshold must remain as specified — normalization must not overwrite it
      expect(result.value.agentRunner.providers['claude-code']?.rotationThreshold).toBe(0.9);
    }
  });

  it('does not overwrite agentRunner.providers when already set and thresholdTokens omitted', () => {
    // No context.thresholdTokens key at all — normalization block is never entered.
    const yaml = `
agentRunner:
  defaultProvider: claude-code
  providers:
    claude-code:
      enabled: true
      command: /opt/claude
      contextWindowTokens: 150000
      rotationThreshold: 0.3
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.agentRunner.providers['claude-code']?.command).toBe('/opt/claude');
      expect(result.value.agentRunner.providers['claude-code']?.contextWindowTokens).toBe(150000);
      expect(result.value.agentRunner.providers['claude-code']?.rotationThreshold).toBe(0.3);
    }
  });

  it('prefers explicit backgroundAgent.providers over claudePath (claudePath present but providers win)', () => {
    // hasExplicitProviders === true → normalization skips the claudePath branch entirely
    const yaml = `
backgroundAgent:
  claudePath: /old/claude
  providers:
    claude-code:
      enabled: true
      command: /new/claude
      contextWindowTokens: 100000
      rotationThreshold: 0.2
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // The explicit providers entry must win; claudePath must not replace it
      expect(result.value.backgroundAgent.providers['claude-code']?.command).toBe('/new/claude');
      expect(result.value.backgroundAgent.providers['claude-code']?.contextWindowTokens).toBe(100000);
    }
  });

  it('applies all schema defaults when backgroundAgent is an empty object', () => {
    // backgroundAgent present but no fields → Zod defaults fill everything in;
    // no claudePath so the claudePath→providers normalization branch is skipped.
    const yaml = `
backgroundAgent: {}
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.backgroundAgent.enabled).toBe(true);
      expect(result.value.backgroundAgent.maxConcurrent).toBe(3);
      expect(result.value.backgroundAgent.defaultTimeoutMinutes).toBe(30);
      expect(result.value.backgroundAgent.defaultProvider).toBe('claude-code');
      expect(result.value.backgroundAgent.providers['claude-code']).toMatchObject({
        enabled: true,
        command: 'claude',
        contextWindowTokens: 200000,
        rotationThreshold: 0.4,
      });
    }
  });

  it('computes rotationThreshold from thresholdTokens when provider config has only command', () => {
    // Partial provider: only command supplied — contextWindowTokens absent so the
    // normalization falls back to the claude-code default of 200000.
    const yaml = `
context:
  thresholdTokens: 80000
agentRunner:
  providers:
    claude-code:
      enabled: true
      command: /usr/bin/claude
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const provider = result.value.agentRunner.providers['claude-code'];
      expect(provider?.contextWindowTokens).toBe(200000);
      // 80000 / 200000 = 0.4
      expect(provider?.rotationThreshold).toBeCloseTo(0.4);
    }
  });

  it('skips threshold normalization for a non-claude-code provider with no contextWindowTokens', () => {
    // When defaultProvider is not 'claude-code' and rawProviderConfig has no
    // contextWindowTokens, contextWindowTokens resolves to undefined and the whole
    // normalization block is skipped — agentRunner is left untouched.
    const yaml = `
context:
  thresholdTokens: 50000
agentRunner:
  defaultProvider: my-provider
  providers:
    my-provider:
      enabled: true
      command: /opt/my-ai
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // Zod default for rotationThreshold (0.4) should apply since normalization was skipped
      expect(result.value.agentRunner.providers['my-provider']?.rotationThreshold).toBe(0.4);
    }
  });

  it('falls back to claude-code defaultProvider when agentRunner.defaultProvider is not a string', () => {
    // When agentRunner.defaultProvider is absent the normalization code uses 'claude-code'.
    // Supply thresholdTokens so the normalization block is entered.
    const yaml = `
context:
  thresholdTokens: 40000
agentRunner:
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // 40000 / 200000 = 0.2
      expect(result.value.agentRunner.providers['claude-code']?.rotationThreshold).toBeCloseTo(0.2);
    }
  });

  it('injects default claude command when defaultProvider is claude-code and command is absent', () => {
    // When rawProviderConfig has no 'command' and defaultProvider === 'claude-code',
    // the normalization spreads { command: 'claude' } as a default.
    const yaml = `
context:
  thresholdTokens: 80000
agentRunner:
  providers:
    claude-code:
      enabled: true
      contextWindowTokens: 200000
`;
    const result = loadConfigFromString(yaml);
    // ProviderConfigSchema requires 'command', so if no default is injected this fails.
    // With the normalization default injection it should succeed.
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.agentRunner.providers['claude-code']?.command).toBe('claude');
    }
  });

  it('handles thresholdTokens when agentRunner.providers is not a record (falls back to empty providers)', () => {
    // agentRunner.providers being a non-record value makes isRecord() return false,
    // so normalizedProviders falls back to {}.  The defaultProvider entry is then absent
    // too (rawProviderConfig falls back to {}), and since defaultProvider is 'claude-code',
    // contextWindowTokens defaults to 200000 and the full provider entry is synthesised.
    const raw = {
      context: { thresholdTokens: 80000 },
      agentRunner: {
        defaultProvider: 'claude-code',
        providers: 'not-a-record',
      },
    };
    const result = validateConfig(raw);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // normalization must have synthesised the claude-code provider
      expect(result.value.agentRunner.providers['claude-code']?.command).toBe('claude');
      expect(result.value.agentRunner.providers['claude-code']?.rotationThreshold).toBeCloseTo(0.4);
    }
  });

  it('handles thresholdTokens when the defaultProvider key is missing from providers (falls back to empty rawProviderConfig)', () => {
    // providers is a record but the defaultProvider key ('claude-code') is absent.
    // rawProviderConfig falls back to {}.  contextWindowTokens defaults to 200000
    // for claude-code and the entry is synthesised from scratch.
    const raw = {
      context: { thresholdTokens: 100000 },
      agentRunner: {
        providers: {
          'other-provider': {
            enabled: true,
            command: '/other',
            contextWindowTokens: 150000,
            rotationThreshold: 0.5,
          },
        },
      },
    };
    const result = validateConfig(raw);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // claude-code provider synthesised by normalization
      const provider = result.value.agentRunner.providers['claude-code'];
      expect(provider?.command).toBe('claude');
      // 100000 / 200000 = 0.5
      expect(provider?.rotationThreshold).toBeCloseTo(0.5);
    }
  });

  it('substitutes an unset env var placeholder with an empty string', () => {
    // Exercises the `process.env[name] ?? ''` fallback on line 129.
    // Use a name that is guaranteed not to be set in the test environment.
    delete process.env['__TALON_TEST_UNSET_VAR__'];
    const yaml = `logLevel: \${__TALON_TEST_UNSET_VAR__}`;
    const result = loadConfigFromString(yaml);
    // logLevel: '' is not a valid enum value so validation fails, but the substitution
    // itself must not throw — we verify the error is a schema error, not a parse error.
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/validation failed/i);
    }
  });
});

// ---------------------------------------------------------------------------
// loadConfig (file-based)
// ---------------------------------------------------------------------------

describe('loadConfig', () => {
  it('returns Ok for a valid YAML file', () => {
    const path = writeTempConfig('logLevel: warn\n');
    const result = loadConfig(path);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('warn');
    }
  });

  it('returns Ok for an empty YAML file', () => {
    const path = writeTempConfig('');
    const result = loadConfig(path);
    expect(result.isOk()).toBe(true);
  });

  it('returns Err(ConfigError) when the file does not exist', () => {
    const result = loadConfig('/nonexistent/path/to/config.yaml');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/Failed to read config file/);
      expect(result.error.message).toMatch(/\/nonexistent\/path\/to\/config\.yaml/);
    }
  });

  it('returns Err(ConfigError) for invalid YAML in a file', () => {
    const path = writeTempConfig('key: [unclosed bracket');
    const result = loadConfig(path);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/Failed to parse YAML/);
    }
  });

  it('returns Err(ConfigError) for schema violations in a file', () => {
    const path = writeTempConfig('logLevel: not-a-valid-level\n');
    const result = loadConfig(path);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/logLevel/);
    }
  });

  it('includes the file path in the read error message', () => {
    const result = loadConfig('/does/not/exist.yaml');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toContain('/does/not/exist.yaml');
    }
  });
});

// ---------------------------------------------------------------------------
// Frozen output
// ---------------------------------------------------------------------------

describe('frozen config output', () => {
  it('loadConfigFromString returns a frozen config', () => {
    const result = loadConfigFromString('{}');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it('loadConfigFromString returns frozen nested objects', () => {
    const result = loadConfigFromString('{}');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value.storage)).toBe(true);
      expect(Object.isFrozen(result.value.sandbox)).toBe(true);
      expect(Object.isFrozen(result.value.ipc)).toBe(true);
      expect(Object.isFrozen(result.value.queue)).toBe(true);
      expect(Object.isFrozen(result.value.scheduler)).toBe(true);
    }
  });

  it('loadConfigFromString returns frozen arrays', () => {
    const result = loadConfigFromString('channels:\n  - type: telegram\n    name: main\n');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value.channels)).toBe(true);
      expect(Object.isFrozen(result.value.channels[0])).toBe(true);
    }
  });

  it('loadConfig (file) returns a frozen config', () => {
    const path = writeTempConfig('{}');
    const result = loadConfig(path);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it('mutating a frozen config throws in strict mode', () => {
    const result = loadConfigFromString('{}');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      // In strict mode (which vitest uses), assigning to a frozen object throws
      expect(() => {
        (result.value as Record<string, unknown>)['logLevel'] = 'debug';
      }).toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// auth.providers
// ---------------------------------------------------------------------------

describe('auth.providers schema', () => {
  it('defaults to an empty object when not specified', () => {
    const result = loadConfigFromString('');
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.auth.providers).toEqual({});
    }
  });

  it('parses provider credentials with apiKey and baseURL', () => {
    const yaml = `
auth:
  mode: api_key
  providers:
    openai:
      apiKey: sk-test-123
      baseURL: https://api.openai.com/v1
    anthropic:
      apiKey: sk-ant-456
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.auth.providers.openai.apiKey).toBe('sk-test-123');
      expect(result.value.auth.providers.openai.baseURL).toBe('https://api.openai.com/v1');
      expect(result.value.auth.providers.anthropic.apiKey).toBe('sk-ant-456');
      expect(result.value.auth.providers.anthropic.baseURL).toBeUndefined();
    }
  });

  it('allows providers with only baseURL (no apiKey)', () => {
    const yaml = `
auth:
  providers:
    local:
      baseURL: http://localhost:8080
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.auth.providers.local.baseURL).toBe('http://localhost:8080');
      expect(result.value.auth.providers.local.apiKey).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// persona.subagents
// ---------------------------------------------------------------------------

describe('persona.subagents schema', () => {
  it('defaults to an empty array when not specified', () => {
    const yaml = `
personas:
  - name: helper
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.personas[0].subagents).toEqual([]);
    }
  });

  it('parses subagent names from config', () => {
    const yaml = `
personas:
  - name: orchestrator
    subagents:
      - code-reviewer
      - test-runner
      - doc-writer
`;
    const result = loadConfigFromString(yaml);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.personas[0].subagents).toEqual([
        'code-reviewer',
        'test-runner',
        'doc-writer',
      ]);
    }
  });
});

// ---------------------------------------------------------------------------
// validateConfig
// ---------------------------------------------------------------------------

describe('validateConfig', () => {
  it('returns Ok for a valid plain object', () => {
    const result = validateConfig({ logLevel: 'error' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('error');
    }
  });

  it('returns Ok with defaults for an empty object', () => {
    const result = validateConfig({});
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.logLevel).toBe('info');
    }
  });

  it('returns Err(ConfigError) for invalid data', () => {
    const result = validateConfig({ logLevel: 'not-a-level' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
      expect(result.error.message).toMatch(/logLevel/);
    }
  });

  it('returns Err(ConfigError) for a non-object input', () => {
    const result = validateConfig('not an object');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(ConfigError);
    }
  });

  it('returns a frozen config', () => {
    const result = validateConfig({});
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(Object.isFrozen(result.value)).toBe(true);
    }
  });

  it('includes field path in validation error message', () => {
    const result = validateConfig({ ipc: { pollIntervalMs: 50 } });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/ipc\.pollIntervalMs/);
    }
  });

  it('truncates error message and appends "and N more" when more than 5 issues are present', () => {
    const raw = {
      logLevel: 'bad-level',
      sandbox: { maxConcurrent: 0, runtime: 'invalid-runtime' },
      ipc: { pollIntervalMs: 50 },
      queue: { maxAttempts: 0, concurrencyLimit: 0 },
    };
    const result = validateConfig(raw);
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toMatch(/and \d+ more/);
    }
  });
});
