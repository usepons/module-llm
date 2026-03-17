import type { Logger } from 'jsr:@pons/sdk@^0.3';
import type { LLMProvider, ModelInfo, ProviderConfig } from './providers/types.ts';
import { AnthropicProvider } from './providers/anthropic.ts';
import { OpenAIProvider } from './providers/openai.ts';
import { DeepseekProvider } from './providers/deepseek.ts';
import { OllamaProvider } from './providers/ollama.ts';
import { ClaudeCodeProvider } from './providers/claude-code.ts';
import { GitHubCopilotProvider } from './providers/github-copilot.ts';

type ProviderFactory = (config: ProviderConfig) => LLMProvider;

const BUILT_IN_FACTORIES: Record<string, ProviderFactory> = {
  anthropic: (c) => new AnthropicProvider(c),
  openai: (c) => new OpenAIProvider(c),
  deepseek: (c) => new DeepseekProvider(c),
  ollama: (c) => new OllamaProvider(c),
  'claude-code': (c) => new ClaudeCodeProvider(c),
  'github-copilot': (c) => new GitHubCopilotProvider(c),
};

export class ProviderRegistry {
  private providers = new Map<string, LLMProvider>();
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  register(id: string, config: ProviderConfig): void {
    const factory = BUILT_IN_FACTORIES[id];
    if (factory) {
      this.providers.set(id, factory(config));
    } else {
      this.providers.set(id, new OpenAIProvider(config, id, id));
    }
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  async listModels(providerId: string): Promise<ModelInfo[]> {
    const provider = this.providers.get(providerId);
    if (!provider) return [];
    try {
      return await provider.listModels();
    } catch (err) {
      this.logger.warn({ err, provider: providerId }, 'Failed to list models');
      return [];
    }
  }

  async listAllModels(): Promise<ModelInfo[]> {
    const all: ModelInfo[] = [];
    for (const [id, provider] of this.providers) {
      try {
        const models = await provider.listModels();
        all.push(...models);
      } catch (err) {
        this.logger.warn({ err, provider: id }, 'Failed to list models');
      }
    }
    return all;
  }
}
