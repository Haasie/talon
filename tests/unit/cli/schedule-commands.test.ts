import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { ScheduleRepository } from '../../../src/core/database/repositories/schedule-repository.js';
import { PersonaRepository } from '../../../src/core/database/repositories/persona-repository.js';
import { ChannelRepository } from '../../../src/core/database/repositories/channel-repository.js';
import { addSchedule } from '../../../src/cli/commands/add-schedule.js';
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

// ---------------------------------------------------------------------------
// addSchedule()
// ---------------------------------------------------------------------------

describe('addSchedule()', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  /** Seeds a persona and channel, returning their names. */
  function seedPersonaAndChannel(
    personaName = 'test-bot',
    channelName = 'test-channel',
  ): { personaName: string; channelName: string } {
    const personas = new PersonaRepository(db);
    personas.insert({
      id: uuid(),
      name: personaName,
      model: 'claude-sonnet-4-6',
      system_prompt_file: null,
      skills: '[]',
      capabilities: '{}',
      mounts: '[]',
      max_concurrent: null,
    });

    const channels = new ChannelRepository(db);
    channels.insert({
      id: uuid(),
      type: 'telegram',
      name: channelName,
      config: '{}',
      credentials_ref: null,
      enabled: 1,
    });

    return { personaName, channelName };
  }

  it('creates a schedule with correct fields', () => {
    const { personaName, channelName } = seedPersonaAndChannel();

    const result = addSchedule({
      persona: personaName,
      channel: channelName,
      cron: '0 9 * * *',
      label: 'morning-report',
      prompt: 'Generate a morning report',
      db,
    });

    expect(result.id).toBeDefined();
    expect(result.threadId).toBeDefined();
    expect(result.expression).toBe('0 9 * * *');
    expect(result.label).toBe('morning-report');
    expect(result.nextRunAt).toBeGreaterThan(Date.now() - 1000);

    // Verify the schedule was actually inserted in the DB.
    const schedRepo = new ScheduleRepository(db);
    const row = schedRepo.findById(result.id)._unsafeUnwrap();
    expect(row).not.toBeNull();
    expect(row!.expression).toBe('0 9 * * *');
    expect(row!.enabled).toBe(1);
    expect(row!.thread_id).toBe(result.threadId);

    const payload = JSON.parse(row!.payload);
    expect(payload.label).toBe('morning-report');
    expect(payload.prompt).toBe('Generate a morning report');
  });

  it('reuses existing schedule thread for same persona+channel', () => {
    const { personaName, channelName } = seedPersonaAndChannel();

    const first = addSchedule({
      persona: personaName,
      channel: channelName,
      cron: '0 9 * * *',
      label: 'first',
      prompt: 'First prompt',
      db,
    });

    const second = addSchedule({
      persona: personaName,
      channel: channelName,
      cron: '0 18 * * *',
      label: 'second',
      prompt: 'Second prompt',
      db,
    });

    expect(second.threadId).toBe(first.threadId);
    expect(second.id).not.toBe(first.id);
  });

  it('throws for unknown persona', () => {
    seedPersonaAndChannel();

    expect(() =>
      addSchedule({
        persona: 'nonexistent-bot',
        channel: 'test-channel',
        cron: '0 9 * * *',
        label: 'test',
        prompt: 'test',
        db,
      }),
    ).toThrow('Unknown persona: "nonexistent-bot"');
  });

  it('throws for unknown channel', () => {
    seedPersonaAndChannel();

    expect(() =>
      addSchedule({
        persona: 'test-bot',
        channel: 'nonexistent-channel',
        cron: '0 9 * * *',
        label: 'test',
        prompt: 'test',
        db,
      }),
    ).toThrow('Unknown channel: "nonexistent-channel"');
  });

  it('throws for invalid cron expression', () => {
    seedPersonaAndChannel();

    expect(() =>
      addSchedule({
        persona: 'test-bot',
        channel: 'test-channel',
        cron: 'not-a-cron',
        label: 'test',
        prompt: 'test',
        db,
      }),
    ).toThrow('Invalid cron expression: "not-a-cron"');
  });
});
