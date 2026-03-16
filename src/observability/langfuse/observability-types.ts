import type { ObservationLevel } from '@langfuse/tracing';

export type TalonObservationType = 'agent' | 'generation' | 'tool' | 'retriever';

export interface ObservationTraceInput {
  userId?: string;
  sessionId?: string;
  metadata?: Record<string, string>;
  version?: string;
  tags?: string[];
  name?: string;
  input?: unknown;
  output?: unknown;
}

export interface ObservationInput {
  type: TalonObservationType;
  name: string;
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  statusMessage?: string;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  trace?: ObservationTraceInput;
}

export interface ObservationUpdate {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: ObservationLevel;
  statusMessage?: string;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  costDetails?: Record<string, number>;
  trace?: {
    input?: unknown;
    output?: unknown;
  };
}

export interface ObservationHandle {
  update(update: ObservationUpdate): void;
  getTraceparent(): string | null;
}

export interface ObservabilityService {
  observe<T>(
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T>;
  observeWithTraceparent<T>(
    traceparent: string | null | undefined,
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T>;
  shutdown(): Promise<void>;
}
