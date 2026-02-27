/**
 * talonctl — Talon CLI control utility entry point.
 *
 * Provides sub-commands for managing the talond daemon:
 *   - status   Show daemon health, active containers, queue depth
 *   - migrate  Apply database migrations (standalone, no daemon needed)
 *   - backup   Backup database (standalone, no daemon needed)
 *   - reload   Hot-reload configuration (communicates with daemon)
 *   - doctor   Check system requirements and configuration (standalone)
 */

import { Command } from 'commander';

import { statusCommand } from './commands/status.js';
import { migrateCommand } from './commands/migrate.js';
import { backupCommand } from './commands/backup.js';
import { reloadCommand } from './commands/reload.js';
import { doctorCommand } from './commands/doctor.js';
import { setupCommand } from './commands/setup.js';
import { addChannelCommand } from './commands/add-channel.js';
import { addPersonaCommand } from './commands/add-persona.js';
import { addSkillCommand } from './commands/add-skill.js';

const program = new Command();

program
  .name('talonctl')
  .description('CLI for managing the talond daemon')
  .version('0.1.0');

program
  .command('status')
  .description('Show daemon health, active containers, queue depth')
  .option('--ipc-dir <path>', 'IPC directory (overrides config default)')
  .option('--timeout <ms>', 'Response timeout in milliseconds', '5000')
  .action(async (opts: { ipcDir?: string; timeout: string }) => {
    await statusCommand({
      ipcDir: opts.ipcDir,
      timeoutMs: parseInt(opts.timeout, 10),
    });
  });

program
  .command('migrate')
  .description('Apply database migrations')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action((opts: { config: string }) => {
    migrateCommand({ configPath: opts.config });
  });

program
  .command('backup')
  .description('Backup database and data directory')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .option('--output <path>', 'Backup output path (overrides default)')
  .action(async (opts: { config: string; output?: string }) => {
    await backupCommand({
      configPath: opts.config,
      backupPath: opts.output,
    });
  });

program
  .command('reload')
  .description('Hot-reload configuration without restarting')
  .option('--ipc-dir <path>', 'IPC directory (overrides config default)')
  .option('--timeout <ms>', 'Response timeout in milliseconds', '5000')
  .action(async (opts: { ipcDir?: string; timeout: string }) => {
    await reloadCommand({
      ipcDir: opts.ipcDir,
      timeoutMs: parseInt(opts.timeout, 10),
    });
  });

program
  .command('doctor')
  .description('Check system requirements and configuration')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { config: string }) => {
    await doctorCommand({ configPath: opts.config });
  });

program
  .command('setup')
  .description('First-time setup: detect environment, create directories, generate config')
  .option('--config <path>', 'Path to write talond.yaml', 'talond.yaml')
  .option('--data-dir <path>', 'Data directory path', 'data')
  .action(async (opts: { config: string; dataDir: string }) => {
    await setupCommand({
      configPath: opts.config,
      dataDir: opts.dataDir,
    });
  });

program
  .command('add-channel')
  .description('Add a channel connector to talond.yaml')
  .requiredOption('--name <name>', 'Unique channel name (e.g. my-telegram)')
  .requiredOption('--type <type>', 'Connector type (e.g. telegram, slack, discord)')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; type: string; config: string }) => {
    await addChannelCommand({
      name: opts.name,
      type: opts.type,
      configPath: opts.config,
    });
  });

program
  .command('add-persona')
  .description('Scaffold a persona directory and add it to talond.yaml')
  .requiredOption('--name <name>', 'Persona name (e.g. assistant)')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; config: string }) => {
    await addPersonaCommand({
      name: opts.name,
      configPath: opts.config,
    });
  });

program
  .command('add-skill')
  .description('Scaffold a skill directory and add it to a persona in talond.yaml')
  .requiredOption('--name <name>', 'Skill name (e.g. web-search)')
  .requiredOption('--persona <persona>', 'Persona to attach the skill to')
  .option('--config <path>', 'Path to talond.yaml', 'talond.yaml')
  .action(async (opts: { name: string; persona: string; config: string }) => {
    await addSkillCommand({
      name: opts.name,
      personaName: opts.persona,
      configPath: opts.config,
    });
  });

program.parse();
