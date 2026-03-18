import type {
  ObservationHandle,
  ObservationInput,
  ObservabilityService,
  StartedObservationHandle,
} from './observability-types.js';

const NOOP_OBSERVATION: ObservationHandle = {
  update: () => {},
  getTraceparent: () => null,
};

const NOOP_STARTED_OBSERVATION: StartedObservationHandle = {
  ...NOOP_OBSERVATION,
  end: () => {},
};

export class NoopObservabilityService implements ObservabilityService {
  start(_input: ObservationInput): StartedObservationHandle {
    return NOOP_STARTED_OBSERVATION;
  }

  startWithTraceparent(
    _traceparent: string | null | undefined,
    _input: ObservationInput,
  ): StartedObservationHandle {
    return NOOP_STARTED_OBSERVATION;
  }

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
