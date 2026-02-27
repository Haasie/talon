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

program.parse();
