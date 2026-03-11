import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

// Mock the model resolver to avoid needing real API keys.
vi.mock('../../../src/subagents/model-resolver.js', () => ({
  ModelResolver: class {
    async resolve() {
      return { isErr: () => false, isOk: () => true, value: {} };
    }
  },
}));

import { runSubAgent } from '../../../src/cli/commands/run-subagent.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `run-subagent-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeSubAgent(root: string, name: string, runBody: string): void {
  const agentDir = join(root, name);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'subagent.yaml'),
    [
      `name: ${name}`,
      'version: "0.1.0"',
      `description: "Test agent ${name}"`,
      'model:',
      '  provider: anthropic',
      '  name: claude-haiku-4-5',
      '  maxTokens: 1024',
      'requiredCapabilities: []',
      'rootPaths: []',
      'timeoutMs: 10000',
    ].join('\n'),
  );
  writeFileSync(
    join(agentDir, 'index.js'),
    runBody,
  );
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
    writeSubAgent(root, 'echo-agent', `
      export async function run(ctx, input) {
        const { ok } = await import('neverthrow');
        return ok({ summary: 'Echo: ' + (input.prompt || ''), data: { prompt: input.prompt } });
      }
    `);

    const result = await runSubAgent({
      name: 'echo-agent',
      input: '{"prompt": "hello"}',
      subagentsDir: root,
      providers: { anthropic: { apiKey: 'test' } },
    });

    expect(result.summary).toContain('hello');
  });

  it('throws for unknown sub-agent', async () => {
    writeSubAgent(root, 'other-agent', `
      export async function run() {
        const { ok } = await import('neverthrow');
        return ok({ summary: 'ok' });
      }
    `);

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
    writeSubAgent(root, 'test-agent', `
      export async function run() {
        const { ok } = await import('neverthrow');
        return ok({ summary: 'ok' });
      }
    `);

    await expect(
      runSubAgent({
        name: 'test-agent',
        input: 'not-json',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
      }),
    ).rejects.toThrow('Invalid JSON');
  });

  it('throws when sub-agent run returns an error', async () => {
    writeSubAgent(root, 'fail-agent', `
      export async function run() {
        const { err } = await import('neverthrow');
        return err(new Error('Something went wrong'));
      }
    `);

    await expect(
      runSubAgent({
        name: 'fail-agent',
        input: '{}',
        subagentsDir: root,
        providers: { anthropic: { apiKey: 'test' } },
      }),
    ).rejects.toThrow('Sub-agent execution failed');
  });

  it('throws for empty subagents directory', async () => {
    await expect(
      runSubAgent({
        name: 'anything',
        input: '{}',
        subagentsDir: root,
        providers: {},
      }),
    ).rejects.toThrow('not found');
  });
});
