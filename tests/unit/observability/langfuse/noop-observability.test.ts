import { describe, it, expect } from 'vitest';

import { NoopObservabilityService } from '../../../../src/observability/langfuse/noop-observability.js';

describe('NoopObservabilityService', () => {
  it('executes observe callbacks without emitting trace context', async () => {
    const service = new NoopObservabilityService();

    const result = await service.observe(
      {
        type: 'agent',
        name: 'foreground-run',
        input: { prompt: 'hello' },
      },
      async (observation) => {
        observation.update({
          output: { text: 'ok' },
          metadata: { runId: 'run-123' },
        });
        return observation.getTraceparent();
      },
    );

    expect(result).toBeNull();
  });

  it('treats explicit parent traceparents as a no-op', async () => {
    const service = new NoopObservabilityService();

    const result = await service.observeWithTraceparent(
      '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      {
        type: 'tool',
        name: 'channel.send',
      },
      async (observation) => observation.getTraceparent(),
    );

    expect(result).toBeNull();
  });

  it('shuts down cleanly', async () => {
    const service = new NoopObservabilityService();

    await expect(service.shutdown()).resolves.toBeUndefined();
  });
});
