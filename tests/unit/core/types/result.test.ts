import { describe, it, expect } from 'vitest';
import { ok, err } from 'neverthrow';
import {
  okVoid,
  errFromError,
  resultFromPromise,
} from '../../../../src/core/types/result.js';
import { ConfigError, DbError } from '../../../../src/core/errors/error-types.js';

describe('okVoid()', () => {
  it('returns an Ok result', () => {
    const result = okVoid();
    expect(result.isOk()).toBe(true);
  });

  it('Ok value is undefined (void)', () => {
    const result = okVoid();
    if (result.isOk()) {
      expect(result.value).toBeUndefined();
    }
  });
});

describe('errFromError()', () => {
  it('returns an Err result', () => {
    const error = new ConfigError('bad config');
    const result = errFromError(error);
    expect(result.isErr()).toBe(true);
  });

  it('Err value is the original error', () => {
    const error = new DbError('connection lost');
    const result = errFromError(error);
    if (result.isErr()) {
      expect(result.error).toBe(error);
    }
  });

  it('preserves error code', () => {
    const error = new ConfigError('missing field');
    const result = errFromError(error);
    if (result.isErr()) {
      expect(result.error.code).toBe('CONFIG_ERROR');
    }
  });
});

describe('resultFromPromise()', () => {
  it('returns Ok when promise resolves', async () => {
    const result = await resultFromPromise(
      Promise.resolve(42),
      (e) => new ConfigError(String(e)),
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(42);
    }
  });

  it('returns Err when promise rejects', async () => {
    const result = await resultFromPromise(
      Promise.reject(new Error('boom')),
      (e) => new DbError(e instanceof Error ? e.message : String(e)),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBeInstanceOf(DbError);
      expect(result.error.message).toBe('boom');
    }
  });

  it('passes the thrown value to errorMapper', async () => {
    const sentinel = { custom: true };
    const result = await resultFromPromise(
      Promise.reject(sentinel),
      (e) => new ConfigError(JSON.stringify(e)),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe('{"custom":true}');
    }
  });

  it('returns a ResultAsync (thenable)', () => {
    const ra = resultFromPromise(Promise.resolve('x'), (e) => new ConfigError(String(e)));
    expect(typeof ra.then).toBe('function');
  });
});

describe('re-exported neverthrow primitives', () => {
  it('ok() produces an Ok result', () => {
    const result = ok(1);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(1);
    }
  });

  it('err() produces an Err result', () => {
    const result = err('something went wrong');
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toBe('something went wrong');
    }
  });
});
