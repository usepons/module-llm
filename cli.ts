import type { Command } from 'npm:commander@^12';
import * as clack from 'npm:@clack/prompts@^0.10';
import chalk from 'npm:chalk@^5';
import { ProviderRegistry } from './src/registry.ts';
import { runChatSession } from './src/chat/session.ts';
import type { ProviderConfig } from './src/providers/types.ts';
import type { Logger } from 'jsr:@pons/sdk@^0.3';

/**
 * Build a ProviderRegistry from config providers.
 */
function buildRegistry(providers: Record<string, ProviderConfig>): ProviderRegistry {
  const silentLogger: Logger = {
    level: 'info',
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() { return silentLogger; },
  };

  const registry = new ProviderRegistry(silentLogger);
  for (const [id, config] of Object.entries(providers)) {
    try {
      registry.register(id, config);
    } catch {
      // skip failed providers
    }
  }
  return registry;
}

/**
 * Parse provider config from environment variables.
 */
function detectProviders(): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};
  const env = Deno.env.toObject();

  if (env.ANTHROPIC_API_KEY) {
    providers.anthropic = { apiKey: env.ANTHROPIC_API_KEY };
  }
  if (env.OPENAI_API_KEY) {
    providers.openai = { apiKey: env.OPENAI_API_KEY };
  }
  if (env.DEEPSEEK_API_KEY) {
    providers.deepseek = { apiKey: env.DEEPSEEK_API_KEY };
  }
  if (env.GITHUB_TOKEN || env.GH_TOKEN) {
    providers['github-copilot'] = { token: env.GITHUB_TOKEN || env.GH_TOKEN };
  }

  // Always try ollama (local)
  providers.ollama = { baseUrl: env.OLLAMA_HOST || 'http://localhost:11434' };

  return providers;
}

export function init(program: Command): void {
  const llm = program
    .command('llm')
    .description('LLM provider management and chat');

  // ─── pons llm chat ──────────────────────────────────────
  llm
    .command('chat')
    .description('Start an interactive chat session with an LLM provider')
    .option('-p, --provider <id>', 'Provider to use')
    .option('-m, --model <id>', 'Model to use')
    .option('-s, --system <prompt>', 'System prompt')
    .action(async (opts: { provider?: string; model?: string; system?: string }) => {
      clack.intro(chalk.bold('LLM Chat'));

      const providers = detectProviders();
      const registry = buildRegistry(providers);
      const available = registry.listProviders();

      if (available.length === 0) {
        clack.log.error('No LLM providers configured. Set API keys via environment variables or Pons config.');
        clack.outro('');
        return;
      }

      // Select provider
      let providerId = opts.provider;
      if (!providerId) {
        const selected = await clack.select({
          message: 'Select provider',
          options: available.map(id => ({ value: id, label: id })),
        });
        if (clack.isCancel(selected)) { clack.outro('Cancelled'); return; }
        providerId = selected as string;
      }

      const provider = registry.get(providerId);
      if (!provider) {
        clack.log.error(`Provider "${providerId}" not found`);
        clack.outro('');
        return;
      }

      // Select model
      let modelId = opts.model;
      if (!modelId) {
        const spinner = clack.spinner();
        spinner.start('Fetching models...');
        const models = await provider.listModels();
        spinner.stop('Models loaded');

        if (models.length === 0) {
          clack.log.warn('No models found. Enter a model ID manually.');
          const manual = await clack.text({ message: 'Model ID', placeholder: 'e.g. gpt-4o' });
          if (clack.isCancel(manual)) { clack.outro('Cancelled'); return; }
          modelId = manual as string;
        } else {
          const selected = await clack.select({
            message: 'Select model',
            options: models.map(m => ({ value: m.id, label: m.name || m.id })),
          });
          if (clack.isCancel(selected)) { clack.outro('Cancelled'); return; }
          modelId = selected as string;
        }
      }

      await runChatSession({
        provider,
        model: modelId,
        system: opts.system,
      });

      clack.outro(chalk.dim('Goodbye!'));
    });

  // ─── pons llm providers ─────────────────────────────────
  llm
    .command('providers')
    .description('List configured LLM providers')
    .action(async () => {
      const providers = detectProviders();
      const registry = buildRegistry(providers);
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
