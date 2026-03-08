/**
 * Model Context Protocol (MCP) support.
 *
 * Exposes talond resources and tools as an MCP server, and allows personas
 * to consume external MCP servers as tool sources.
 */

export type {
  McpServerConfig,
  McpRateLimitConfig,
  McpToolCall,
  McpToolResult,
  McpServerStatus,
  McpServerEntry,
} from './mcp-types.js';

export { McpRegistry } from './mcp-registry.js';
