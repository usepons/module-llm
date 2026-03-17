import OpenAI from 'npm:openai@^4';
import type { LLMProvider, GenerateOptions, GenerateResult, StreamChunk, ModelInfo, ProviderConfig, ToolCall } from './types.ts';
import { validateProviderBaseUrl } from './url-validation.ts';

export class OpenAIProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  protected client: OpenAI;

  constructor(config: ProviderConfig, id = 'openai', name = 'OpenAI') {
    this.id = id;
    this.name = name;
    this.client = new OpenAI({
      apiKey: config.apiKey,
      timeout: 120_000,
      ...(config.baseUrl ? { baseURL: validateProviderBaseUrl(config.baseUrl) } : {}),
    });
  }

  async generateText(options: GenerateOptions): Promise<GenerateResult> {
    const response = await this.client.chat.completions.create({
      model: options.model,
      messages: this.buildMessages(options),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      ...(options.tools?.length ? { tools: options.tools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })) } : {}),
    });

    const choice = response.choices[0];
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));

    return {
      content: choice?.message?.content ?? '',
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
      model: response.model,
      finishReason: choice?.finish_reason ?? 'unknown',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *streamText(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const stream = await this.client.chat.completions.create({
      model: options.model,
      messages: this.buildMessages(options),
      max_tokens: options.maxTokens,
      temperature: options.temperature,
      stream: true,
      stream_options: { include_usage: true },
      ...(options.tools?.length ? { tools: options.tools.map(t => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      })) } : {}),
    });

    // Accumulate tool call chunks (OpenAI streams tool calls in parts)
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;

      if (delta?.content) {
        yield { type: 'text', text: delta.content };
      }

      // Tool call deltas
      if (delta?.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;
          if (!toolCallAccum.has(idx)) {
            toolCallAccum.set(idx, { id: tc.id ?? '', name: tc.function?.name ?? '', args: '' });
          }
          const accum = toolCallAccum.get(idx)!;
          if (tc.id) accum.id = tc.id;
          if (tc.function?.name) accum.name = tc.function.name;
          if (tc.function?.arguments) accum.args += tc.function.arguments;
        }
      }

      // Finish reason — emit accumulated tool calls
      const finishReason = chunk.choices[0]?.finish_reason;
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        for (const [, accum] of toolCallAccum) {
          if (accum.id && accum.name) {
            yield {
              type: 'tool_call',
              toolCall: {
                id: accum.id,
                name: accum.name,
                arguments: JSON.parse(accum.args || '{}'),
              },
            };
          }
        }
        toolCallAccum.clear();
      }

      if (chunk.usage) {
        yield {
          type: 'usage',
          usage: {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          },
        };
      }
    }

    yield { type: 'done' };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await this.client.models.list();
      const models: ModelInfo[] = [];
      for await (const model of response) {
        models.push({
          id: model.id,
          name: model.id,
          provider: this.id,
        });
      }
      return models;
    } catch {
      return [];
    }
  }

  isAvailable(): boolean {
    return !!this.client.apiKey;
  }

  protected buildMessages(options: GenerateOptions): OpenAI.ChatCompletionMessageParam[] {
    const msgs: OpenAI.ChatCompletionMessageParam[] = [];
    if (options.system) {
      msgs.push({ role: 'system', content: options.system });
    }
    for (const m of options.messages) {
      if (m.role === 'tool') {
        msgs.push({
          role: 'tool',
          content: m.content,
          tool_call_id: m.tool_call_id ?? '',
        });
      } else if (m.role === 'assistant' && m.tool_calls?.length) {
        msgs.push({
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.tool_calls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
      } else {
        msgs.push({ role: m.role as 'user' | 'assistant' | 'system', content: m.content });
      }
    }
    return msgs;
  }
}
