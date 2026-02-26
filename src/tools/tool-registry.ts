/**
 * In-memory tool registry.
 *
 * Maintains the authoritative map of tool name -> {@link ToolManifest}.
 * Tools are registered once at daemon startup (built-in host tools, MCP
 * proxies) and never mutated after registration.
 *
 * All lookups are synchronous and O(1) or O(n) for list variants.
 */

import type { ExecutionLocation, ToolManifest } from './tool-types.js';

/**
 * Central registry for all tools available to the talond host.
 *
 * Callers register manifests at startup, then the policy engine and tool
 * dispatcher use {@link get}, {@link listByCapability}, and
 * {@link listByLocation} to resolve tool metadata at call time.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolManifest>();

  /**
   * Register a tool manifest.
   *
   * If a tool with the same name is already registered it is replaced.
   * Callers should avoid re-registering unless intentionally overriding
   * (e.g. in tests).
   *
   * @param manifest - The tool descriptor to register.
   */
  register(manifest: ToolManifest): void {
    this.tools.set(manifest.name, manifest);
  }

  /**
   * Remove a tool from the registry by name.
   *
   * No-op if the tool is not registered.
   *
   * @param name - Tool name to remove.
   */
  unregister(name: string): void {
    this.tools.delete(name);
  }

  /**
   * Look up a tool manifest by name.
   *
   * @param name - Tool name.
   * @returns The manifest if registered, otherwise `undefined`.
   */
  get(name: string): ToolManifest | undefined {
    return this.tools.get(name);
  }

  /**
   * Return all registered tool manifests as an array.
   *
   * The order is insertion order (Map iteration order).
   *
   * @returns Snapshot array of all manifests.
   */
  listAll(): ToolManifest[] {
    return Array.from(this.tools.values());
  }

  /**
   * Return all tools that require a specific capability label.
   *
   * A tool matches if `capability` appears anywhere in its `capabilities`
   * array. Useful for capability auditing and documentation generation.
   *
   * @param capability - The capability label to filter by.
   * @returns Array of matching manifests (may be empty).
   */
  listByCapability(capability: string): ToolManifest[] {
    const result: ToolManifest[] = [];
    for (const manifest of this.tools.values()) {
      if (manifest.capabilities.includes(capability)) {
        result.push(manifest);
      }
    }
    return result;
  }

  /**
   * Return all tools that execute at the given location.
   *
   * @param location - Execution location to filter by.
   * @returns Array of matching manifests (may be empty).
   */
  listByLocation(location: ExecutionLocation): ToolManifest[] {
    const result: ToolManifest[] = [];
    for (const manifest of this.tools.values()) {
      if (manifest.executionLocation === location) {
        result.push(manifest);
      }
    }
    return result;
  }
}
