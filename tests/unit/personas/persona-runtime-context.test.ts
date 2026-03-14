import { describe, expect, it, vi } from 'vitest';
import { buildPersonaRuntimeContext } from '../../../src/personas/persona-runtime-context.js';
import type { LoadedPersona } from '../../../src/personas/persona-types.js';
import type { LoadedSkill, McpServerDef } from '../../../src/skills/skill-types.js';

function makeLoadedSkill(name: string, servers: McpServerDef[]): LoadedSkill {
  return {
    manifest: {
      name,
      version: '1.0.0',
      description: `${name} description`,
      requiredCapabilities: [],
      promptFragments: [],
      toolManifests: [],
      mcpServers: [],
      migrations: [],
    },
    promptContents: [`prompt:${name}`],
    resolvedToolManifests: [],
    resolvedMcpServers: servers,
    migrationPaths: [],
  };
}

describe('buildPersonaRuntimeContext', () => {
  const loadedPersona: LoadedPersona = {
    config: {
      name: 'assistant',
      model: 'claude-sonnet-4-6',
      skills: ['search', 'browser'],
      subagents: [],
      capabilities: { allow: [], requireApproval: [] },
      mounts: [],
    },
    systemPromptContent: 'You are helpful.',
    personalityContent: 'Stay concise.',
    resolvedCapabilities: { allow: [], requireApproval: [] },
  };

  it('merges prompt fragments and resolves env placeholders in MCP config', () => {
    process.env.TEST_API_KEY = 'secret-token';
    process.env.TEST_BEARER = 'bearer-token';

    const loadedSkills = [
      makeLoadedSkill('search', [
        {
          name: 'perplexity',
          config: {
            name: 'perplexity',
            transport: 'stdio',
            command: 'npx',
            args: ['perplexity-mcp'],
            env: { API_KEY: '${TEST_API_KEY}' },
          },
        },
      ]),
      makeLoadedSkill('browser', [
        {
          name: 'browser',
          config: {
            name: 'browser',
            transport: 'http',
            url: 'https://mcp.example.test',
            headers: { Authorization: 'Bearer ${TEST_BEARER}' },
          },
        },
      ]),
    ];

    const skillResolver = {
      mergePromptFragments: vi.fn().mockReturnValue('search prompt\nbrowser prompt'),
      collectMcpServers: vi
        .fn()
        .mockReturnValue(loadedSkills.flatMap((skill) => skill.resolvedMcpServers)),
    };

    const result = buildPersonaRuntimeContext({
      loadedPersona,
      resolvedSkills: loadedSkills,
      skillResolver: skillResolver as any,
    });

    expect(result.personaPrompt).toBe('You are helpful.\n\nStay concise.\n\nsearch prompt\nbrowser prompt');
    expect(result.mcpServers).toEqual({
      perplexity: {
        type: 'stdio',
        command: 'npx',
        args: ['perplexity-mcp'],
        env: { API_KEY: 'secret-token' },
      },
      browser: {
        type: 'http',
        url: 'https://mcp.example.test',
        headers: { Authorization: 'Bearer bearer-token' },
      },
    });
  });

  it('filters excluded MCP servers and lets later definitions win', () => {
    const resolvedSkills = [
      makeLoadedSkill('first', [
        {
          name: 'duplicate',
          config: { name: 'duplicate', transport: 'stdio', command: 'first' },
        },
      ]),
      makeLoadedSkill('second', [
        {
          name: 'duplicate',
          config: { name: 'duplicate', transport: 'stdio', command: 'second' },
        },
        {
          name: 'host-tools',
          config: { name: 'host-tools', transport: 'stdio', command: 'node' },
        },
      ]),
    ];

    const skillResolver = {
      mergePromptFragments: vi.fn().mockReturnValue(''),
      collectMcpServers: vi
        .fn()
        .mockReturnValue(resolvedSkills.flatMap((skill) => skill.resolvedMcpServers)),
    };

    const result = buildPersonaRuntimeContext({
      loadedPersona,
      resolvedSkills,
      skillResolver: skillResolver as any,
      excludeServerNames: ['host-tools'],
    });

    expect(result.mcpServers).toEqual({
      duplicate: {
        type: 'stdio',
        command: 'second',
        args: [],
      },
    });
  });
});
