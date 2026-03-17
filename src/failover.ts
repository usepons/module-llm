import type { LLMProvider, GenerateOptions, GenerateResult, StreamChunk, ModelInfo } from './providers/types.ts';
import type { Logger } from 'jsr:@pons/sdk@^0.3';

interface ProviderEntry {
  provider: LLMProvider;
  model: string;
}

export class FailoverProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;

  constructor(
    private primary: ProviderEntry,
    private fallbacks: ProviderEntry[],
    private logger: Logger,
    private onFailure?: (providerId: string, error: string) => void,
    private onSuccess?: (providerId: string) => void,
  ) {
    this.id = `failover:${primary.provider.id}`;
    this.name = `Failover(${primary.provider.name})`;
  }

  async generateText(options: GenerateOptions): Promise<GenerateResult> {
    const entries = [this.primary, ...this.fallbacks];
    let lastError: Error | undefined;

    for (const entry of entries) {
      try {
        const result = await entry.provider.generateText({ ...options, model: entry.model });
        this.onSuccess?.(entry.provider.id);
        return result;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn({ provider: entry.provider.id, error: lastError.message }, 'Provider failed, trying next');
        this.onFailure?.(entry.provider.id, lastError.message);
      }
    }
    throw lastError ?? new Error('All providers failed');
  }

  async *streamText(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entries = [this.primary, ...this.fallbacks];
    let lastError: Error | undefined;

    for (const entry of entries) {
      try {
        yield* entry.provider.streamText({ ...options, model: entry.model });
        this.onSuccess?.(entry.provider.id);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        this.logger.warn({ provider: entry.provider.id, error: lastError.message }, 'Stream provider failed, trying next');
        this.onFailure?.(entry.provider.id, lastError.message);
      }
    }
    throw lastError ?? new Error('All providers failed');
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.primary.provider.listModels();
  }

  isAvailable(): boolean {
    return this.primary.provider.isAvailable() || this.fallbacks.some(f => f.provider.isAvailable());
  }
}
