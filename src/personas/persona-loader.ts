/**
 * PersonaLoader — loads and hydrates persona definitions from configuration.
 *
 * Responsibilities:
 *   1. Read optional system-prompt files from disk.
 *   2. Resolve effective capabilities by merging persona-level grants.
 *   3. Validate capability labels (warn-only — never fails loading).
 *   4. Upsert persona records to the database via PersonaRepository.
 *   5. Maintain an in-process cache for fast name-based lookups.
 */

import { readFile } from 'node:fs/promises';
import { v4 as uuidv4 } from 'uuid';
import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import { PersonaError } from '../core/errors/index.js';
import type { PersonaRepository } from '../core/database/repositories/persona-repository.js';
import type { PersonaConfig } from '../core/config/config-types.js';
import { mergeCapabilities, validateCapabilityLabels } from './capability-merger.js';
import type { LoadedPersona, ResolvedCapabilities } from './persona-types.js';

// ---------------------------------------------------------------------------
// PersonaLoader
// ---------------------------------------------------------------------------

/**
 * Loads persona definitions from config, persists them to the database, and
 * provides a name-keyed cache for fast runtime lookups.
 */
export class PersonaLoader {
  /** In-process cache populated after `loadFromConfig`. */
  private readonly cache = new Map<string, LoadedPersona>();

  constructor(
    private readonly personaRepo: PersonaRepository,
    private readonly logger: pino.Logger,
  ) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Loads all persona configs, reads system prompt files, resolves capabilities,
   * upserts to the database, and populates the internal cache.
   *
   * If any single persona fails (e.g. system prompt file unreadable, DB write
   * error) the entire operation returns an `Err`. The error message identifies
   * which persona caused the failure.
   *
   * @param configs - Array of persona config objects from the daemon config file.
   * @returns `Ok(LoadedPersona[])` on success, `Err(PersonaError)` on failure.
   */
  async loadFromConfig(configs: PersonaConfig[]): Promise<Result<LoadedPersona[], PersonaError>> {
    const loaded: LoadedPersona[] = [];

    for (const config of configs) {
      const result = await this.loadOne(config);
      if (result.isErr()) {
        return err(result.error);
      }
      loaded.push(result.value);
    }

    return ok(loaded);
  }

  /**
   * Looks up a previously-loaded persona by its name.
   *
   * Returns `undefined` if no persona with that name was loaded (e.g. if
   * `loadFromConfig` has not been called yet, or the name does not exist in
   * the config).
   *
   * @param name - The persona name to look up.
   * @returns `Ok(LoadedPersona | undefined)`.
   */
  getByName(name: string): Result<LoadedPersona | undefined, PersonaError> {
    return ok(this.cache.get(name));
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Loads a single persona: reads system prompt, resolves capabilities, upserts
   * to DB, and stores in cache.
   */
  private async loadOne(config: PersonaConfig): Promise<Result<LoadedPersona, PersonaError>> {
    // 1. Read system prompt file if specified.
    let systemPromptContent: string | undefined;
    if (config.systemPromptFile) {
      const readResult = await this.readSystemPrompt(config.systemPromptFile, config.name);
      if (readResult.isErr()) {
        return err(readResult.error);
      }
      systemPromptContent = readResult.value;
    }

    // 2. Resolve effective capabilities (persona-level only at load time;
    //    skill-level merging happens at runtime when skills are attached).
    const resolvedCapabilities: ResolvedCapabilities = mergeCapabilities(config.capabilities);

    // 3. Validate labels — emit warnings but never block loading.
    const { warnings } = validateCapabilityLabels(resolvedCapabilities);
    for (const warning of warnings) {
      this.logger.warn({ persona: config.name }, warning);
    }

    // 4. Upsert to the database.
    const upsertResult = this.upsertPersona(config);
    if (upsertResult.isErr()) {
      return err(upsertResult.error);
    }

    // 5. Build the loaded persona and cache it.
    const loadedPersona: LoadedPersona = {
      config,
      systemPromptContent,
      resolvedCapabilities,
    };

    this.cache.set(config.name, loadedPersona);
    this.logger.info({ persona: config.name }, 'persona loaded');

    return ok(loadedPersona);
  }

  /**
   * Reads a system prompt file from disk.
   *
   * @param filePath  - Path to the system prompt file.
   * @param personaName - Persona name (used in error messages).
   */
  private async readSystemPrompt(
    filePath: string,
    personaName: string,
  ): Promise<Result<string, PersonaError>> {
    try {
      const content = await readFile(filePath, 'utf-8');
      this.logger.debug({ persona: personaName, file: filePath }, 'system prompt file read');
      return ok(content);
    } catch (cause) {
      return err(
        new PersonaError(
          `Failed to read system prompt file "${filePath}" for persona "${personaName}": ${String(cause)}`,
          cause instanceof Error ? cause : undefined,
        ),
      );
    }
  }

  /**
   * Upserts a persona to the database.
   *
   * Attempts to find an existing record by name and update it; if none exists,
   * inserts a new record. This ensures idempotent startup behaviour.
   *
   * @param config - The persona config to persist.
   */
  private upsertPersona(config: PersonaConfig): Result<void, PersonaError> {
    // Check if persona already exists.
    const findResult = this.personaRepo.findByName(config.name);
    if (findResult.isErr()) {
      return err(
        new PersonaError(
          `Database lookup failed for persona "${config.name}": ${findResult.error.message}`,
          findResult.error,
        ),
      );
    }

    const existingRow = findResult.value;

    if (existingRow) {
      // Update existing record.
      const updateResult = this.personaRepo.update(existingRow.id, {
        model: config.model,
        system_prompt_file: config.systemPromptFile ?? null,
        skills: JSON.stringify(config.skills),
        capabilities: JSON.stringify(config.capabilities),
        mounts: JSON.stringify(config.mounts),
        max_concurrent: config.maxConcurrent ?? null,
      });

      if (updateResult.isErr()) {
        return err(
          new PersonaError(
            `Failed to update persona "${config.name}" in database: ${updateResult.error.message}`,
            updateResult.error,
          ),
        );
      }

      this.logger.debug({ persona: config.name }, 'persona record updated in database');
    } else {
      // Insert new record.
      const insertResult = this.personaRepo.insert({
        id: uuidv4(),
        name: config.name,
        model: config.model,
        system_prompt_file: config.systemPromptFile ?? null,
        skills: JSON.stringify(config.skills),
        capabilities: JSON.stringify(config.capabilities),
        mounts: JSON.stringify(config.mounts),
        max_concurrent: config.maxConcurrent ?? null,
      });

      if (insertResult.isErr()) {
        return err(
          new PersonaError(
            `Failed to insert persona "${config.name}" into database: ${insertResult.error.message}`,
            insertResult.error,
          ),
        );
      }

      this.logger.debug({ persona: config.name }, 'persona record inserted into database');
    }

    return ok(undefined);
  }
}
