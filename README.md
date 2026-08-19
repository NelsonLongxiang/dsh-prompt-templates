# @nelsonlongxiang/dsh-prompt-templates

English | [中文](README_zh.md)

[![npm](https://img.shields.io/npm/v/@nelsonlongxiang/dsh-prompt-templates?label=npm)](https://www.npmjs.com/package/@nelsonlongxiang/dsh-prompt-templates)

Quick prompt templates for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): global and per-session templates, a right-side browser panel, and a Python-backed SQLite persistence — one self-contained plugin, installable with `dsh plugin`.

## Install

```sh
dsh plugin --profile web add @nelsonlongxiang/dsh-prompt-templates
```

Restart `dsh web`, then look for the templates button in the composer tool row.

**Requires `uv` on PATH** — install bootstraps a package-local Python venv with `uv sync`; a machine without it fails loud with a one-line fix instead of a broken install. The plugin composes beside the stock webserver row and spawns its Python child from that venv.

## What you get

- **Global + per-session templates** — globals apply everywhere; session templates stay private to one conversation and can be promoted to global in one click
- **Insert or send** — one click appends the template into the draft; send-now dispatches immediately; edit, delete, and make-global all live in the row
- **Search & scroll** — filter the list as you type, reliable scrolling for long collections
- **Drag to reposition, double-click to reset** — the panel remembers where you put it
- **Durable by design** — templates persist in SQLite through a Python backend the Host bridges in as a managed subprocess (newline-delimited JSON-RPC); the child is lazily spawned and torn down with the plugin

## How it works

```text
src/                  TypeScript plugin (host half + browser half)
  index.ts            Host: spawns the Python child, exposes the HTTP routes
  client/             Browser: panel UI registered into shell.overlay and
                      conversation.input.right
python/               Python backend package (template domain only)
  src/dsh_prompt_templates/
  pyproject.toml      models, store, JSON-RPC server, CLI
cordis.patch.yml      Bundle patch: mounts the plugin row
```

The Python package carries only the prompt-template domain, extracted from the shared extension backend so the plugin stays minimal and self-contained.

## Security

- Template content reaches a model request only as ordinary user text the user chose to insert — no automatic injection into any prompt
- The panel talks to the Python backend over the Host's plugin routes only; no extra listener, no outbound network

## Development

```sh
pnpm install
pnpm verify            # typecheck + Python backend tests (uv --group test)
pnpm build             # tsc host + tsc client + tsdown browser bundle
node scripts/bootstrap.mjs   # uv sync the package-local venv
```

## Known limitations

- **Insert appends to the draft** — caret-position insert is deferred
- **Session templates need a current session** — with no session open, only global templates are reachable

## License

MIT
