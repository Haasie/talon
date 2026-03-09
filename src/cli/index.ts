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

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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
import { queuePurgeCommand } from './commands/queue-purge.js';
import { chatCommand } from './commands/chat.js';

// Load .env before anything else so ${VAR} substitution works in config.
const envPath = resolve(process.env.TALOND_ENV_FILE || '.env');
if (existsSync(envPath)) {
  try {
    process.loadEnvFile(envPath);
  } catch (cause) {
    process.stderr.write(`warning: failed to parse ${envPath}: ${cause instanceof Error ? cause.message : String(cause)}\n`);
  }
}

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

program
  .command('queue-purge')
  .description('Purge queue items by status (default: pending, failed, completed)')
  .option('--ipc-dir <path>', 'IPC directory (overrides config default)')
  .option('--timeout <ms>', 'Response timeout in milliseconds', '5000')
  .option('--statuses <list>', 'Comma-separated statuses to purge (pending,failed,completed,dead_letter,claimed,processing)')
  .option('--all', 'Purge all statuses including in-flight items')
  .action(async (opts: { ipcDir?: string; timeout: string; statuses?: string; all?: boolean }) => {
    await queuePurgeCommand({
      ipcDir: opts.ipcDir,
      timeoutMs: parseInt(opts.timeout, 10),
      statuses: opts.statuses?.split(',').map((s) => s.trim()),
      all: opts.all,
    });
  });

program
  .command('chat')
  .description('Connect to a Talon persona via terminal channel')
  .option('--host <host>', 'Terminal connector host', '127.0.0.1')
  .option('--port <port>', 'Terminal connector port', '7700')
  .option('--token <token>', 'Authentication token (or set TERMINAL_TOKEN env var)')
  .option('--client-id <id>', 'Client identity for persistent threads')
  .option('--persona <name>', 'Persona to connect to (overrides channel default)')
  .action(async (opts: { host: string; port: string; token?: string; clientId?: string; persona?: string }) => {
    const token = opts.token ?? process.env.TERMINAL_TOKEN;
    if (!token) {
      console.error('Error: --token is required (or set TERMINAL_TOKEN env var).');
      process.exit(1);
    }
    await chatCommand({
      host: opts.host,
      port: parseInt(opts.port, 10),
      token,
      clientId: opts.clientId,
      persona: opts.persona,
    });
  });

program.parse();
