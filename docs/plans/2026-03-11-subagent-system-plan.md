# Sub-Agent System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Route mechanical LLM tasks (memory grooming, file search, session summarization) to cheap models via a pluggable sub-agent system using the Vercel AI SDK.

**Architecture:** Sub-agents are folder-based plugins with a `subagent.yaml` manifest and `index.ts` entry point. The daemon loads them at startup, validates capability grants against personas, and executes them via a new `subagent_invoke` host tool. Sub-agents make single-turn Vercel AI SDK calls — no sessions, no Agent SDK.

**Tech Stack:** Vercel AI SDK (`ai`, `@ai-sdk/anthropic`, `@ai-sdk/openai`), Zod schemas, neverthrow Result types, vitest, pino logger.

**Design spec:** `docs/plans/2026-03-11-subagent-system-design.md`

---

## Phase 1: Foundation

### Task 1: Install Vercel AI SDK dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install packages**

Run: `npm install ai @ai-sdk/anthropic @ai-sdk/openai @ai-sdk/google ollama-ai-provider`

Expected: packages added to dependencies in package.json

**Step 2: Verify installation**

Run: `npx tsx -e "import { generateText } from 'ai'; console.log('ok')"`

Expected: prints "ok"

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: install Vercel AI SDK dependencies (ai, @ai-sdk/anthropic, @ai-sdk/openai, @ai-sdk/google, ollama-ai-provider)"
```

---

### Task 2: Extend auth config schema with provider credentials

The existing `AuthConfigSchema` in `config-schema.ts` only has `mode` and `apiKey`. We need to add a `providers` map so sub-agents can resolve API keys per provider.

**Files:**
- Modify: `src/core/config/config-schema.ts:120-123`
- Test: `tests/unit/core/config/config-loader.test.ts`

**Step 1: Write the failing test**

Add to the existing config-loader test file. Test that `auth.providers` parses correctly and defaults to `{}`:

```typescript
describe('auth.providers', () => {
  it('defaults to empty providers map', () => {
    const result = loadConfig(writeYaml({}));
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.auth.providers).toEqual({});
  });

  it('parses provider credentials', () => {
    const result = loadConfig(
      writeYaml({
        auth: {
          providers: {
            anthropic: { apiKey: 'sk-ant-test' },
            openai: { apiKey: 'sk-oai-test' },
          },
        },
      }),
    );
    expect(result.isOk()).toBe(true);
    const config = result._unsafeUnwrap();
    expect(config.auth.providers.anthropic.apiKey).toBe('sk-ant-test');
    expect(config.auth.providers.openai.apiKey).toBe('sk-oai-test');
  });

  it('substitutes env vars in provider apiKey', () => {
    process.env.TEST_ANTHROPIC_KEY = 'resolved-key';
    try {
      const result = loadConfig(
        writeYaml({
          auth: {
            providers: {
              anthropic: { apiKey: '${TEST_ANTHROPIC_KEY}' },
            },
          },
        }),
      );
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap().auth.providers.anthropic.apiKey).toBe('resolved-key');
    } finally {
      delete process.env.TEST_ANTHROPIC_KEY;
    }
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/config/config-loader.test.ts --reporter=verbose`

Expected: FAIL — `providers` not recognized by schema

**Step 3: Add provider auth schema**

In `src/core/config/config-schema.ts`, update the Auth section:

```typescript
// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

const ProviderAuthSchema = z.object({
  apiKey: z.string().optional(),
  baseURL: z.string().optional(),
});

export const AuthConfigSchema = z.object({
  mode: z.enum(['subscription', 'api_key']).default('subscription'),
  apiKey: z.string().optional(),
  providers: z.record(z.string(), ProviderAuthSchema).default({}),
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/config/config-loader.test.ts --reporter=verbose`

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/config/config-schema.ts tests/unit/core/config/config-loader.test.ts
git commit -m "feat(config): add auth.providers schema for sub-agent API keys"
```

---

### Task 3: Add `subagents` field to persona config schema

Personas must declare which sub-agents they can invoke.

**Files:**
- Modify: `src/core/config/config-schema.ts:66-74` (PersonaConfigSchema)
- Test: `tests/unit/core/config/config-loader.test.ts`

**Step 1: Write the failing test**

```typescript
describe('persona.subagents', () => {
  it('defaults to empty subagents array', () => {
    const result = loadConfig(
      writeYaml({
        personas: [{ name: 'bot', model: 'claude-haiku-4-5' }],
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().personas[0].subagents).toEqual([]);
  });

  it('parses subagent names', () => {
    const result = loadConfig(
      writeYaml({
        personas: [
          {
            name: 'bot',
            model: 'claude-haiku-4-5',
            subagents: ['memory-groomer', 'session-summarizer'],
          },
        ],
      }),
    );
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().personas[0].subagents).toEqual([
      'memory-groomer',
      'session-summarizer',
    ]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/core/config/config-loader.test.ts --reporter=verbose`

Expected: FAIL — `subagents` not on schema

**Step 3: Add subagents to PersonaConfigSchema**

In `src/core/config/config-schema.ts`, update PersonaConfigSchema:

```typescript
export const PersonaConfigSchema = z.object({
  name: z.string().min(1),
  model: z.string().default('claude-sonnet-4-6'),
  systemPromptFile: z.string().optional(),
  skills: z.array(z.string()).default([]),
  subagents: z.array(z.string()).default([]),
  capabilities: CapabilitiesSchema.default({}),
  mounts: z.array(MountConfigSchema).default([]),
  maxConcurrent: z.number().int().min(1).optional(),
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/core/config/config-loader.test.ts --reporter=verbose`

Expected: PASS

**Step 5: Commit**

```bash
git add src/core/config/config-schema.ts tests/unit/core/config/config-loader.test.ts
git commit -m "feat(config): add persona.subagents field for sub-agent assignment"
```

---

### Task 4: Define sub-agent types and manifest schema

Create the shared types and Zod schema for sub-agent manifests.

**Files:**
- Create: `src/subagents/subagent-types.ts`
- Create: `src/subagents/subagent-schema.ts`
- Test: `tests/unit/subagents/subagent-schema.test.ts`

**Step 1: Write the failing test**

Create the test file first:

```typescript
// tests/unit/subagents/subagent-schema.test.ts
import { describe, it, expect } from 'vitest';
import { SubAgentManifestSchema } from '../../../src/subagents/subagent-schema.js';

describe('SubAgentManifestSchema', () => {
  it('parses a minimal manifest', () => {
    const result = SubAgentManifestSchema.safeParse({
      name: 'test-agent',
      version: '0.1.0',
      description: 'A test sub-agent',
      model: {
        provider: 'anthropic',
        name: 'claude-haiku-4-5',
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiredCapabilities).toEqual([]);
      expect(result.data.rootPaths).toEqual([]);
      expect(result.data.timeoutMs).toBe(30000);
      expect(result.data.model.maxTokens).toBe(2048);
    }
  });

  it('parses a full manifest with all optional fields', () => {
    const result = SubAgentManifestSchema.safeParse({
      name: 'memory-groomer',
      version: '0.1.0',
      description: 'Grooms memory entries',
      model: {
        provider: 'anthropic',
        name: 'claude-haiku-4-5',
        maxTokens: 4096,
      },
      requiredCapabilities: ['memory.read:thread', 'memory.write:thread'],
      rootPaths: ['/home/talon/notes'],
      timeoutMs: 60000,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiredCapabilities).toEqual([
        'memory.read:thread',
        'memory.write:thread',
      ]);
      expect(result.data.rootPaths).toEqual(['/home/talon/notes']);
      expect(result.data.timeoutMs).toBe(60000);
      expect(result.data.model.maxTokens).toBe(4096);
    }
  });

  it('rejects manifest missing required fields', () => {
    const result = SubAgentManifestSchema.safeParse({
      name: 'bad',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = SubAgentManifestSchema.safeParse({
      name: '',
      version: '0.1.0',
      description: 'test',
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
    });
    expect(result.success).toBe(false);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/subagents/subagent-schema.test.ts --reporter=verbose`

Expected: FAIL — module not found

**Step 3: Create the types file**

```typescript
// src/subagents/subagent-types.ts
/**
 * Core type definitions for the Talon sub-agent system.
 *
 * Sub-agents are lightweight, stateless LLM tasks that use the Vercel AI
 * SDK instead of the full Agent SDK. They live in self-contained directories
 * with a manifest (subagent.yaml) and entry point (index.ts).
 */

import type { LanguageModel } from 'ai';
import type pino from 'pino';
import type { MemoryRepository } from '../core/database/repositories/memory-repository.js';
import type { ScheduleRepository } from '../core/database/repositories/schedule-repository.js';
import type { PersonaRepository } from '../core/database/repositories/persona-repository.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import type { ThreadRepository } from '../core/database/repositories/thread-repository.js';
import type { MessageRepository } from '../core/database/repositories/message-repository.js';
import type { RunRepository } from '../core/database/repositories/run-repository.js';
import type { QueueRepository } from '../core/database/repositories/queue-repository.js';

// ---------------------------------------------------------------------------
// Sub-agent manifest (parsed from subagent.yaml)
// ---------------------------------------------------------------------------

export interface SubAgentManifest {
  name: string;
  version: string;
  description: string;
  model: {
    provider: string;
    name: string;
    maxTokens: number;
  };
  requiredCapabilities: string[];
  rootPaths: string[];
  timeoutMs: number;
}

// ---------------------------------------------------------------------------
// Sub-agent context (passed to run function)
// ---------------------------------------------------------------------------

/** Services available to sub-agents, gated by requiredCapabilities. */
export interface SubAgentServices {
  memory: MemoryRepository;
  schedules: ScheduleRepository;
  personas: PersonaRepository;
  channels: ChannelRepository;
  threads: ThreadRepository;
  messages: MessageRepository;
  runs: RunRepository;
  queue: QueueRepository;
  logger: pino.Logger;
}

/** Runtime context passed to every sub-agent invocation. */
export interface SubAgentContext {
  threadId: string;
  personaId: string;
  systemPrompt: string;
  model: LanguageModel;
  services: SubAgentServices;
}

// ---------------------------------------------------------------------------
// Sub-agent input / output
// ---------------------------------------------------------------------------

/** Task-specific input (defined per sub-agent). */
export interface SubAgentInput {
  [key: string]: unknown;
}

/** Structured result returned by every sub-agent. */
export interface SubAgentResult {
  success: boolean;
  summary: string;
  data?: Record<string, unknown>;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  };
}

/** The function every sub-agent must export as default or named `run`. */
export type SubAgentRunFn = (
  ctx: SubAgentContext,
  input: SubAgentInput,
) => Promise<SubAgentResult>;

// ---------------------------------------------------------------------------
// Loaded sub-agent (after loader reads directory)
// ---------------------------------------------------------------------------

/** A sub-agent after its manifest and entry point have been loaded. */
export interface LoadedSubAgent {
  manifest: SubAgentManifest;
  promptContents: string[];
  run: SubAgentRunFn;
  /** Absolute path to the sub-agent directory. */
  rootDir: string;
}
```

**Step 4: Create the schema file**

```typescript
// src/subagents/subagent-schema.ts
/**
 * Zod schema for sub-agent manifest files (subagent.yaml).
 */

import { z } from 'zod';

export const SubAgentModelSchema = z.object({
  provider: z.string().min(1),
  name: z.string().min(1),
  maxTokens: z.number().int().min(1).default(2048),
});

export const SubAgentManifestSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string().min(1),
  model: SubAgentModelSchema,
  requiredCapabilities: z.array(z.string()).default([]),
  rootPaths: z.array(z.string()).default([]),
  timeoutMs: z.number().int().min(1000).default(30000),
});
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/subagents/subagent-schema.test.ts --reporter=verbose`

Expected: PASS

**Step 6: Commit**

```bash
git add src/subagents/subagent-types.ts src/subagents/subagent-schema.ts tests/unit/subagents/subagent-schema.test.ts
git commit -m "feat(subagents): define types, interfaces, and manifest schema"
```

---

### Task 5: Build the sub-agent loader

Reads sub-agent directories, parses manifests, loads prompt fragments, and dynamically imports the `run` function from `index.ts`.

**Files:**
- Create: `src/subagents/subagent-loader.ts`
- Test: `tests/unit/subagents/subagent-loader.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/subagents/subagent-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SubAgentLoader } from '../../../src/subagents/subagent-loader.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `subagent-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  // Write as JSON since we can import js-yaml, but the loader reads YAML.
  // Actually write YAML-compatible content.
  const yaml = Object.entries(manifest)
    .map(([k, v]) => {
      if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
        const inner = Object.entries(v as Record<string, unknown>)
          .map(([ik, iv]) => `  ${ik}: ${JSON.stringify(iv)}`)
          .join('\n');
        return `${k}:\n${inner}`;
      }
      if (Array.isArray(v)) {
        if (v.length === 0) return `${k}: []`;
        return `${k}:\n${v.map((i) => `  - ${JSON.stringify(i)}`).join('\n')}`;
      }
      return `${k}: ${JSON.stringify(v)}`;
    })
    .join('\n');
  writeFileSync(join(dir, 'subagent.yaml'), yaml);
}

function writeEntryPoint(dir: string): void {
  writeFileSync(
    join(dir, 'index.js'),
    `export async function run(ctx, input) {
      return { success: true, summary: 'test', data: {} };
    }`,
  );
}

const makeLogger = () =>
  ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    child: function () { return this; },
  }) as any;

