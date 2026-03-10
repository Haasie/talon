import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { createTestDb, uuid } from '../core/database/repositories/helpers.js';

describe('ScheduleRepository — findAll / findById', () => {
  let db: Database.Database;
  let repo: ScheduleRepository;
  let personaIdA: string;
  let personaIdB: string;

  beforeEach(() => {
    db = createTestDb();
    repo = new ScheduleRepository(db);

    const personas = new PersonaRepository(db);
    personaIdA = uuid();
    personaIdB = uuid();
    personas.insert({
      id: personaIdA,
      name: `bot-a-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
    personas.insert({
      id: personaIdB,
      name: `bot-b-${uuid()}`,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });
  });

  afterEach(() => {
    db.close();
  });

  function makeSched(overrides: Partial<Parameters<ScheduleRepository['insert']>[0]> = {}) {
    return {
      id: uuid(),
      persona_id: personaIdA,
      thread_id: null,
      type: 'cron' as const,
      expression: '0 * * * *',
      payload: '{}',
      enabled: 1,
      last_run_at: null,
      next_run_at: null,
      ...overrides,
    };
  }

  describe('findAll()', () => {
    it('returns empty array when no schedules exist', () => {
      const result = repo.findAll();
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toEqual([]);
    });

    it('returns all schedules across personas', () => {
      repo.insert(makeSched({ persona_id: personaIdA }));
      repo.insert(makeSched({ persona_id: personaIdB }));
      repo.insert(makeSched({ persona_id: personaIdA }));

      const rows = repo.findAll()._unsafeUnwrap();
      expect(rows).toHaveLength(3);
    });
  });

  describe('findById()', () => {
    it('returns null for nonexistent id', () => {
      const result = repo.findById(uuid());
      expect(result.isOk()).toBe(true);
      expect(result._unsafeUnwrap()).toBeNull();
    });

    it('returns the schedule row for a valid id', () => {
      const input = makeSched();
      repo.insert(input);

      const row = repo.findById(input.id)._unsafeUnwrap();
      expect(row).not.toBeNull();
      expect(row!.id).toBe(input.id);
      expect(row!.persona_id).toBe(input.persona_id);
      expect(row!.expression).toBe(input.expression);
    });
  });
});
