import Anthropic from 'npm:@anthropic-ai/sdk@^0.39';
import type { LLMProvider, GenerateOptions, GenerateResult, StreamChunk, ModelInfo, ProviderConfig, Message, ToolCall } from './types.ts';

const ANTHROPIC_MODELS: ModelInfo[] = [
  { id: 'claude-opus-4-6', name: 'Claude Opus 4.6', provider: 'anthropic', contextWindow: 200000 },
  { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: 'anthropic', contextWindow: 200000 },
  { id: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', provider: 'anthropic', contextWindow: 200000 },
];

export class AnthropicProvider implements LLMProvider {
  readonly id = 'anthropic';
  readonly name = 'Anthropic';
  private client: Anthropic;

  constructor(config: ProviderConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    });
  }

  async generateText(options: GenerateOptions): Promise<GenerateResult> {
    const response = await this.client.messages.create({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: this.buildMessages(options.messages),
      ...(options.system ? { system: options.system } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.tools?.length ? {
        tools: options.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool['input_schema'],
        })),
      } : {}),
    });

    const textBlock = response.content.find(b => b.type === 'text');
    const toolCalls: ToolCall[] = response.content
      .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
      .map(b => ({
        id: b.id,
        name: b.name,
        arguments: b.input as Record<string, unknown>,
      }));

    return {
      content: textBlock?.text ?? '',
      usage: {
        promptTokens: response.usage.input_tokens,
        completionTokens: response.usage.output_tokens,
        totalTokens: response.usage.input_tokens + response.usage.output_tokens,
      },
      model: response.model,
      finishReason: response.stop_reason ?? 'unknown',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *streamText(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const stream = this.client.messages.stream({
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      messages: this.buildMessages(options.messages),
      ...(options.system ? { system: options.system } : {}),
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options.tools?.length ? {
        tools: options.tools.map(t => ({
          name: t.name,
          description: t.description,
          input_schema: t.parameters as Anthropic.Tool['input_schema'],
        })),
      } : {}),
    });

    // Track current tool_use block being streamed
    let currentToolId = '';
    let currentToolName = '';
    let currentToolArgs = '';

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        yield { type: 'text', text: event.delta.text };
      }

      // Tool use streaming
      if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
        currentToolId = event.content_block.id;
        currentToolName = event.content_block.name;
        currentToolArgs = '';
      }

      if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
        currentToolArgs += event.delta.partial_json;
      }

      if (event.type === 'content_block_stop' && currentToolId) {
        yield {
          type: 'tool_call',
          toolCall: {
            id: currentToolId,
            name: currentToolName,
            arguments: JSON.parse(currentToolArgs || '{}'),
          },
        };
        currentToolId = '';
        currentToolName = '';
        currentToolArgs = '';
      }
    }

    const finalMessage = await stream.finalMessage();
    yield {
      type: 'usage',
      usage: {
        promptTokens: finalMessage.usage.input_tokens,
        completionTokens: finalMessage.usage.output_tokens,
        totalTokens: finalMessage.usage.input_tokens + finalMessage.usage.output_tokens,
      },
    };

    yield { type: 'done' };
  }

  async listModels(): Promise<ModelInfo[]> {
    return ANTHROPIC_MODELS;
  }

  isAvailable(): boolean {
    return true;
  }

  /**
   * Convert internal Message[] to Anthropic format.
   * Anthropic requires: user/assistant roles only (no system),
   * tool results as user messages with tool_result content blocks,
   * assistant messages with tool_use content blocks for tool calls.
   */
  private buildMessages(messages: Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const m of messages) {
      if (m.role === 'system') continue; // system is passed separately

      if (m.role === 'tool') {
        // Anthropic: tool results are user messages with tool_result content blocks
        result.push({
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: m.tool_call_id ?? '',
            content: m.content,
          }],
        });
      } else if (m.role === 'assistant' && m.tool_calls?.length) {
        // Assistant message with tool_use blocks
        const content: Anthropic.ContentBlockParam[] = [];
        if (m.content) {
          content.push({ type: 'text', text: m.content });
        }
        for (const tc of m.tool_calls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        result.push({ role: 'assistant', content });
      } else {
        result.push({
          role: m.role as 'user' | 'assistant',
          content: m.content,
        });
      }
    }

    return result;
  }
}
