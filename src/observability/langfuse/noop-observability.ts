import type {
  ObservationHandle,
  ObservationInput,
  ObservabilityService,
} from './observability-types.js';

const NOOP_OBSERVATION: ObservationHandle = {
  update: () => {},
  getTraceparent: () => null,
};

export class NoopObservabilityService implements ObservabilityService {
  async observe<T>(
    _input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    return await fn(NOOP_OBSERVATION);
  }

  async observeWithTraceparent<T>(
    _traceparent: string | null | undefined,
    _input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    return await fn(NOOP_OBSERVATION);
  }

  async shutdown(): Promise<void> {}
}
