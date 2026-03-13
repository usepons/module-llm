/**
 * LLM Provider abstraction — shared types for all provider implementations.
 */

export interface Message {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateOptions {
  model: string;
  messages: Message[];
  system?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
}

export interface GenerateResult {
  content: string;
  usage: TokenUsage;
  model: string;
  finishReason: string;
  toolCalls?: ToolCall[];
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface StreamChunk {
  type: 'text' | 'usage' | 'done' | 'tool_call';
  text?: string;
  usage?: TokenUsage;
  toolCall?: ToolCall;
}

export interface ModelInfo {
  id: string;
  name: string;
  provider: string;
  contextWindow?: number;
}

export interface ProviderConfig {
  apiKey?: string;
  baseUrl?: string;
  token?: string;
}

export interface LLMProvider {
  readonly id: string;
  readonly name: string;
  generateText(options: GenerateOptions): Promise<GenerateResult>;
  streamText(options: GenerateOptions): AsyncIterable<StreamChunk>;
  listModels(): Promise<ModelInfo[]>;
  isAvailable(): boolean;
}
