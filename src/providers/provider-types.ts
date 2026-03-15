import type { z } from 'zod';
import type {
  ProviderConfigSchema,
} from '../core/config/config-schema.js';

export type ProviderName = string;

export interface AgentUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalCostUsd?: number;
}

export interface ContextUsage {
  ratio: number;
  inputTokens: number;
  rawMetric: number;
  rawMetricName: string;
}

export interface CanonicalMcpStdioServer {
  transport: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface CanonicalMcpHttpServer {
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

export type CanonicalMcpServer = CanonicalMcpStdioServer | CanonicalMcpHttpServer;

export interface ProviderResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  usage?: AgentUsage;
}

export interface ProviderSpawnInput {
  prompt: string;
  systemPrompt: string;
  mcpServers: Record<string, CanonicalMcpServer>;
  cwd: string;
  timeoutMs: number;
}

export interface PreparedProviderInvocation {
  command: string;
  args: string[];
  stdin: string;
  cwd: string;
  timeoutMs: number;
  cleanupPaths: string[];
}

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;
