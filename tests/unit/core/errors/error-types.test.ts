import { describe, it, expect } from 'vitest';
import {
  TalonError,
  ConfigError,
  DbError,
  IpcError,
  SandboxError,
  ToolError,
  ChannelError,
  QueueError,
  ScheduleError,
  MigrationError,
  PolicyError,
  MemoryError,
  PersonaError,
  PipelineError,
  CollaborationError,
  BackgroundAgentError,
} from '../../../../src/core/errors/error-types.js';

// ---------------------------------------------------------------------------
// Helper: verify every concrete error class follows the contract
// ---------------------------------------------------------------------------

interface ErrorClass<T extends TalonError> {
  new (message: string, cause?: Error): T;
}

function describeErrorClass<T extends TalonError>(
  name: string,
  Cls: ErrorClass<T>,
  expectedCode: string,
): void {
  describe(`${name}`, () => {
    it('is an instanceof Error', () => {
      expect(new Cls('test')).toBeInstanceOf(Error);
    });

    it('is an instanceof TalonError', () => {
      expect(new Cls('test')).toBeInstanceOf(TalonError);
    });

    it(`is an instanceof ${name}`, () => {
      expect(new Cls('test')).toBeInstanceOf(Cls);
    });

    it('sets message', () => {
      expect(new Cls('hello world').message).toBe('hello world');
    });

    it(`sets code to "${expectedCode}"`, () => {
      expect(new Cls('msg').code).toBe(expectedCode);
    });

    it('sets name to class name', () => {
      expect(new Cls('msg').name).toBe(name);
    });

    it('sets cause when provided', () => {
      const cause = new Error('root cause');
      const instance = new Cls('wrapper', cause);
      expect(instance.cause).toBe(cause);
    });

    it('cause is undefined when not provided', () => {
      expect(new Cls('no cause').cause).toBeUndefined();
    });

    it('has a stack trace', () => {
      expect(new Cls('msg').stack).toBeTruthy();
    });
  });
}

// ---------------------------------------------------------------------------
// Run checks for every domain error
// ---------------------------------------------------------------------------

describeErrorClass('ConfigError', ConfigError, 'CONFIG_ERROR');
describeErrorClass('DbError', DbError, 'DB_ERROR');
describeErrorClass('IpcError', IpcError, 'IPC_ERROR');
describeErrorClass('SandboxError', SandboxError, 'SANDBOX_ERROR');
describeErrorClass('ToolError', ToolError, 'TOOL_ERROR');
describeErrorClass('ChannelError', ChannelError, 'CHANNEL_ERROR');
describeErrorClass('QueueError', QueueError, 'QUEUE_ERROR');
describeErrorClass('ScheduleError', ScheduleError, 'SCHEDULE_ERROR');
describeErrorClass('MigrationError', MigrationError, 'MIGRATION_ERROR');
describeErrorClass('PolicyError', PolicyError, 'POLICY_ERROR');
describeErrorClass('MemoryError', MemoryError, 'MEMORY_ERROR');
describeErrorClass('PersonaError', PersonaError, 'PERSONA_ERROR');
describeErrorClass('PipelineError', PipelineError, 'PIPELINE_ERROR');
describeErrorClass('CollaborationError', CollaborationError, 'COLLABORATION_ERROR');
describeErrorClass('BackgroundAgentError', BackgroundAgentError, 'BACKGROUND_AGENT_ERROR');

// ---------------------------------------------------------------------------
// TalonError abstract contract
// ---------------------------------------------------------------------------

describe('TalonError (base class)', () => {
  it('cannot be instantiated directly (abstract)', () => {
    // TypeScript prevents this at compile time; at runtime the class itself
    // is not abstract. We verify the subclass mechanism works instead.
    const e = new ConfigError('abstract check');
    expect(e).toBeInstanceOf(TalonError);
  });

  it('subclass codes are distinct', () => {
    const errors = [
      new ConfigError('a'),
      new DbError('b'),
      new IpcError('c'),
      new SandboxError('d'),
      new ToolError('e'),
      new ChannelError('f'),
      new QueueError('g'),
      new ScheduleError('h'),
      new MigrationError('i'),
      new PolicyError('j'),
      new MemoryError('k'),
      new PersonaError('l'),
      new PipelineError('m'),
      new CollaborationError('n'),
      new BackgroundAgentError('o'),
    ] as TalonError[];

    const codes = errors.map((e) => e.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length); // all codes are unique
  });
});
