# @pons/module-llm

Multi-provider LLM module for the [Pons](https://github.com/usepons) platform.

## Overview

The LLM module provides a unified interface to multiple AI providers, accessible via RPC from any other Pons module. Features include:

- **Provider abstraction** — Anthropic, OpenAI, DeepSeek, Ollama, Claude Code, GitHub Copilot
- **Model routing** — configurable default/fallback chains, per-request provider and model selection
- **Auth profile rotation** — multiple API keys per provider with automatic rotation
- **Cost tracking** — per-request cost calculation with daily/monthly limits
- **Failover** — automatic retry with fallback providers on failure
- **Streaming** — real-time token streaming via pub/sub bus

## Prerequisites

- [Deno](https://deno.com/) v2.0+

## Installation

```bash
deno install
```

## Usage

### As a Pons module (kernel-managed)

Configure providers in your workspace config:

```yaml
models:
  providers:
    anthropic:
      provider: anthropic
      models: [claude-sonnet-4-20250514]
    openai:
      provider: openai
      models: [gpt-4o]
  authProfiles:
    anthropic:
      - id: key1
        credential: sk-ant-...
  routing:
    default:
      provider: anthropic
      model: claude-sonnet-4-20250514
```

### Standalone

```bash
deno run -A runner.ts
```

### CLI Chat

```bash
deno run -A cli.ts chat --provider anthropic --model claude-sonnet-4-20250514
```

## IPC Interface

### RPC Services

- **model-router** — `generateText`, `streamText`, `listModels`, `getCapabilities`
- **providerRegistry** — `listProviders`, `getProvider`
- **authProfileManager** — `listProfiles`
- **cost-tracker** — `getUsage`, `resetUsage`

### Subscribes to

| Topic | Description |
|-------|-------------|
| `llm:generate` | Async text generation (responds via `replyTopic`) |
| `llm:stream:request` | Streaming generation request |

### Publishes to

| Topic | Description |
|-------|-------------|
| `llm:stream:chunk` | Streaming response chunks |
| `usage:updated` | Cost/usage update events |

## Supported Providers

| Provider | Streaming | Tool Use | Notes |
|----------|-----------|----------|-------|
| Anthropic | Yes | Yes | Claude models |
| OpenAI | Yes | Yes | GPT-4o, o1, etc. |
| DeepSeek | Yes | Yes | Via OpenAI-compatible API |
| Ollama | Yes | No | Local models |
| Claude Code | Yes | Yes | Via Claude Code CLI subprocess |
| GitHub Copilot | Yes | Yes | Via Copilot API with device auth |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

[MIT](LICENSE)
