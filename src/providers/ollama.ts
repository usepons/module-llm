import type { LLMProvider, GenerateOptions, GenerateResult, StreamChunk, ModelInfo, ProviderConfig, Message, ToolCall } from './types.ts';
import { validateProviderBaseUrl } from './url-validation.ts';

interface OllamaChatMessage {
  role: string;
  content: string;
  tool_calls?: Array<{
    function: { name: string; arguments: Record<string, unknown> };
  }>;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class OllamaProvider implements LLMProvider {
  readonly id = 'ollama';
  readonly name = 'Ollama';
  private baseUrl: string;

  constructor(config: ProviderConfig) {
    const raw = config.baseUrl || config.url || 'http://localhost:11434';
    // Ollama is inherently a local/LAN provider — skip SSRF validation
    // to allow private network addresses (e.g. 192.168.x.x)
    this.baseUrl = raw.replace(/\/$/, '');
  }

  async generateText(options: GenerateOptions): Promise<GenerateResult> {
    const messages = this.buildMessages(options);
    const tools = this.buildTools(options);

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: false,
        ...(tools.length > 0 ? { tools } : {}),
        options: {
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
        },
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      await response.text(); // consume body
      throw new Error(`Ollama error: HTTP ${response.status}`);
    }

    const data = await response.json() as {
      message: OllamaChatMessage;
      model: string;
      prompt_eval_count?: number;
      eval_count?: number;
      done_reason?: string;
    };

    const promptTokens = data.prompt_eval_count ?? 0;
    const completionTokens = data.eval_count ?? 0;

    const toolCalls: ToolCall[] = (data.message.tool_calls ?? []).map((tc, i) => ({
      id: `ollama-tc-${i}-${Date.now()}`,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));

    return {
      content: data.message.content,
      usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
      model: data.model,
      finishReason: data.done_reason ?? 'stop',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *streamText(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const messages = this.buildMessages(options);
    const tools = this.buildTools(options);

    // Ollama doesn't stream tool calls well — use non-streaming when tools are present
    if (tools.length > 0) {
      const result = await this.generateText(options);
      if (result.content) {
        yield { type: 'text', text: result.content };
      }
      if (result.toolCalls) {
        for (const tc of result.toolCalls) {
          yield { type: 'tool_call', toolCall: tc };
        }
      }
      yield { type: 'usage', usage: result.usage };
      yield { type: 'done' };
      return;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options.model,
        messages,
        stream: true,
        options: {
          ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          ...(options.maxTokens ? { num_predict: options.maxTokens } : {}),
        },
      }),
      signal: AbortSignal.timeout(300_000),
    });

    if (!response.ok || !response.body) throw new Error(`Ollama streaming error: HTTP ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line) as {
          message?: { content: string };
          done: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };

        if (data.message?.content) {
          yield { type: 'text', text: data.message.content };
        }

        if (data.done) {
          const promptTokens = data.prompt_eval_count ?? 0;
          const completionTokens = data.eval_count ?? 0;
          yield {
            type: 'usage',
            usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens },
          };
        }
      }
    }

    yield { type: 'done' };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) return [];
      const data = await response.json() as { models: Array<{ name: string; details?: { parameter_size?: string } }> };
      return (data.models || []).map(m => ({
        id: m.name,
        name: m.name,
        provider: this.id,
      }));
    } catch {
      return [];
    }
  }

  isAvailable(): boolean {
    return true;
  }

  private buildTools(options: GenerateOptions): OllamaTool[] {
    if (!options.tools?.length) return [];
    return options.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  private buildMessages(options: GenerateOptions): OllamaChatMessage[] {
    const msgs: OllamaChatMessage[] = [];
    if (options.system) {
      msgs.push({ role: 'system', content: options.system });
    }
    for (const m of options.messages) {
      if (m.role === 'tool') {
        // Ollama expects tool results as role: 'tool' with the content
        msgs.push({ role: 'tool', content: m.content });
      } else if (m.role === 'assistant' && m.tool_calls?.length) {
        // Preserve tool_calls so Ollama can match tool results to calls
        msgs.push({
          role: 'assistant',
          content: m.content || '',
          tool_calls: m.tool_calls.map(tc => ({
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        });
      } else {
        msgs.push({ role: m.role, content: m.content });
      }
    }
    return msgs;
  }
}
