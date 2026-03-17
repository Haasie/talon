import type pino from 'pino';
import { context as otelContext, propagation as otelPropagation, trace as otelTrace } from '@opentelemetry/api';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import {
  type LangfuseAgent,
  type LangfuseChain,
  type LangfuseEvaluator,
  type LangfuseGeneration,
  type LangfuseGuardrail,
  propagateAttributes,
  type LangfuseRetriever,
  setLangfuseTracerProvider,
  startActiveObservation,
  type LangfuseObservationAttributes,
  type LangfuseSpan,
  type LangfuseTool,
} from '@langfuse/tracing';
import type { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

import type { LangfuseConfig } from '../../core/config/config-types.js';
import {
  type ObservationHandle,
  type ObservationInput,
  type ObservationUpdate,
  type ObservabilityService,
} from './observability-types.js';
import { parseTraceparent, serializeTraceparent } from './traceparent.js';

interface LangfuseObservabilityOptions {
  exporter?: SpanExporter;
  shouldExportSpan?: (params: { otelSpan: ReadableSpan }) => boolean;
}

type TalonLangfuseObservation =
  | LangfuseAgent
  | LangfuseChain
  | LangfuseEvaluator
  | LangfuseGeneration
  | LangfuseGuardrail
  | LangfuseRetriever
  | LangfuseSpan
  | LangfuseTool;

export class LangfuseObservabilityService implements ObservabilityService {
  private readonly provider: NodeTracerProvider;

  constructor(
    private readonly config: LangfuseConfig,
    private readonly logger: pino.Logger,
    options: LangfuseObservabilityOptions = {},
  ) {
    this.provider = new NodeTracerProvider({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: config.publicKey,
          secretKey: config.secretKey,
          baseUrl: config.baseUrl,
          environment: config.environment,
          release: config.release,
          exportMode: config.exportMode,
          flushAt: config.flushAt,
          flushInterval: config.flushIntervalSeconds,
          exporter: options.exporter,
          shouldExportSpan: options.shouldExportSpan,
        }),
      ],
    });

    this.provider.register();
    setLangfuseTracerProvider(this.provider);
  }

  async observe<T>(
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    return await this.observeInternal(undefined, input, fn);
  }

  async observeWithTraceparent<T>(
    traceparent: string | null | undefined,
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    return await this.observeInternal(traceparent, input, fn);
  }

  async shutdown(): Promise<void> {
    try {
      await this.provider.shutdown();
    } finally {
      setLangfuseTracerProvider(null);
      otelTrace.disable();
      otelContext.disable();
      otelPropagation.disable();
    }
  }

  private async observeInternal<T>(
    traceparent: string | null | undefined,
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    const parentSpanContext = parseTraceparent(traceparent);
    const runObservation = async (): Promise<T> =>
      await this.startTypedObservation(input, parentSpanContext, fn);

    if (!input.trace) {
      return await runObservation();
    }

    return await propagateAttributes(
      {
        userId: input.trace.userId,
        sessionId: input.trace.sessionId,
        metadata: input.trace.metadata,
        version: input.trace.version ?? this.config.release,
        tags: input.trace.tags,
        traceName: input.trace.name ?? input.name,
      },
      runObservation,
    );
  }

  private async startTypedObservation<T>(
    input: ObservationInput,
    parentSpanContext: import('@opentelemetry/api').SpanContext | null,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    const options = {
      parentSpanContext: parentSpanContext ?? undefined,
    };

    switch (input.type) {
      case 'agent':
        return await startActiveObservation(
          input.name,
          async (observation) => await this.runObservedCallback(observation, input, fn),
          { ...options, asType: 'agent' },
        );
      case 'generation':
        return await startActiveObservation(
          input.name,
          async (observation) => await this.runObservedCallback(observation, input, fn),
          { ...options, asType: 'generation' },
        );
      case 'tool':
        return await startActiveObservation(
          input.name,
          async (observation) => await this.runObservedCallback(observation, input, fn),
          { ...options, asType: 'tool' },
        );
      case 'retriever':
        return await startActiveObservation(
          input.name,
          async (observation) => await this.runObservedCallback(observation, input, fn),
          { ...options, asType: 'retriever' },
        );
      default:
        return await startActiveObservation(
          input.name,
          async (observation) => await this.runObservedCallback(observation, input, fn),
          options,
        );
    }
  }

  private async runObservedCallback<T>(
    observation: TalonLangfuseObservation,
    input: ObservationInput,
    fn: (observation: ObservationHandle) => Promise<T> | T,
  ): Promise<T> {
    this.applyUpdate(observation, input);

    return await fn({
      update: (update) => this.applyUpdate(observation, update),
      getTraceparent: () => serializeTraceparent(observation.otelSpan.spanContext()),
    });
  }

  private applyUpdate(
    observation: TalonLangfuseObservation,
    update: ObservationInput | ObservationUpdate,
  ): void {
    const attributes: LangfuseObservationAttributes = {
      environment: this.config.environment,
    };

    if ('input' in update && update.input !== undefined) {
      attributes.input = update.input;
    }
    if ('output' in update && update.output !== undefined) {
      attributes.output = update.output;
    }
    if ('metadata' in update && update.metadata !== undefined) {
      attributes.metadata = update.metadata;
    }
    if ('level' in update && update.level !== undefined) {
      attributes.level = update.level;
    }
    if ('statusMessage' in update && update.statusMessage !== undefined) {
      attributes.statusMessage = update.statusMessage;
    }
    if ('model' in update && update.model !== undefined) {
      attributes.model = update.model;
    }
    if ('modelParameters' in update && update.modelParameters !== undefined) {
      attributes.modelParameters = update.modelParameters;
    }
    if ('usageDetails' in update && update.usageDetails !== undefined) {
      attributes.usageDetails = update.usageDetails;
    }
    if ('costDetails' in update && update.costDetails !== undefined) {
      attributes.costDetails = update.costDetails;
    }

    observation.update(attributes);

    if (update.trace && (update.trace.input !== undefined || update.trace.output !== undefined)) {
      observation.setTraceIO({
        ...(update.trace.input !== undefined ? { input: update.trace.input } : {}),
        ...(update.trace.output !== undefined ? { output: update.trace.output } : {}),
      });
    }
  }
}
