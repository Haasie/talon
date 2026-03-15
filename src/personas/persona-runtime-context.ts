import type { LoadedPersona } from './persona-types.js';
import type { LoadedSkill } from '../skills/skill-types.js';
import type { SkillResolver } from '../skills/skill-resolver.js';
import type { CanonicalMcpServer } from '../providers/provider-types.js';

export interface PersonaRuntimeContext {
  personaPrompt: string;
  mcpServers: Record<string, CanonicalMcpServer>;
}

interface BuildPersonaRuntimeContextOptions {
  loadedPersona: LoadedPersona;
  resolvedSkills: LoadedSkill[];
  skillResolver: SkillResolver;
  excludeServerNames?: string[];
  logger?: {
    warn: (payload: Record<string, unknown>, message: string) => void;
  };
}

function resolveEnvPlaceholder(value: string): string {
  const match = /^\$\{(\w+)\}$/.exec(value);
  return match ? (process.env[match[1] ?? ''] ?? '') : value;
}

function resolveHeaderPlaceholders(
  value: string,
  serverName: string,
  header: string,
  logger?: BuildPersonaRuntimeContextOptions['logger'],
): string {
  return value.replace(/\$\{(\w+)\}/g, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      logger?.warn(
        { mcpServer: serverName, header, variable: varName },
        'agent-sdk: unresolved env var in MCP header — value will be empty',
      );
    }
    return envValue ?? '';
  });
}

export function buildPersonaRuntimeContext(
  options: BuildPersonaRuntimeContextOptions,
): PersonaRuntimeContext {
  const skillPrompt = options.skillResolver.mergePromptFragments(options.resolvedSkills);
  const personaPrompt = [
    options.loadedPersona.systemPromptContent ?? '',
    options.loadedPersona.personalityContent ?? '',
    skillPrompt,
  ]
    .filter(Boolean)
    .join('\n\n');

  const excluded = new Set(options.excludeServerNames ?? []);
  const mcpServers: Record<string, CanonicalMcpServer> = {};
  const serverDefs =
    typeof options.skillResolver.collectMcpServers === 'function'
      ? options.skillResolver.collectMcpServers(options.resolvedSkills)
      : options.resolvedSkills.flatMap((skill) => skill.resolvedMcpServers);

  for (const server of serverDefs) {
    if (excluded.has(server.name)) {
      continue;
    }

    const cfg = server.config;
    const resolvedEnv: Record<string, string> = {};
    if (cfg.env) {
      for (const [key, value] of Object.entries(cfg.env)) {
        resolvedEnv[key] = resolveEnvPlaceholder(value);
      }
    }

    const resolvedHeaders: Record<string, string> = {};
    if (cfg.headers && (cfg.transport === 'http' || cfg.transport === 'sse')) {
      for (const [key, value] of Object.entries(cfg.headers)) {
        resolvedHeaders[key] = resolveHeaderPlaceholders(
          value,
          server.name,
          key,
          options.logger,
        );
      }
    }

    if (cfg.transport === 'stdio') {
      mcpServers[server.name] = {
        transport: 'stdio',
        command: cfg.command,
        args: cfg.args ?? [],
        ...(Object.keys(resolvedEnv).length > 0 ? { env: resolvedEnv } : {}),
      };
      continue;
    }

    mcpServers[server.name] = {
      transport: cfg.transport,
      ...(cfg.url ? { url: cfg.url } : {}),
      ...(Object.keys(resolvedHeaders).length > 0 ? { headers: resolvedHeaders } : {}),
    };
  }

  return { personaPrompt, mcpServers };
}
