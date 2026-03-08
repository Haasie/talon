/**
 * Channel setup — wires channel connectors to the registry, database, and pipeline.
 *
 * Creates connector instances from config, seeds channel rows in the DB,
 * creates default channel→persona bindings, and registers inbound message
 * handlers. Used by both bootstrap and hot-reload.
 */

import { v4 as uuidv4 } from 'uuid';
import type pino from 'pino';
import type { TalondConfig } from '../core/config/config-types.js';
import type { ChannelRepository } from '../core/database/repositories/channel-repository.js';
import type { BindingRepository } from '../core/database/repositories/binding-repository.js';
import type { PersonaRepository } from '../core/database/repositories/persona-repository.js';
import type { ChannelRegistry } from './channel-registry.js';
import type { InboundEvent } from './channel-types.js';
import type { MessagePipeline } from '../pipeline/message-pipeline.js';
import { createConnector } from '../daemon/channel-factory.js';

/** Dependencies needed to register channels. */
export interface ChannelSetupDeps {
  readonly channelRepo: ChannelRepository;
  readonly bindingRepo: BindingRepository;
  readonly personaRepo: PersonaRepository;
  readonly messagePipeline: MessagePipeline;
  readonly logger: pino.Logger;
}

/**
 * Registers all enabled channels from config into the registry.
 *
 * For each enabled channel:
 * 1. Creates a connector instance via the channel factory
 * 2. Ensures a channel row exists in the database
 * 3. Creates a default channel→persona binding if none exists
 * 4. Wires the inbound message handler to the pipeline
 * 5. Registers the connector in the registry
 *
 * @param config          - Full daemon config (channels + personas).
 * @param channelRegistry - Registry to register connectors into.
 * @param deps            - Database repos, pipeline, and logger.
 */
export function registerChannels(
  config: TalondConfig,
  channelRegistry: ChannelRegistry,
  deps: ChannelSetupDeps,
): void {
  const { channelRepo, bindingRepo, personaRepo, messagePipeline, logger } = deps;

  for (const channelConfig of config.channels.filter((channel) => channel.enabled)) {
    const connector = createConnector(
      channelConfig.type,
      channelConfig.name,
      channelConfig.config,
      logger,
    );
    if (connector === null) {
      logger.warn(
        { channelName: channelConfig.name, channelType: channelConfig.type },
        'channel-setup: unknown connector type; skipping',
      );
      continue;
    }

    // Ensure the channel exists in the database.
    const existing = channelRepo.findByName(channelConfig.name);
    let channelId: string;
    if (existing.isOk() && existing.value !== null) {
      channelId = existing.value.id;
    } else {
      channelId = uuidv4();
      channelRepo.insert({
        id: channelId,
        type: channelConfig.type,
        name: channelConfig.name,
        config: JSON.stringify(channelConfig.config),
        credentials_ref: null,
        enabled: 1,
      });
    }

    // Create a default binding to the first persona if none exists.
    if (config.personas.length > 0) {
      const defaultBinding = bindingRepo.findDefaultForChannel(channelId);
      if (defaultBinding.isOk() && defaultBinding.value === null) {
        const personaResult = personaRepo.findByName(config.personas[0].name);
        if (personaResult.isOk() && personaResult.value !== null) {
          bindingRepo.insert({
            id: uuidv4(),
            channel_id: channelId,
            thread_id: null,
            persona_id: personaResult.value.id,
            is_default: 1,
          });
          logger.info(
            { channelName: channelConfig.name, persona: config.personas[0].name },
            'channel-setup: created default channel->persona binding',
          );
        }
      }
    }

    connector.onMessage(async (event: InboundEvent) => {
      const pipelineResult = await messagePipeline.handleInboundEvent(event);
      if (pipelineResult.isErr()) {
        logger.error(
          { channelName: event.channelName, err: pipelineResult.error.message },
          'channel-setup: inbound message pipeline failed',
        );
      }
    });

    channelRegistry.register(connector);
  }
}
