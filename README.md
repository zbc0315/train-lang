# train

> A domain-specific programming language for LLM-driven workflows.
> *"Rail constrains the train; deterministic control flow constrains LLM."*

`train` is a small language designed to wrap LLM calls as first-class functions
(`fai`) with strict type contracts, while leaving deterministic control flow
(branching, loops, error handling, modules) to the host language. It is
**independent** — works in any terminal with one LLM adapter; integrates with
`ccweb`, Claude Code, Codex, VS Code, CI pipelines, etc. via plugin adapters.

## Status

**Pre-implementation.** Design specification draft v0.1 — see
`~/Obsidian/Base/cc-web/工作流DSL.md`.
Formal grammar — see `docs/grammar.ebnf`.

## Repository layout

```
packages/
  core/           @train-lang/core         language runtime
  adapter-spec/   @train-lang/adapter-spec adapter protocol (planned)
  cli/            @train-lang/cli          train CLI (planned)
  adapter-*/      LLM adapters             OpenAI / Anthropic / Ollama / ... (planned)
docs/
  grammar.ebnf    formal grammar
examples/
  hello.tr        minimal example
```

## Quick taste

```
fai greet(name: string, prompt: prompt) -> message: string maxLen=200 { }

func main(name: string) -> string {
  let r = greet(name, "用礼貌的方式问候 ${name}")
  return r.message
}

export main
```

Future:

```bash
npm install -g @train-lang/cli @train-lang/adapter-openai
train config set adapter openai
train config set openai.api_key sk-...
train run hello.tr -- "World"
```

## Development

```bash
pnpm install
pnpm -r test
```

## License

MIT
