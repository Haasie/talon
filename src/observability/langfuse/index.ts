import type pino from 'pino';

import type { LangfuseConfig } from '../../core/config/config-types.js';
import type { ObservabilityService } from './observability-types.js';
import { LangfuseObservabilityService } from './langfuse-observability.js';
import { NoopObservabilityService } from './noop-observability.js';

export * from './observability-types.js';
export * from './noop-observability.js';
export * from './traceparent.js';
export * from './langfuse-observability.js';

export async function createObservabilityService(
  config: LangfuseConfig,
  logger: pino.Logger,
): Promise<ObservabilityService> {
  if (!config.enabled) {
    return new NoopObservabilityService();
  }

  try {
    return new LangfuseObservabilityService(config, logger);
  } catch (error) {
    logger.warn(
      { err: error },
      'observability: failed to initialize Langfuse, falling back to no-op',
    );
    return new NoopObservabilityService();
  }
}
