import { afterEach, describe, expect, it, vi } from 'vitest';
import pino from 'pino';

function createSilentLogger() {
  return pino({ level: 'silent' });
}

describe('createObservabilityService', () => {
  afterEach(() => {
    vi.resetModules();
    vi.doUnmock('../../../../src/observability/langfuse/langfuse-observability.js');
  });

  it('does not import the Langfuse runtime when observability is disabled', async () => {
    vi.doMock('../../../../src/observability/langfuse/langfuse-observability.js', () => {
      throw new Error('langfuse runtime should stay unloaded when disabled');
    });

    const { createObservabilityService } = await import(
      '../../../../src/observability/langfuse/index.js'
    );

    const service = await createObservabilityService(
      {
        enabled: false,
        baseUrl: 'https://cloud.langfuse.com',
        environment: 'test',
        exportMode: 'batched',
        flushAt: 20,
        flushIntervalSeconds: 5,
      } as any,
      createSilentLogger(),
    );

    expect(service.constructor.name).toBe('NoopObservabilityService');
  });
});