describe('SubAgentLoader', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads a valid sub-agent directory', async () => {
    const agentDir = join(root, 'test-agent');
    mkdirSync(agentDir, { recursive: true });
    writeManifest(agentDir, {
      name: 'test-agent',
      version: '0.1.0',
      description: 'A test sub-agent',
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
    });
    writeEntryPoint(agentDir);

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    const agents = result._unsafeUnwrap();
    expect(agents).toHaveLength(1);
    expect(agents[0].manifest.name).toBe('test-agent');
    expect(typeof agents[0].run).toBe('function');
  });

  it('loads prompt fragments from prompts/ directory', async () => {
    const agentDir = join(root, 'test-agent');
    const promptsDir = join(agentDir, 'prompts');
    mkdirSync(promptsDir, { recursive: true });
    writeManifest(agentDir, {
      name: 'test-agent',
      version: '0.1.0',
      description: 'A test sub-agent',
      model: { provider: 'anthropic', name: 'claude-haiku-4-5' },
    });
    writeEntryPoint(agentDir);
    writeFileSync(join(promptsDir, '01-intro.md'), 'You are a helper.');
    writeFileSync(join(promptsDir, '02-rules.md'), 'Be concise.');

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    const agents = result._unsafeUnwrap();
    expect(agents[0].promptContents).toEqual(['You are a helper.', 'Be concise.']);
  });

  it('skips directories without subagent.yaml', async () => {
    mkdirSync(join(root, 'not-an-agent'), { recursive: true });
    writeFileSync(join(root, 'not-an-agent', 'readme.md'), 'nothing here');

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('returns error for invalid manifest', async () => {
    const agentDir = join(root, 'bad-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(agentDir, 'subagent.yaml'), 'name: ""');

    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll(root);

    // Should succeed but skip the invalid agent (warning logged)
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('returns empty array when root does not exist', async () => {
    const loader = new SubAgentLoader(makeLogger());
    const result = await loader.loadAll('/tmp/nonexistent-subagents-dir');

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toEqual([]);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/subagents/subagent-loader.test.ts --reporter=verbose`

Expected: FAIL — module not found

**Step 3: Implement the loader**

```typescript
// src/subagents/subagent-loader.ts
/**
 * SubAgentLoader — reads sub-agent directories and produces LoadedSubAgent objects.
 *
 * Each sub-agent directory must contain:
 *   subagent.yaml  — manifest (required)
 *   index.ts/.js   — entry point exporting a `run` function (required)
 *   prompts/*.md   — prompt fragments (optional, sorted alphabetically)
 *
 * Similar pattern to SkillLoader but simpler — no tool manifests or MCP defs.
 */

import { readFile, readdir, access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import yaml from 'js-yaml';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import { SubAgentManifestSchema } from './subagent-schema.js';
import type { LoadedSubAgent, SubAgentRunFn } from './subagent-types.js';
import { SkillError } from '../core/errors/index.js';

export class SubAgentLoader {
  constructor(private readonly logger: pino.Logger) {}

  /**
   * Loads all sub-agents from the given root directory.
   *
   * Scans each subdirectory for a `subagent.yaml` manifest. Directories
   * without a manifest are silently skipped. Invalid manifests log a
   * warning and are skipped.
   *
   * Returns an empty array (not an error) if the root directory does
   * not exist — this allows the feature to be entirely optional.
   */
  async loadAll(rootDir: string): Promise<Result<LoadedSubAgent[], SkillError>> {
    // If the subagents directory doesn't exist, return empty (feature is optional).
    try {
      await access(rootDir, fsConstants.R_OK);
    } catch {
      this.logger.debug({ rootDir }, 'subagent-loader: directory not found, skipping');
      return ok([]);
    }

    const entries = await readdir(rootDir, { withFileTypes: true });
    const agents: LoadedSubAgent[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const agentDir = join(rootDir, entry.name);
      const manifestPath = join(agentDir, 'subagent.yaml');

      // Skip directories without a manifest.
      try {
        await access(manifestPath, fsConstants.R_OK);
      } catch {
        continue;
      }

      const result = await this.loadOne(agentDir, manifestPath);
      if (result.isOk()) {
        agents.push(result.value);
      } else {
        this.logger.warn(
          { agentDir, error: result.error.message },
          'subagent-loader: skipping invalid sub-agent',
        );
      }
    }

    return ok(agents);
  }

  private async loadOne(
    agentDir: string,
    manifestPath: string,
  ): Promise<Result<LoadedSubAgent, SkillError>> {
    // Parse manifest.
    const raw = await readFile(manifestPath, 'utf-8');
    const parsed = yaml.load(raw);
    const validated = SubAgentManifestSchema.safeParse(parsed);

    if (!validated.success) {
      return err(
        new SkillError(
          `Invalid subagent.yaml in ${agentDir}: ${validated.error.message}`,
        ),
      );
    }

    const manifest = validated.data;

    // Load entry point.
    const runFn = await this.loadEntryPoint(agentDir);
    if (runFn === null) {
      return err(
        new SkillError(`No index.js or index.ts found in ${agentDir}`),
      );
    }

    // Load prompt fragments.
    const promptContents = await this.loadPrompts(agentDir);

    return ok({
      manifest,
      promptContents,
      run: runFn,
      rootDir: agentDir,
    });
  }

  private async loadEntryPoint(agentDir: string): Promise<SubAgentRunFn | null> {
    // Try .js first (compiled), then .ts (dev mode with tsx).
    for (const ext of ['js', 'ts']) {
      const entryPath = join(agentDir, `index.${ext}`);
      try {
        await access(entryPath, fsConstants.R_OK);
        const mod = await import(pathToFileURL(entryPath).href);
        if (typeof mod.run === 'function') {
          return mod.run as SubAgentRunFn;
        }
        if (typeof mod.default === 'function') {
          return mod.default as SubAgentRunFn;
        }
        return null;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async loadPrompts(agentDir: string): Promise<string[]> {
    const promptsDir = join(agentDir, 'prompts');
    try {
      await access(promptsDir, fsConstants.R_OK);
    } catch {
      return [];
    }

    const files = await readdir(promptsDir);
    const mdFiles = files.filter((f) => f.endsWith('.md')).sort();

    const contents: string[] = [];
    for (const file of mdFiles) {
      const content = await readFile(join(promptsDir, file), 'utf-8');
      contents.push(content);
    }

    return contents;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/subagents/subagent-loader.test.ts --reporter=verbose`

Expected: PASS

**Step 5: Commit**

```bash
git add src/subagents/subagent-loader.ts tests/unit/subagents/subagent-loader.test.ts
git commit -m "feat(subagents): implement sub-agent loader with manifest parsing and prompt discovery"
```

---

### Task 6: Build the model resolver (Vercel AI SDK provider factory)

Resolves a `{ provider, name }` pair from a sub-agent manifest into a Vercel AI SDK `LanguageModel` using API keys from `auth.providers` config.

**Files:**
- Create: `src/subagents/model-resolver.ts`
- Test: `tests/unit/subagents/model-resolver.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/subagents/model-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { ModelResolver } from '../../../src/subagents/model-resolver.js';

describe('ModelResolver', () => {
  it('resolves an anthropic model', () => {
    const resolver = new ModelResolver({
      anthropic: { apiKey: 'sk-ant-test' },
    });
    const result = resolver.resolve({ provider: 'anthropic', name: 'claude-haiku-4-5', maxTokens: 2048 });
    expect(result.isOk()).toBe(true);
    // We can't easily inspect the LanguageModel internals, but we can verify it's truthy.
    expect(result._unsafeUnwrap()).toBeTruthy();
  });

  it('resolves an openai model', () => {
    const resolver = new ModelResolver({
      openai: { apiKey: 'sk-oai-test' },
    });
    const result = resolver.resolve({ provider: 'openai', name: 'gpt-4o-mini', maxTokens: 2048 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeTruthy();
  });

  it('resolves a google model', () => {
    const resolver = new ModelResolver({
      google: { apiKey: 'google-test' },
    });
    const result = resolver.resolve({ provider: 'google', name: 'gemini-2.0-flash', maxTokens: 2048 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeTruthy();
  });

  it('resolves an ollama model (no apiKey needed)', () => {
    const resolver = new ModelResolver({
      ollama: { baseURL: 'http://localhost:11434/api' },
    });
    const result = resolver.resolve({ provider: 'ollama', name: 'llama3', maxTokens: 2048 });
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toBeTruthy();
  });

  it('returns error for unknown provider', () => {
    const resolver = new ModelResolver({});
    const result = resolver.resolve({ provider: 'unknown', name: 'model', maxTokens: 2048 });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('unknown');
  });

  it('returns error when provider has no credentials', () => {
    const resolver = new ModelResolver({});
    const result = resolver.resolve({ provider: 'anthropic', name: 'claude-haiku-4-5', maxTokens: 2048 });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('credentials');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/subagents/model-resolver.test.ts --reporter=verbose`

Expected: FAIL — module not found

**Step 3: Implement the model resolver**

```typescript
// src/subagents/model-resolver.ts
/**
 * ModelResolver — resolves sub-agent model config into Vercel AI SDK LanguageModel instances.
 *
 * Uses provider credentials from talond.yaml auth.providers to create
 * provider-specific model instances.
 */

import type { LanguageModel } from 'ai';
import { ok, err, type Result } from 'neverthrow';
import { ConfigError } from '../core/errors/index.js';

/** Provider credentials from auth.providers config. */
interface ProviderCredentials {
  apiKey?: string;
  baseURL?: string;
}

/** Model config from sub-agent manifest. */
interface ModelConfig {
  provider: string;
  name: string;
  maxTokens: number;
}

/** Supported provider factory map. */
type ProviderFactory = (apiKey: string, modelName: string) => LanguageModel;

export class ModelResolver {
  private readonly providers: Record<string, ProviderCredentials>;

  constructor(providers: Record<string, ProviderCredentials>) {
    this.providers = providers;
  }

  /**
   * Resolves a model config into a Vercel AI SDK LanguageModel.
   *
   * Looks up credentials by provider name, then creates the appropriate
   * SDK model instance.
   */
  resolve(config: ModelConfig): Result<LanguageModel, ConfigError> {
    const creds = this.providers[config.provider];
    if (!creds) {
      return err(
        new ConfigError(
          `No credentials for provider "${config.provider}". Add auth.providers.${config.provider}.apiKey to talond.yaml`,
        ),
      );
    }

    const factory = this.getFactory(config.provider);
    if (!factory) {
      return err(
        new ConfigError(
          `Unsupported model provider: "${config.provider}". Supported: anthropic, openai, google, ollama`,
        ),
      );
    }

    try {
      const model = factory(creds.apiKey, config.name);
      return ok(model);
    } catch (error) {
      return err(
        new ConfigError(
          `Failed to create model for ${config.provider}/${config.name}: ${(error as Error).message}`,
        ),
      );
    }
  }

  private getFactory(provider: string): ProviderFactory | null {
    switch (provider) {
      case 'anthropic':
        return (apiKey, modelName) => {
          const { createAnthropic } = require('@ai-sdk/anthropic');
          return createAnthropic({ apiKey })(modelName);
        };
      case 'openai':
        return (apiKey, modelName) => {
          const { createOpenAI } = require('@ai-sdk/openai');
          return createOpenAI({ apiKey })(modelName);
        };
      case 'google':
        return (apiKey, modelName) => {
          const { createGoogleGenerativeAI } = require('@ai-sdk/google');
          return createGoogleGenerativeAI({ apiKey })(modelName);
        };
      case 'ollama':
        return (_apiKey, modelName) => {
          const { ollama } = require('ollama-ai-provider');
          return ollama(modelName);
        };
      default:
        return null;
    }
  }
}
```

> **Note:** The `require()` calls should actually be dynamic `await import()` calls in ESM. However, since `resolve()` is synchronous for simplicity and the factory pattern is straightforward, we use a synchronous approach. If the test environment has issues with this, refactor `resolve()` to be async. See Step 4.

**Step 3b: If ESM issues — make resolve async instead:**

```typescript
  async resolve(config: ModelConfig): Promise<Result<LanguageModel, ConfigError>> {
    // ... same validation ...
    try {
      const model = await this.createModel(config.provider, creds.apiKey, config.name);
      return ok(model);
    } catch (error) {
      return err(new ConfigError(`Failed to create model: ${(error as Error).message}`));
    }
  }

  private async createModel(provider: string, creds: ProviderCredentials, modelName: string): Promise<LanguageModel> {
    switch (provider) {
      case 'anthropic': {
        const { createAnthropic } = await import('@ai-sdk/anthropic');
        return createAnthropic({ apiKey: creds.apiKey! })(modelName);
      }
      case 'openai': {
        const { createOpenAI } = await import('@ai-sdk/openai');
        return createOpenAI({ apiKey: creds.apiKey! })(modelName);
      }
      case 'google': {
        const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
        return createGoogleGenerativeAI({ apiKey: creds.apiKey! })(modelName);
      }
      case 'ollama': {
        const { ollama } = await import('ollama-ai-provider');
        return ollama(modelName);
      }
      default:
        throw new Error(`Unsupported provider: ${provider}`);
    }
  }
```

Update tests to use `await` on `resolve()` if you go with the async version.

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/subagents/model-resolver.test.ts --reporter=verbose`

Expected: PASS

**Step 5: Commit**

```bash
git add src/subagents/model-resolver.ts tests/unit/subagents/model-resolver.test.ts
git commit -m "feat(subagents): implement model resolver for Vercel AI SDK providers"
```

---

### Task 7: Build the sub-agent runner

The core orchestrator: validates capabilities, resolves the model, merges prompts, calls the sub-agent's `run()` function with a timeout.

**Files:**
- Create: `src/subagents/subagent-runner.ts`
- Test: `tests/unit/subagents/subagent-runner.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/subagents/subagent-runner.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SubAgentRunner } from '../../../src/subagents/subagent-runner.js';
import type { LoadedSubAgent, SubAgentServices } from '../../../src/subagents/subagent-types.js';
import type { ResolvedCapabilities } from '../../../src/personas/persona-types.js';
import { ok } from 'neverthrow';

const makeLogger = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as any;

const makeServices = (): SubAgentServices =>
  ({
    memory: {} as any,
    schedules: {} as any,
    personas: {} as any,
    channels: {} as any,
    threads: {} as any,
    messages: {} as any,
    runs: {} as any,
    queue: {} as any,
    logger: makeLogger(),
  });

function makeAgent(overrides?: Partial<LoadedSubAgent>): LoadedSubAgent {
  return {
    manifest: {
      name: 'test-agent',
      version: '0.1.0',
      description: 'Test',
      model: { provider: 'anthropic', name: 'claude-haiku-4-5', maxTokens: 2048 },
      requiredCapabilities: [],
      rootPaths: [],
      timeoutMs: 5000,
    },
    promptContents: ['You are a test agent.'],
    run: vi.fn().mockResolvedValue({ success: true, summary: 'Done', data: {} }),
    rootDir: '/tmp/test-agent',
    ...overrides,
  };
}

describe('SubAgentRunner', () => {
  it('executes a sub-agent and returns its result', async () => {
    const agent = makeAgent();
    const modelResolver = {
      resolve: vi.fn().mockReturnValue(ok({} as any)),
    };
    const runner = new SubAgentRunner({
      agents: new Map([['test-agent', agent]]),
      modelResolver: modelResolver as any,
      services: makeServices(),
      logger: makeLogger(),
    });

    const caps: ResolvedCapabilities = { allow: [], requireApproval: [] };
    const result = await runner.execute('test-agent', { query: 'test' }, {
      threadId: 'thread-1',
      personaId: 'persona-1',
      personaSubagents: ['test-agent'],
      personaCapabilities: caps,
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().success).toBe(true);
    expect(result._unsafeUnwrap().summary).toBe('Done');
    expect(agent.run).toHaveBeenCalledOnce();
  });

  it('rejects unknown sub-agent name', async () => {
    const runner = new SubAgentRunner({
      agents: new Map(),
      modelResolver: { resolve: vi.fn() } as any,
      services: makeServices(),
      logger: makeLogger(),
    });

    const result = await runner.execute('nonexistent', {}, {
      threadId: 'thread-1',
      personaId: 'persona-1',
      personaSubagents: ['nonexistent'],
      personaCapabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('not found');
  });

  it('rejects sub-agent not in persona assignment', async () => {
    const agent = makeAgent();
    const runner = new SubAgentRunner({
      agents: new Map([['test-agent', agent]]),
      modelResolver: { resolve: vi.fn() } as any,
      services: makeServices(),
      logger: makeLogger(),
    });

    const result = await runner.execute('test-agent', {}, {
      threadId: 'thread-1',
      personaId: 'persona-1',
      personaSubagents: [],  // NOT assigned
      personaCapabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('not assigned');
  });

  it('rejects sub-agent with unsatisfied capabilities', async () => {
    const agent = makeAgent({
      manifest: {
        name: 'restricted-agent',
        version: '0.1.0',
        description: 'Test',
        model: { provider: 'anthropic', name: 'claude-haiku-4-5', maxTokens: 2048 },
        requiredCapabilities: ['memory.read:thread', 'memory.write:thread'],
        rootPaths: [],
        timeoutMs: 5000,
      },
    });
    const runner = new SubAgentRunner({
      agents: new Map([['restricted-agent', agent]]),
      modelResolver: { resolve: vi.fn() } as any,
      services: makeServices(),
      logger: makeLogger(),
    });

    const result = await runner.execute('restricted-agent', {}, {
      threadId: 'thread-1',
      personaId: 'persona-1',
      personaSubagents: ['restricted-agent'],
      personaCapabilities: { allow: ['memory.read:thread'], requireApproval: [] },
      // Missing memory.write:thread
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('missing capabilities');
  });

  it('respects timeout on slow sub-agents', async () => {
    const slowRun = vi.fn().mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve({ success: true, summary: 'slow' }), 10000)),
    );
    const agent = makeAgent({
      manifest: {
        name: 'slow-agent',
        version: '0.1.0',
        description: 'Slow',
        model: { provider: 'anthropic', name: 'claude-haiku-4-5', maxTokens: 2048 },
        requiredCapabilities: [],
        rootPaths: [],
        timeoutMs: 100,  // very short timeout
      },
      run: slowRun,
    });
    const modelResolver = {
      resolve: vi.fn().mockReturnValue(ok({} as any)),
    };
    const runner = new SubAgentRunner({
      agents: new Map([['slow-agent', agent]]),
      modelResolver: modelResolver as any,
      services: makeServices(),
      logger: makeLogger(),
    });

    const result = await runner.execute('slow-agent', {}, {
      threadId: 'thread-1',
      personaId: 'persona-1',
      personaSubagents: ['slow-agent'],
      personaCapabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().message).toContain('timed out');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/subagents/subagent-runner.test.ts --reporter=verbose`

Expected: FAIL — module not found

**Step 3: Implement the runner**

```typescript
// src/subagents/subagent-runner.ts
/**
 * SubAgentRunner — executes sub-agent invocations with capability validation,
 * model resolution, and timeout enforcement.
 *
 * This is the daemon-side counterpart to the `subagent_invoke` host tool.
 * It receives requests from the bridge, validates access, resolves the
 * model, and calls the sub-agent's `run()` function.
 */

import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import type { LoadedSubAgent, SubAgentInput, SubAgentResult, SubAgentServices } from './subagent-types.js';
import type { ModelResolver } from './model-resolver.js';
import type { ResolvedCapabilities } from '../personas/persona-types.js';
import { ToolError } from '../core/errors/index.js';
import { extractCapabilityPrefix } from '../tools/tool-filter.js';

/** Context for a sub-agent invocation. */
export interface SubAgentInvokeContext {
  threadId: string;
  personaId: string;
  personaSubagents: string[];
  personaCapabilities: ResolvedCapabilities;
}

interface SubAgentRunnerDeps {
  agents: Map<string, LoadedSubAgent>;
  modelResolver: ModelResolver;
  services: SubAgentServices;
  logger: pino.Logger;
}

export class SubAgentRunner {
  private readonly agents: Map<string, LoadedSubAgent>;
  private readonly modelResolver: ModelResolver;
  private readonly services: SubAgentServices;
  private readonly logger: pino.Logger;

  constructor(deps: SubAgentRunnerDeps) {
    this.agents = deps.agents;
    this.modelResolver = deps.modelResolver;
    this.services = deps.services;
    this.logger = deps.logger;
  }

  /**
   * Executes a sub-agent by name.
   *
   * Validates:
   * 1. Sub-agent exists (was loaded)
   * 2. Sub-agent is in persona's `subagents` list
   * 3. Persona capabilities satisfy sub-agent's `requiredCapabilities`
   * 4. Model can be resolved from auth config
   *
   * Runs the sub-agent with a timeout from its manifest.
   */
  async execute(
    name: string,
    input: SubAgentInput,
    ctx: SubAgentInvokeContext,
  ): Promise<Result<SubAgentResult, ToolError>> {
    // 1. Find the loaded sub-agent.
    const agent = this.agents.get(name);
    if (!agent) {
      return err(new ToolError(`Sub-agent "${name}" not found`));
    }

    // 2. Check persona assignment.
    if (!ctx.personaSubagents.includes(name)) {
      return err(
        new ToolError(`Sub-agent "${name}" is not assigned to this persona`),
      );
    }

    // 3. Check required capabilities.
    const missing = this.findMissingCapabilities(
      agent.manifest.requiredCapabilities,
      ctx.personaCapabilities,
    );
    if (missing.length > 0) {
      return err(
        new ToolError(
          `Sub-agent "${name}" has missing capabilities: ${missing.join(', ')}`,
        ),
      );
    }

    // 4. Resolve model.
    const modelResult = await this.modelResolver.resolve(agent.manifest.model);
    if (modelResult.isErr()) {
      return err(new ToolError(`Model resolution failed: ${modelResult.error.message}`));
    }

    // 5. Build system prompt from prompt fragments.
    const systemPrompt = agent.promptContents.join('\n\n');

    // 6. Execute with timeout.
    this.logger.info(
      { subagent: name, threadId: ctx.threadId, personaId: ctx.personaId },
      'subagent-runner: executing',
    );

    try {
      const result = await this.runWithTimeout(
        agent.run,
        {
          threadId: ctx.threadId,
          personaId: ctx.personaId,
          systemPrompt,
          model: modelResult.value,
          services: this.services,
        },
        input,
        agent.manifest.timeoutMs,
      );

      this.logger.info(
        { subagent: name, success: result.success, usage: result.usage },
        'subagent-runner: completed',
      );

      return ok(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ subagent: name, error: message }, 'subagent-runner: failed');
      return err(new ToolError(`Sub-agent "${name}" failed: ${message}`));
    }
  }

  private findMissingCapabilities(
    required: string[],
    granted: ResolvedCapabilities,
  ): string[] {
    const allGranted = [...granted.allow, ...granted.requireApproval];
    const grantedPrefixes = new Set(
      allGranted.map((label) => extractCapabilityPrefix(label)).filter(Boolean),
    );

    return required.filter((req) => {
      const prefix = extractCapabilityPrefix(req);
      return prefix === null || !grantedPrefixes.has(prefix);
    });
  }

  private async runWithTimeout(
    runFn: LoadedSubAgent['run'],
    ctx: Parameters<LoadedSubAgent['run']>[0],
    input: SubAgentInput,
    timeoutMs: number,
  ): Promise<SubAgentResult> {
    let timeoutId: ReturnType<typeof setTimeout>;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Sub-agent timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    try {
      return await Promise.race([runFn(ctx, input), timeoutPromise]);
    } finally {
      clearTimeout(timeoutId!);
    }
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/subagents/subagent-runner.test.ts --reporter=verbose`

Expected: PASS (5 tests)

**Step 5: Commit**

```bash
git add src/subagents/subagent-runner.ts tests/unit/subagents/subagent-runner.test.ts
git commit -m "feat(subagents): implement sub-agent runner with capability validation and timeout"
```

---

### Task 8: Register `subagent_invoke` in the host tools system

Add the new tool to the tool registry, implement the handler, and wire it into the bridge dispatcher.

**Files:**
- Create: `src/tools/host-tools/subagent-invoke.ts`
- Modify: `src/tools/tool-filter.ts:39-45` (add registry entry)
- Modify: `src/tools/host-tools-bridge.ts` (add handler + dispatch case)
- Test: `tests/unit/tools/subagent-invoke.test.ts`

**Step 1: Write the failing test**

```typescript
// tests/unit/tools/subagent-invoke.test.ts
import { describe, it, expect, vi } from 'vitest';
import { SubAgentInvokeHandler } from '../../../src/tools/host-tools/subagent-invoke.js';
import { ok, err } from 'neverthrow';
import { ToolError } from '../../../src/core/errors/index.js';

const makeLogger = () =>
  ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  }) as any;

describe('SubAgentInvokeHandler', () => {
  it('has correct manifest', () => {
    expect(SubAgentInvokeHandler.manifest.name).toBe('subagent.invoke');
    expect(SubAgentInvokeHandler.manifest.capabilities).toContain('subagent.invoke');
  });

  it('delegates to runner and returns success result', async () => {
    const mockRunner = {
      execute: vi.fn().mockResolvedValue(
        ok({ success: true, summary: 'Done', data: { key: 'value' } }),
      ),
    };
    const mockPersonaLoader = {
      getByName: vi.fn().mockReturnValue(
        ok({
          config: { subagents: ['test-agent'] },
          resolvedCapabilities: { allow: ['subagent.invoke'], requireApproval: [] },
        }),
      ),
    };
    const mockPersonaRepo = {
      findById: vi.fn().mockReturnValue(ok({ name: 'bot' })),
    };

    const handler = new SubAgentInvokeHandler({
      runner: mockRunner as any,
      personaLoader: mockPersonaLoader as any,
      personaRepository: mockPersonaRepo as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { name: 'test-agent', input: { query: 'hello' } },
      { runId: 'r1', threadId: 't1', personaId: 'p1' },
    );

    expect(result.status).toBe('success');
    expect(result.result).toEqual({ success: true, summary: 'Done', data: { key: 'value' } });
  });

  it('returns error when runner rejects', async () => {
    const mockRunner = {
      execute: vi.fn().mockResolvedValue(
        err(new ToolError('Sub-agent "x" not found')),
      ),
    };
    const mockPersonaLoader = {
      getByName: vi.fn().mockReturnValue(
        ok({
          config: { subagents: ['x'] },
          resolvedCapabilities: { allow: ['subagent.invoke'], requireApproval: [] },
        }),
      ),
    };
    const mockPersonaRepo = {
      findById: vi.fn().mockReturnValue(ok({ name: 'bot' })),
    };

    const handler = new SubAgentInvokeHandler({
      runner: mockRunner as any,
      personaLoader: mockPersonaLoader as any,
      personaRepository: mockPersonaRepo as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { name: 'x', input: {} },
      { runId: 'r1', threadId: 't1', personaId: 'p1' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('not found');
  });

  it('returns error when name is missing', async () => {
    const handler = new SubAgentInvokeHandler({
      runner: { execute: vi.fn() } as any,
      personaLoader: { getByName: vi.fn() } as any,
      personaRepository: { findById: vi.fn() } as any,
      logger: makeLogger(),
    });

    const result = await handler.execute(
      { input: {} } as any,
      { runId: 'r1', threadId: 't1', personaId: 'p1' },
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('name');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/tools/subagent-invoke.test.ts --reporter=verbose`

Expected: FAIL — module not found

**Step 3: Implement the handler**

```typescript
// src/tools/host-tools/subagent-invoke.ts
/**
 * Host-side tool: subagent.invoke
 *
 * Delegates a task to a named sub-agent. Resolves the persona's sub-agent
 * assignments and capabilities, then passes execution to the SubAgentRunner.
 *
 * Gated by `subagent.invoke` capability.
 */

import type pino from 'pino';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ToolExecutionContext } from './channel-send.js';
import type { SubAgentRunner } from '../../subagents/subagent-runner.js';
import type { PersonaLoader } from '../../personas/persona-loader.js';
import type { PersonaRepository } from '../../core/database/repositories/persona-repository.js';

/** Arguments accepted by the subagent.invoke tool. */
export interface SubAgentInvokeArgs {
  /** Name of the sub-agent to invoke. */
  name: string;
  /** Task-specific input for the sub-agent. */
  input?: Record<string, unknown>;
}

export class SubAgentInvokeHandler {
  static readonly manifest: ToolManifest = {
    name: 'subagent.invoke',
    description:
      'Delegates a task to a specialized sub-agent. The sub-agent runs a single-turn LLM call with a cheap model and returns structured results.',
    capabilities: ['subagent.invoke'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      runner: SubAgentRunner;
      personaLoader: PersonaLoader;
      personaRepository: PersonaRepository;
      logger: pino.Logger;
    },
  ) {}

  async execute(
    args: SubAgentInvokeArgs,
    context: ToolExecutionContext,
  ): Promise<ToolCallResult> {
    const requestId = context.requestId ?? 'unknown';

    if (!args.name || typeof args.name !== 'string') {
      return {
        requestId,
        tool: 'subagent.invoke',
        status: 'error',
        error: 'Missing required field: name',
      };
    }

    // Resolve persona to get subagent assignments and capabilities.
    const personaRowResult = this.deps.personaRepository.findById(context.personaId);
    if (personaRowResult.isErr() || personaRowResult.value === null) {
      return {
        requestId,
        tool: 'subagent.invoke',
        status: 'error',
        error: `Persona not found: ${context.personaId}`,
      };
    }

    const loadedResult = this.deps.personaLoader.getByName(personaRowResult.value.name);
    if (loadedResult.isErr() || loadedResult.value === undefined) {
      return {
        requestId,
        tool: 'subagent.invoke',
        status: 'error',
        error: `Loaded persona not found: ${personaRowResult.value.name}`,
      };
    }

    const loadedPersona = loadedResult.value;
    const personaConfig = loadedPersona.config;

    const result = await this.deps.runner.execute(
      args.name,
      args.input ?? {},
      {
        threadId: context.threadId,
        personaId: context.personaId,
        personaSubagents: personaConfig.subagents ?? [],
        personaCapabilities: loadedPersona.resolvedCapabilities,
      },
    );

    if (result.isErr()) {
      return {
        requestId,
        tool: 'subagent.invoke',
        status: 'error',
        error: result.error.message,
      };
    }

    return {
      requestId,
      tool: 'subagent.invoke',
      status: 'success',
      result: result.value,
    };
  }
}
```

**Step 4: Add tool to HOST_TOOL_REGISTRY**

In `src/tools/tool-filter.ts`, add after the `db.query` entry:

```typescript
  { capabilityPrefix: 'subagent.invoke', internalName: 'subagent.invoke', mcpName: 'subagent_invoke' },
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/tools/subagent-invoke.test.ts --reporter=verbose`

Expected: PASS

**Step 6: Commit**

```bash
git add src/tools/host-tools/subagent-invoke.ts src/tools/tool-filter.ts tests/unit/tools/subagent-invoke.test.ts
git commit -m "feat(subagents): implement subagent_invoke host tool with capability validation"
```

---

### Task 9: Wire sub-agent system into daemon bootstrap

Initialize the loader, runner, and handler during daemon startup. Add the dispatch case to the bridge.

**Files:**
- Modify: `src/daemon/daemon-context.ts` (add `subAgentRunner` field)
- Modify: `src/daemon/daemon-bootstrap.ts` (load sub-agents, create runner)
- Modify: `src/tools/host-tools-bridge.ts` (add handler + dispatch case)
- Modify: `src/tools/host-tools-mcp-server.ts` (register subagent_invoke tool definition)

**Step 1: Add SubAgentRunner to DaemonContext**

In `src/daemon/daemon-context.ts`, add the import and field:

```typescript
import type { SubAgentRunner } from '../subagents/subagent-runner.js';

// In DaemonContext interface, add:
  readonly subAgentRunner: SubAgentRunner | null;
```

Use `| null` so existing code that doesn't have sub-agents configured still works.

**Step 2: Initialize in daemon-bootstrap.ts**

Read `daemon-bootstrap.ts` to find where other subsystems are initialized. Add after skill loading:

```typescript
// Load sub-agents (optional — directory may not exist).
import { SubAgentLoader } from '../subagents/subagent-loader.js';
import { SubAgentRunner } from '../subagents/subagent-runner.js';
import { ModelResolver } from '../subagents/model-resolver.js';

const subAgentLoader = new SubAgentLoader(logger);
const subAgentsDir = join(config.dataDir, 'subagents');
const loadedSubAgentsResult = await subAgentLoader.loadAll(subAgentsDir);
let subAgentRunner: SubAgentRunner | null = null;

if (loadedSubAgentsResult.isOk() && loadedSubAgentsResult.value.length > 0) {
  const agentMap = new Map(
    loadedSubAgentsResult.value.map((a) => [a.manifest.name, a]),
  );
  const modelResolver = new ModelResolver(config.auth.providers ?? {});
  subAgentRunner = new SubAgentRunner({
    agents: agentMap,
    modelResolver,
    services: {
      memory: repos.memory,
      schedules: repos.schedule,
      personas: repos.persona,
      channels: repos.channel,
      threads: repos.thread,
      messages: repos.message,
      runs: repos.run,
      queue: repos.queue,
      logger,
    },
    logger,
  });
  logger.info(
    { subagents: [...agentMap.keys()] },
    'daemon: loaded sub-agents',
  );
}
```

Add `subAgentRunner` to the DaemonContext construction.

**Step 3: Add dispatch to host-tools-bridge.ts**

In `HostToolsBridge`, add:

```typescript
import { SubAgentInvokeHandler, type SubAgentInvokeArgs } from './host-tools/subagent-invoke.js';

// In constructor, after memoryHandler:
private subagentHandler: SubAgentInvokeHandler | null = null;

// In constructor body, conditionally create:
if (ctx.subAgentRunner) {
  this.subagentHandler = new SubAgentInvokeHandler({
    runner: ctx.subAgentRunner,
    personaLoader: ctx.personaLoader,
    personaRepository: ctx.repos.persona,
    logger: ctx.logger,
  });
}

// In dispatch(), add case:
case 'subagent.invoke':
  if (!this.subagentHandler) {
    return {
      requestId: context.requestId ?? 'unknown',
      tool,
      status: 'error',
      error: 'Sub-agent system not initialized',
    };
  }
  return this.subagentHandler.execute(args as unknown as SubAgentInvokeArgs, context);
```

**Step 4: Register tool in MCP server**

In `src/tools/host-tools-mcp-server.ts`, add the `subagent_invoke` tool definition alongside existing tool definitions (look for the pattern where tools are registered):

```typescript
{
  name: 'subagent_invoke',
  description: 'Delegate a task to a specialized sub-agent that runs a cheap, fast model',
  inputSchema: {
    type: 'object' as const,
    properties: {
      name: { type: 'string', description: 'Sub-agent name (e.g. "memory-groomer", "file-searcher")' },
      input: { type: 'object', description: 'Task-specific input for the sub-agent' },
    },
    required: ['name'],
  },
}
```

**Step 5: Run full test suite for affected files**

Run: `npx vitest run tests/unit/tools/ tests/unit/subagents/ --reporter=verbose`

Expected: All PASS

**Step 6: Commit**

```bash
git add src/daemon/daemon-context.ts src/daemon/daemon-bootstrap.ts src/tools/host-tools-bridge.ts src/tools/host-tools-mcp-server.ts
git commit -m "feat(subagents): wire sub-agent system into daemon bootstrap and host tools bridge"
```

---

### Task 10: Add `subagents` barrel export and index

Create the module index for clean imports.

**Files:**
- Create: `src/subagents/index.ts`

**Step 1: Create barrel export**

```typescript
// src/subagents/index.ts
export { SubAgentLoader } from './subagent-loader.js';
export { SubAgentRunner, type SubAgentInvokeContext } from './subagent-runner.js';
export { ModelResolver } from './model-resolver.js';
export { SubAgentManifestSchema } from './subagent-schema.js';
export type {
  SubAgentManifest,
  SubAgentContext,
  SubAgentInput,
  SubAgentResult,
  SubAgentRunFn,
  SubAgentServices,
  LoadedSubAgent,
} from './subagent-types.js';
```

**Step 2: Verify build**

Run: `npx tsc --noEmit`

Expected: No errors

**Step 3: Commit**

```bash
git add src/subagents/index.ts
git commit -m "chore(subagents): add barrel export for sub-agent module"
```

---

## Phase 2: Built-in Sub-Agents

### Task 11: Create the `session-summarizer` sub-agent

The highest-value sub-agent — compresses session transcripts for resumption.

**Files:**
- Create: `subagents/session-summarizer/subagent.yaml`
- Create: `subagents/session-summarizer/prompts/01-system.md`
- Create: `subagents/session-summarizer/index.ts`
- Test: `tests/unit/subagents/session-summarizer.test.ts`

**Step 1: Create directory structure**

```bash
mkdir -p subagents/session-summarizer/prompts
```

**Step 2: Write the manifest**

```yaml
# subagents/session-summarizer/subagent.yaml
name: session-summarizer
version: "0.1.0"
description: "Compresses a long conversation transcript into key facts, decisions, and open threads for session resumption"

model:
  provider: anthropic
  name: claude-haiku-4-5
  maxTokens: 4096

requiredCapabilities: []

timeoutMs: 30000
```

**Step 3: Write the system prompt**

```markdown
<!-- subagents/session-summarizer/prompts/01-system.md -->
You are a session summarizer. Your job is to compress a conversation transcript into a structured summary that preserves all essential context.

Extract and organize:

1. **Key decisions** — What was decided and why
2. **Open threads** — Topics discussed but not resolved
3. **Important facts** — Names, numbers, preferences, constraints mentioned
4. **Action items** — Things the user or agent committed to doing
5. **Emotional context** — User's mood, frustrations, preferences observed

Format your response as JSON:
```json
{
  "decisions": ["..."],
  "openThreads": ["..."],
  "facts": ["..."],
  "actionItems": ["..."],
  "emotionalContext": "...",
  "oneSentenceSummary": "..."
}
```

Be thorough but concise. Every item should be one clear sentence.
```

**Step 4: Write the failing test**

```typescript
// tests/unit/subagents/session-summarizer.test.ts
import { describe, it, expect, vi } from 'vitest';

// We test the run function in isolation by mocking the AI SDK.
// The actual sub-agent uses generateText from 'ai'.
vi.mock('ai', () => ({
  generateText: vi.fn().mockResolvedValue({
    text: JSON.stringify({
      decisions: ['Use Haiku for summarization'],
      openThreads: ['Vector store integration pending'],
      facts: ['User prefers short responses'],
      actionItems: ['Deploy to VM after merge'],
      emotionalContext: 'Focused and productive',
      oneSentenceSummary: 'Discussed sub-agent architecture and token optimization.',
    }),
    usage: { promptTokens: 500, completionTokens: 200 },
  }),
}));

// Import after mock
import { run } from '../../../subagents/session-summarizer/index.js';

describe('session-summarizer', () => {
  it('returns structured summary from transcript', async () => {
    const ctx = {
      threadId: 'thread-1',
      personaId: 'persona-1',
      systemPrompt: 'You are a session summarizer.',
      model: {} as any,
      services: {
        memory: {} as any,
        schedules: {} as any,
        personas: {} as any,
        channels: {} as any,
        threads: {} as any,
        messages: {} as any,
        runs: {} as any,
        queue: {} as any,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      },
    };

    const result = await run(ctx, {
      transcript: 'User: Hi\nAssistant: Hello!\nUser: Let us use Haiku for summarization.\nAssistant: Good idea.',
    });

    expect(result.success).toBe(true);
    expect(result.data).toBeDefined();
    expect(result.data!.decisions).toContain('Use Haiku for summarization');
    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(500);
  });

  it('returns failure when transcript is empty', async () => {
    const ctx = {
      threadId: 'thread-1',
      personaId: 'persona-1',
      systemPrompt: 'You are a session summarizer.',
      model: {} as any,
      services: {
        memory: {} as any,
        schedules: {} as any,
        personas: {} as any,
        channels: {} as any,
        threads: {} as any,
        messages: {} as any,
        runs: {} as any,
        queue: {} as any,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as any,
      },
    };

    const result = await run(ctx, { transcript: '' });

    expect(result.success).toBe(false);
    expect(result.summary).toContain('empty');
  });
});
```

**Step 5: Implement the sub-agent**

```typescript
// subagents/session-summarizer/index.ts
/**
 * session-summarizer sub-agent
 *
 * Compresses conversation transcripts into structured summaries
 * for efficient session resumption.
 */

import { generateText } from 'ai';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../src/subagents/subagent-types.js';

export async function run(ctx: SubAgentContext, input: SubAgentInput): Promise<SubAgentResult> {
  const transcript = typeof input.transcript === 'string' ? input.transcript : '';

  if (!transcript.trim()) {
    return {
      success: false,
      summary: 'Cannot summarize empty transcript',
    };
  }

  const { text, usage } = await generateText({
    model: ctx.model,
    system: ctx.systemPrompt,
    prompt: `Summarize this conversation transcript:\n\n${transcript}`,
    maxTokens: 4096,
  });

  // Parse the structured response.
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // If the model didn't return JSON, wrap the text as-is.
    data = { rawSummary: text };
  }

  return {
    success: true,
    summary: typeof data.oneSentenceSummary === 'string'
      ? data.oneSentenceSummary
      : 'Session summarized successfully',
    data,
    usage: {
      inputTokens: usage?.promptTokens ?? 0,
      outputTokens: usage?.completionTokens ?? 0,
      costUsd: 0, // Caller can compute from model pricing
    },
  };
}
```

**Step 6: Run test to verify it passes**

Run: `npx vitest run tests/unit/subagents/session-summarizer.test.ts --reporter=verbose`

Expected: PASS

**Step 7: Commit**

```bash
git add subagents/session-summarizer/ tests/unit/subagents/session-summarizer.test.ts
git commit -m "feat(subagents): implement session-summarizer sub-agent"
```

---

### Task 12: Create the `memory-groomer` sub-agent

Reviews memory entries, consolidates duplicates, prunes stale items.

**Files:**
- Create: `subagents/memory-groomer/subagent.yaml`
- Create: `subagents/memory-groomer/prompts/01-system.md`
- Create: `subagents/memory-groomer/index.ts`
- Test: `tests/unit/subagents/memory-groomer.test.ts`

This follows the exact same pattern as Task 11. Key differences:

- **requiredCapabilities**: `['memory.read:thread', 'memory.write:thread']`
- **Input**: reads all memory items for the thread via `services.memory`
- **Output**: actions taken (consolidated, pruned, kept) + counts
- Uses `generateText` to ask the model which memories to consolidate/prune
- Writes back via `services.memory` (delete old, insert consolidated)

**Step 1: Create directory and manifest**

```yaml
# subagents/memory-groomer/subagent.yaml
name: memory-groomer
version: "0.1.0"
description: "Reviews memory entries, consolidates duplicates, prunes stale items"

model:
  provider: anthropic
  name: claude-haiku-4-5
  maxTokens: 4096

requiredCapabilities:
  - memory.read:thread
  - memory.write:thread

timeoutMs: 30000
```

**Step 2-6: Follow same TDD pattern as Task 11**

The `run` function:
1. Reads all memory items for the thread via `ctx.services.memory.findByThread(ctx.threadId)`
2. If empty, returns early with `{ success: true, summary: 'No memories to groom' }`
3. Formats memories as numbered list and sends to model asking for grooming plan
4. Parses model response (JSON with consolidate/prune/keep decisions)
5. Executes decisions against the memory repository
6. Returns summary with counts

**Step 7: Commit**

```bash
git add subagents/memory-groomer/ tests/unit/subagents/memory-groomer.test.ts
git commit -m "feat(subagents): implement memory-groomer sub-agent"
```

---

### Task 13: Create the `file-searcher` sub-agent

Searches files by content within configured `rootPaths` and returns ranked results.

**Files:**
- Create: `subagents/file-searcher/subagent.yaml`
- Create: `subagents/file-searcher/prompts/01-system.md`
- Create: `subagents/file-searcher/index.ts`
- Create: `subagents/file-searcher/lib/search.ts`
- Test: `tests/unit/subagents/file-searcher.test.ts`

Key differences from other sub-agents:

- **requiredCapabilities**: `['fs.read']`
- **rootPaths** in manifest configures accessible directories
- Uses Node.js `fs` + `readdir` recursive to scan files
- Filters by file type (`.md`, `.txt`, `.ts`, etc.)
- Sends matching snippets to Haiku for relevance ranking
- Returns `{ path, snippet, relevance }[]`

**Step 1: Create directory and manifest**

```yaml
# subagents/file-searcher/subagent.yaml
name: file-searcher
version: "0.1.0"
description: "Search files by content and return ranked results with snippets"

model:
  provider: anthropic
  name: claude-haiku-4-5
  maxTokens: 2048

requiredCapabilities:
  - fs.read

rootPaths:
  - /home/talon/cf-notes
  - /home/talon/personal-notes

timeoutMs: 30000
```

**Step 2: Implement the search helper (lib/search.ts)**

A pure Node.js file search function that:
1. Recursively reads `rootPaths`
2. Filters by extensions (default: `.md`, `.txt`)
3. Searches file content for the query string (case-insensitive)
4. Returns matches with surrounding context lines

**Step 3-7: Follow same TDD pattern**

The `run` function:
1. Validates `input.query` exists
2. Calls the search helper with `rootPaths` from manifest and query
3. If too many matches, sends top N snippets to Haiku for ranking
4. Returns ranked `{ path, snippet, relevance }[]`

```bash
git add subagents/file-searcher/ tests/unit/subagents/file-searcher.test.ts
git commit -m "feat(subagents): implement file-searcher sub-agent with rootPaths access"
```

---

### Task 14: Create the `memory-retriever` sub-agent

Finds relevant memories for a query using keyword matching and LLM reranking.

**Files:**
- Create: `subagents/memory-retriever/subagent.yaml`
- Create: `subagents/memory-retriever/prompts/01-system.md`
- Create: `subagents/memory-retriever/index.ts`
- Test: `tests/unit/subagents/memory-retriever.test.ts`

- **requiredCapabilities**: `['memory.read:thread']`
- Reads all memories, sends to Haiku with the query for relevance ranking
- Returns top N relevant memories with relevance scores
- Future: replace keyword matching with vector similarity

**Step 1-7: Follow same TDD pattern**

```bash
git add subagents/memory-retriever/ tests/unit/subagents/memory-retriever.test.ts
git commit -m "feat(subagents): implement memory-retriever sub-agent with LLM reranking"
```

---

### Task 15: CLI command `talonctl run-subagent`

A manual testing command to invoke any sub-agent from the command line without going through the main agent. Invaluable for development and debugging.

**Files:**
- Create: `src/cli/commands/run-subagent.ts`
- Modify: `src/cli/index.ts` (register the command)
- Test: `tests/unit/cli/run-subagent.test.ts`

**Step 1: Write the failing test**

Test the pure `runSubAgent()` function (not the CLI wrapper).

```typescript
// tests/unit/cli/run-subagent.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { runSubAgent } from '../../../src/cli/commands/run-subagent.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `run-subagent-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('runSubAgent()', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempDir();
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads and executes a sub-agent by name', async () => {
    const agentDir = join(root, 'echo-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'subagent.yaml'),
      `name: echo-agent\nversion: "0.1.0"\ndescription: "Echoes input"\nmodel:\n  provider: anthropic\n  name: claude-haiku-4-5`,
    );
    writeFileSync(
      join(agentDir, 'index.js'),
      `export async function run(ctx, input) {
        return { success: true, summary: 'Echo: ' + (input.prompt || ''), data: {} };
      }`,
    );

    const result = await runSubAgent({
      name: 'echo-agent',
      input: '{"prompt": "hello"}',
      subagentsDir: root,
      providers: { anthropic: { apiKey: 'test' } },
    });

    expect(result.success).toBe(true);
    expect(result.summary).toContain('hello');
  });

  it('throws for unknown sub-agent', async () => {
    await expect(
      runSubAgent({
        name: 'nonexistent',
        input: '{}',
        subagentsDir: root,
        providers: {},
      }),
    ).rejects.toThrow('not found');
  });

  it('throws for invalid JSON input', async () => {
    const agentDir = join(root, 'test-agent');
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      join(agentDir, 'subagent.yaml'),
      `name: test-agent\nversion: "0.1.0"\ndescription: "Test"\nmodel:\n  provider: anthropic\n  name: claude-haiku-4-5`,
    );
    writeFileSync(
      join(agentDir, 'index.js'),
      `export async function run() { return { success: true, summary: 'ok' }; }`,
    );

    await expect(
      runSubAgent({
        name: 'test-agent',
        input: 'not-json',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
      }),
    ).rejects.toThrow('Invalid JSON');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/run-subagent.test.ts --reporter=verbose`

Expected: FAIL — module not found

**Step 3: Implement the command**

```typescript
// src/cli/commands/run-subagent.ts
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

const makeNullLogger = () =>
  ({
    info: () => {},
    warn: () => {},
    error: () => {},
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

  // Load sub-agents.
  const logger = makeNullLogger();
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

  // Execute.
  const systemPrompt = agent.promptContents.join('\n\n');
  return agent.run(
    {
      threadId: 'cli-test',
      personaId: 'cli-test',
      systemPrompt,
      model: modelResult.value,
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
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function runSubAgentCommand(options: {
  name: string;
  input: string;
  configPath?: string;
}): Promise<void> {
  const { loadConfig } = await import('../../core/config/config-loader.js');

  const configPath = options.configPath ?? 'talond.yaml';
  const configResult = loadConfig(configPath);
  if (configResult.isErr()) {
    console.error(`Error loading config: ${configResult.error.message}`);
    process.exit(1);
    return;
  }

  const config = configResult.value;
  const subagentsDir = join(config.dataDir, 'subagents');

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
```

**Step 4: Register in CLI index**

In `src/cli/index.ts`, add:

```typescript
import { runSubAgentCommand } from './commands/run-subagent.js';

// ... in the command registration section:

program
  .command('run-subagent')
  .description('Manually invoke a sub-agent for testing (no daemon required)')
  .requiredOption('--name <name>', 'Sub-agent name (e.g. "session-summarizer")')
  .requiredOption('--input <json>', 'JSON input for the sub-agent')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; input: string; config: string }) => {
    await runSubAgentCommand({
      name: opts.name,
      input: opts.input,
      configPath: opts.config,
    });
  });
```

**Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/cli/run-subagent.test.ts --reporter=verbose`

Expected: PASS

**Step 6: Commit**

```bash
git add src/cli/commands/run-subagent.ts src/cli/index.ts tests/unit/cli/run-subagent.test.ts
git commit -m "feat(cli): add talonctl run-subagent command for manual testing"
```

**Usage:**

```bash
# Test the session-summarizer
talonctl run-subagent --name session-summarizer \
  --input '{"transcript": "User: Hi\nAssistant: Hello!"}'

# Test the file-searcher
talonctl run-subagent --name file-searcher \
  --input '{"query": "deployment notes", "maxResults": 5}'

# Test with a specific config
talonctl run-subagent --name memory-groomer \
  --input '{}' --config /etc/talon/talond.yaml
```

---

## Phase 3: Integration & Verification

### Task 16: End-to-end integration test

Test the full pipeline: config → loader → runner → host tool → result.

**Files:**
- Create: `tests/integration/subagent-pipeline.test.ts`

**Step 1: Write the integration test**

```typescript
// tests/integration/subagent-pipeline.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SubAgentLoader } from '../../src/subagents/subagent-loader.js';
import { SubAgentRunner } from '../../src/subagents/subagent-runner.js';
import { ok } from 'neverthrow';

describe('Sub-agent pipeline integration', () => {
  let root: string;

  beforeEach(() => {
    root = join(tmpdir(), `subagent-integration-${randomUUID()}`);
    mkdirSync(root, { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('loads, validates, and executes a sub-agent end-to-end', async () => {
    // Create a test sub-agent
    const agentDir = join(root, 'echo-agent');
    mkdirSync(join(agentDir, 'prompts'), { recursive: true });

    writeFileSync(
      join(agentDir, 'subagent.yaml'),
      `name: echo-agent
version: "0.1.0"
description: "Echoes input back"
model:
  provider: anthropic
  name: claude-haiku-4-5`,
    );

    writeFileSync(
      join(agentDir, 'index.js'),
      `export async function run(ctx, input) {
        return { success: true, summary: 'Echoed: ' + input.message, data: { echo: input.message } };
      }`,
    );

    writeFileSync(join(agentDir, 'prompts', '01-system.md'), 'You echo things.');

    const logger = {
      info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
      child: function() { return this; },
    } as any;

    // Load
    const loader = new SubAgentLoader(logger);
    const loaded = await loader.loadAll(root);
    expect(loaded.isOk()).toBe(true);
    const agents = loaded._unsafeUnwrap();
    expect(agents).toHaveLength(1);
    expect(agents[0].promptContents).toEqual(['You echo things.']);

    // Build runner
    const agentMap = new Map(agents.map((a) => [a.manifest.name, a]));
    const mockResolver = {
      resolve: vi.fn().mockResolvedValue(ok({} as any)),
    };
    const runner = new SubAgentRunner({
      agents: agentMap,
      modelResolver: mockResolver as any,
      services: { logger } as any,
      logger,
    });

    // Execute
    const result = await runner.execute('echo-agent', { message: 'hello' }, {
      threadId: 'thread-1',
      personaId: 'persona-1',
      personaSubagents: ['echo-agent'],
      personaCapabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap().summary).toBe('Echoed: hello');
    expect(result._unsafeUnwrap().data).toEqual({ echo: 'hello' });
  });
});
```

**Step 2: Run test**

Run: `npx vitest run tests/integration/subagent-pipeline.test.ts --reporter=verbose`

Expected: PASS

**Step 3: Commit**

```bash
git add tests/integration/subagent-pipeline.test.ts
git commit -m "test(subagents): add end-to-end integration test for sub-agent pipeline"
```

---

### Task 17: Verify build and run all tests

**Step 1: Type check**

Run: `npx tsc --noEmit`

Expected: No errors

**Step 2: Run all sub-agent tests**

Run: `npx vitest run tests/unit/subagents/ tests/integration/subagent-pipeline.test.ts --reporter=verbose`

Expected: All PASS

**Step 3: Run the full affected test suite**

Run: `npx vitest run tests/unit/core/config/ tests/unit/tools/ tests/unit/subagents/ tests/integration/ --reporter=verbose`

Expected: All PASS

**Step 4: Commit any fixes needed, then final commit**

```bash
git commit -m "chore(subagents): verify build and test suite passes"
```

---

## Summary of Files Created / Modified

**New files (src/):**
- `src/subagents/subagent-types.ts` — Types and interfaces
- `src/subagents/subagent-schema.ts` — Zod manifest schema
- `src/subagents/subagent-loader.ts` — Loads sub-agents from directories
- `src/subagents/model-resolver.ts` — Vercel AI SDK provider factory
- `src/subagents/subagent-runner.ts` — Core execution engine
- `src/subagents/index.ts` — Barrel export
- `src/tools/host-tools/subagent-invoke.ts` — Host tool handler
- `src/cli/commands/run-subagent.ts` — CLI testing command

**New files (subagents/):**
- `subagents/session-summarizer/` — Session compression sub-agent
- `subagents/memory-groomer/` — Memory consolidation sub-agent
- `subagents/file-searcher/` — File search sub-agent
- `subagents/memory-retriever/` — Memory retrieval sub-agent

**Modified files:**
- `package.json` — Add AI SDK dependencies
- `src/core/config/config-schema.ts` — auth.providers + persona.subagents
- `src/tools/tool-filter.ts` — Add subagent.invoke to registry
- `src/tools/host-tools-bridge.ts` — Add dispatch case
- `src/tools/host-tools-mcp-server.ts` — Register tool definition
- `src/daemon/daemon-context.ts` — Add subAgentRunner field
- `src/daemon/daemon-bootstrap.ts` — Initialize sub-agent system
- `src/cli/index.ts` — Register run-subagent command

**New test files:**
- `tests/unit/subagents/subagent-schema.test.ts`
- `tests/unit/subagents/subagent-loader.test.ts`
- `tests/unit/subagents/model-resolver.test.ts`
- `tests/unit/subagents/subagent-runner.test.ts`
- `tests/unit/tools/subagent-invoke.test.ts`
- `tests/unit/cli/run-subagent.test.ts`
- `tests/unit/subagents/session-summarizer.test.ts`
- `tests/unit/subagents/memory-groomer.test.ts`
- `tests/unit/subagents/file-searcher.test.ts`
- `tests/unit/subagents/memory-retriever.test.ts`
- `tests/integration/subagent-pipeline.test.ts`
