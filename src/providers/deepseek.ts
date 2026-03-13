import { OpenAIProvider } from './openai.ts';
import type { ProviderConfig } from './types.ts';

export class DeepseekProvider extends OpenAIProvider {
  constructor(config: ProviderConfig) {
    super(
      { ...config, baseUrl: config.baseUrl || 'https://api.deepseek.com/v1' },
      'deepseek',
      'Deepseek',
    );
  }
}
