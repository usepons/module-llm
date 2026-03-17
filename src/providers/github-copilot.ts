import type { LLMProvider, GenerateOptions, GenerateResult, StreamChunk, ModelInfo, ProviderConfig, Message, ToolCall } from './types.ts';

const GITHUB_COPILOT_ENDPOINT = 'https://api.githubcopilot.com';
const GITHUB_TOKEN_ENDPOINT = 'https://api.github.com/copilot_internal/v2/token';
const EDITOR_VERSION = 'pons/0.2.0';

interface CopilotSessionToken {
  token: string;
  expiresAt: number;
  refreshIn: number;
}

const COPILOT_HEADERS = {
  'Editor-Version': EDITOR_VERSION,
  'Editor-Plugin-Version': 'copilot/0.2.0',
  'Openai-Organization': 'github-copilot',
  'Copilot-Integration-Id': 'pons',
} as const;

export class GitHubCopilotProvider implements LLMProvider {
  readonly id = 'github-copilot';
  readonly name = 'GitHub Copilot';
  private githubToken: string;
  private sessionToken: CopilotSessionToken | null = null;

  constructor(config: ProviderConfig) {
    this.githubToken = config.token || config.apiKey || '';
  }

  /**
   * Resolve a GitHub personal/OAuth token.
   * Precedence: config > env vars > gh CLI (matches copilot-cli behavior).
   */
  private async resolveGitHubToken(): Promise<string> {
    if (this.githubToken) return this.githubToken;

    // Check environment variables (same precedence as copilot-cli)
    for (const envVar of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
      const val = Deno.env.get(envVar);
      if (val) {
        this.githubToken = val;
        return val;
      }
    }

    // Fallback: gh CLI (works for both personal and enterprise)
    for (const args of [['auth', 'token'], ['copilot', 'auth', 'token']]) {
      try {
        const command = new Deno.Command('gh', {
          args,
          stdout: 'piped',
          stderr: 'null',
        });
        const output = await command.output();
        if (output.success) {
          const token = new TextDecoder().decode(output.stdout).trim();
          if (token) {
            this.githubToken = token;
            return token;
          }
        }
      } catch {
        // gh CLI not available or command failed
      }
    }

    return this.githubToken;
  }

  /**
   * Exchange GitHub token for a Copilot session token.
   * Enterprise subscriptions are handled automatically — the GitHub token
   * carries the org/enterprise scope, and the Copilot token endpoint
   * returns a session token scoped to the user's entitlement.
   */
  private async resolveSessionToken(): Promise<string> {
    // Reuse cached session token if still valid (refresh 60s before refresh_in)
    if (this.sessionToken && this.sessionToken.expiresAt > Date.now()) {
      return this.sessionToken.token;
    }

    const githubToken = await this.resolveGitHubToken();
    if (!githubToken) {
      throw new Error('GitHub Copilot: no GitHub token available. Set token in config, env var (COPILOT_GITHUB_TOKEN / GH_TOKEN / GITHUB_TOKEN), or authenticate with `gh auth login`.');
    }

    const response = await fetch(GITHUB_TOKEN_ENDPOINT, {
      headers: {
        'Authorization': `token ${githubToken}`,
        ...COPILOT_HEADERS,
        'Accept': 'application/json',
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      await response.text(); // consume body without exposing it
      // Fallback: try using the GitHub token directly (older setups)
      if (response.status === 404) {
        this.sessionToken = { token: githubToken, expiresAt: Date.now() + 30 * 60_000, refreshIn: 1800 };
        return githubToken;
      }
      throw new Error(`GitHub Copilot token exchange failed (HTTP ${response.status})`);
    }

    const data = await response.json() as { token: string; expires_at: number; refresh_in: number };
    this.sessionToken = {
      token: data.token,
      expiresAt: Date.now() + (data.refresh_in - 60) * 1000, // refresh 60s before expiry
      refreshIn: data.refresh_in,
    };
    return this.sessionToken.token;
  }

  async generateText(options: GenerateOptions): Promise<GenerateResult> {
    const token = await this.resolveSessionToken();

    const response = await fetch(`${GITHUB_COPILOT_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...COPILOT_HEADERS,
      },
      body: JSON.stringify({
        model: options.model,
        messages: this.buildMessages(options),
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        ...(options.tools?.length ? {
          tools: options.tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        } : {}),
      }),
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok) {
      await response.text(); // consume body without exposing it
      throw new Error(`GitHub Copilot error: HTTP ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
        };
        finish_reason: string;
      }>;
      model: string;
      usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    const choice = data.choices[0];
    const toolCalls: ToolCall[] = (choice?.message?.tool_calls ?? []).map(tc => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments || '{}'),
    }));

    return {
      content: choice?.message?.content ?? '',
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        completionTokens: data.usage?.completion_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
      model: data.model,
      finishReason: choice?.finish_reason ?? 'unknown',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  async *streamText(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const token = await this.resolveSessionToken();

    const response = await fetch(`${GITHUB_COPILOT_ENDPOINT}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...COPILOT_HEADERS,
      },
      body: JSON.stringify({
        model: options.model,
        messages: this.buildMessages(options),
        max_tokens: options.maxTokens,
        temperature: options.temperature,
        stream: true,
        ...(options.tools?.length ? {
          tools: options.tools.map(t => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        } : {}),
      }),
    });

    if (!response.ok || !response.body) throw new Error(`GitHub Copilot error: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Accumulate tool call chunks
    const toolCallAccum = new Map<number, { id: string; name: string; args: string }>();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;

        try {
          const data = JSON.parse(payload) as {
            choices: Array<{
              delta: {
                content?: string;
                tool_calls?: Array<{
                  index: number;
                  id?: string;
                  function?: { name?: string; arguments?: string };
                }>;
              };
              finish_reason?: string;
            }>;
            usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
          };

          const delta = data.choices[0]?.delta;

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

          // Emit accumulated tool calls on finish
          const finishReason = data.choices[0]?.finish_reason;
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

          if (data.usage) {
            yield {
              type: 'usage',
              usage: {
                promptTokens: data.usage.prompt_tokens,
                completionTokens: data.usage.completion_tokens,
                totalTokens: data.usage.total_tokens,
              },
            };
          }
        } catch {
          // skip malformed chunks
        }
      }
    }

    yield { type: 'done' };
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const token = await this.resolveSessionToken();
      const response = await fetch(`${GITHUB_COPILOT_ENDPOINT}/models`, {
        headers: {
          'Authorization': `Bearer ${token}`,
          ...COPILOT_HEADERS,
        },
      });
      if (!response.ok) return this.defaultModels();
      const data = await response.json() as { data?: Array<{ id: string; name?: string }> };
      return (data.data || []).map(m => ({
        id: m.id,
        name: m.name || m.id,
        provider: this.id,
      }));
    } catch {
      return this.defaultModels();
    }
  }

  isAvailable(): boolean {
    return !!this.githubToken;
  }

  private buildMessages(options: GenerateOptions): Array<Record<string, unknown>> {
    const msgs: Array<Record<string, unknown>> = [];
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
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
      } else {
        msgs.push({ role: m.role, content: m.content });
      }
    }
    return msgs;
  }

  private defaultModels(): ModelInfo[] {
    return [
      { id: 'gpt-4o', name: 'GPT-4o', provider: this.id },
      { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', provider: this.id },
    ];
  }
}
