import { OpenAIProvider } from './openai.ts';
import type { ProviderConfig } from './types.ts';

export class OpenRouterProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(
      { ...config, baseUrl: config.baseUrl || 'https://openrouter.ai/api/v1' },
      'openrouter',
      'OpenRouter',
    );
  }
}
