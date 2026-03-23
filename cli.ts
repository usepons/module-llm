import type { Command } from 'npm:commander@^12';
import * as clack from 'npm:@clack/prompts@^0.10';
import chalk from 'npm:chalk@^5';
import { ProviderRegistry } from './src/registry.ts';
import { runChatSession } from './src/chat/session.ts';
import type { ProviderConfig } from './src/providers/types.ts';
import type { Logger } from 'jsr:@pons/sdk@^0.3';

export function init(program: Command): void {
  const llm = program
    .command('llm')
    .description('LLM provider management');

  // ─── pons llm providers ─────────────────────────────────
  llm
    .command('providers')
    .description('List configured LLM providers')
    .action(async () => {
      
      const registry = new ProviderRegistry();


      const available = registry.listProviders();

      if (available.length === 0) {
        console.log(chalk.yellow('No providers configured'));
        return;
      }

      console.log(chalk.bold('\nConfigured Providers:\n'));
      for (const id of available) {
        const provider = registry.get(id);
        if (provider) {
          const status = provider.isAvailable() ? chalk.green('●') : chalk.red('●');
          console.log(`  ${status} ${chalk.bold(provider.name)} (${id})`);
        }
      }
      console.log();
    });

  // ─── pons llm models ────────────────────────────────────
  llm
    .command('models')
    .description('List available models across all providers')
    .option('-p, --provider <id>', 'Filter by provider')
    .action(async (opts: { provider?: string }) => {
      const providers = detectProviders();
      const registry = buildRegistry(providers);

      const spinner = clack.spinner();
      spinner.start('Fetching models...');

      const models = opts.provider
        ? await registry.listModels(opts.provider)
        : await registry.listAllModels();

      spinner.stop(`Found ${models.length} models`);

      if (models.length === 0) {
        console.log(chalk.yellow('No models found'));
        return;
      }

      const grouped = new Map<string, typeof models>();
      for (const m of models) {
        const list = grouped.get(m.provider) ?? [];
        list.push(m);
        grouped.set(m.provider, list);
      }

      console.log();
      for (const [provider, providerModels] of grouped) {
        console.log(chalk.bold(`  ${provider}:`));
        for (const m of providerModels) {
          const ctx = m.contextWindow ? chalk.dim(` (${(m.contextWindow / 1000).toFixed(0)}k ctx)`) : '';
          console.log(`    ${chalk.cyan(m.id)}${ctx}`);
        }
        console.log();
      }
    });

  // ─── pons llm usage ─────────────────────────────────────
  llm
    .command('usage')
    .description('Show token usage and cost summary')
    .action(() => {
      console.log(chalk.yellow('Usage tracking requires a running kernel session.'));
      console.log(chalk.dim('Start the kernel with `pons start` to track usage.'));
    });
}
