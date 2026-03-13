# Contributing to @pons/module-llm

Thanks for your interest in contributing!

## Prerequisites

- [Deno](https://deno.com/) v2.0+

## Development Setup

```bash
git clone https://github.com/usepons/module-llm.git
cd module-llm
deno install
```

## Running Locally

```bash
# Run the LLM module
deno run -A runner.ts

# Test a provider directly via CLI chat
deno run -A cli.ts chat --provider anthropic --model claude-sonnet-4-20250514
```

## Adding a New Provider

1. Create a new file in `src/providers/` implementing the `LLMProvider` interface from `src/providers/types.ts`
2. Register it in `src/registry.ts`
3. Test via `cli.ts chat --provider your-provider`

## Code Style

- Pure Deno — no npm build tools
- Explicit import specifiers: `jsr:@pons/sdk@^0.2`, `npm:openai@^4`
- No bare imports
- Run `deno fmt` before committing
- Run `deno lint` to catch issues

## Submitting Changes

1. Fork the repository
2. Create a branch from `main` (`feat/new-provider`, `fix/streaming-race`)
3. Make focused, atomic commits
4. Test locally — use the CLI chat to verify provider behavior
5. Open a pull request against `main`

## Reporting Issues

Open an issue at [github.com/usepons/module-llm/issues](https://github.com/usepons/module-llm/issues).

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
