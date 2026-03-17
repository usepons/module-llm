import type { LLMProvider, GenerateOptions, GenerateResult, StreamChunk, ModelInfo, ProviderConfig } from './types.ts';

export class ClaudeCodeProvider implements LLMProvider {
  readonly id = 'claude-code';
  readonly name = 'Claude Code';
  private apiKey: string;
  private enabled: boolean;

  constructor(config: ProviderConfig) {
    this.apiKey = config.apiKey || '';
    this.enabled = (config as any).enabled === true;
  }

  static isAvailable(): boolean {
    try {
      const command = new Deno.Command('claude', { args: ['--version'], stdout: 'null', stderr: 'null' });
      const result = command.outputSync();
      return result.success;
    } catch {
      return false;
    }
  }

  async generateText(options: GenerateOptions): Promise<GenerateResult> {
    if (!this.enabled) {
      throw new Error('ClaudeCodeProvider is disabled. Set enabled: true in provider config to use it.');
    }
    const lastMessage = options.messages[options.messages.length - 1];
    const prompt = lastMessage?.content ?? '';

    const args = ['--print', '--output-format', 'json']; // PONS-001 safety: --print disables tool use and code execution
    if (options.system) {
      args.push('--system-prompt', options.system);
    }
    // if (options.maxTokens) {
    //   args.push('--max-tokens', String(options.maxTokens));
    // }
    args.push('--', prompt);

    const command = new Deno.Command('claude', {
      args,
      stdout: 'piped',
      stderr: 'piped',
      env: this.apiKey ? { ANTHROPIC_API_KEY: this.apiKey } : undefined,
    });

    const output = await command.output();
    if (!output.success) {
      const stderr = new TextDecoder().decode(output.stderr);
      throw new Error(`Claude Code failed: ${stderr}`);
    }

    const text = new TextDecoder().decode(output.stdout);

    try {
      const json = JSON.parse(text) as { result?: string; content?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      const content = json.result || json.content || text;
      return {
        content,
        usage: {
          promptTokens: json.usage?.input_tokens ?? 0,
          completionTokens: json.usage?.output_tokens ?? 0,
          totalTokens: (json.usage?.input_tokens ?? 0) + (json.usage?.output_tokens ?? 0),
        },
        model: 'claude-code',
        finishReason: 'stop',
      };
    } catch {
      return {
        content: text.trim(),
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        model: 'claude-code',
        finishReason: 'stop',
      };
    }
  }

  async *streamText(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const result = await this.generateText(options);
    yield { type: 'text', text: result.content };
    yield { type: 'usage', usage: result.usage };
    yield { type: 'done' };
  }

  async listModels(): Promise<ModelInfo[]> {
    return [
      { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: this.id },
    ];
  }

  isAvailable(): boolean {
    return ClaudeCodeProvider.isAvailable();
  }
}
