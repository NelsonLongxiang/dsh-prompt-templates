# dsh-prompt-templates

Quick prompt templates for DeepSeek Harness, distributed as one self-contained
plugin: a Host bridge, a browser panel, and the Python backend it persists
through — all in one repository, installable with `dsh plugin`.

## What it is

A right-side panel listing **global** and **per-session** prompt templates,
plus a composer tool-row button that toggles it and inserts template content
into the draft. Templates persist in SQLite through a Python backend; the Host
bridges it in as a subprocess speaking newline-delimited JSON-RPC.

- Global templates apply to every session.
- Session templates are private to one session and can be promoted to global.
- The panel supports insert (append to draft), send-now, edit, delete, and
  make-global actions, drag repositioning, and double-click reset.

## Layout

```text
src/                  TypeScript plugin (host half + browser half)
  index.ts            Host: spawns the Python child, exposes the Typert Remote
  client/             Browser: panel UI registered into shell.overlay and
                      conversation.input.right
python/               Python backend package (template domain only)
  src/dsh_prompt_templates/
  pyproject.toml
cordis.patch.yml      Bundle patch: mounts the plugin row
tsdown.config.ts      Browser bundle (__ModuleLoader__ protocol)
```

The Python package is **not** `dsh_ext` — this plugin carries only the prompt
template domain (models, store, JSON-RPC server, CLI), extracted from the
shared extension backend so a plugin stays minimal and self-contained.

## Install

```sh
dsh plugin --profile <name> add <this package>
```

The bundle patch mounts the plugin row; the Host spawns the Python child from
the package-local venv created during install.

## Development

```sh
pnpm install
pnpm build             # tsc host + tsc client + tsdown browser bundle
python/python-bootstrap.mjs   # uv sync the package-local Python venv
python/pytest          # Python backend tests (uv run --project python/ext pytest)
pnpm test              # TS tests
```

## Model Experience

Indirectly, through the conversation draft: inserted template content reaches
a model request only as ordinary user text.

## Known Limitations and Deferred Work

- **Insert appends to the draft** — clicking a template appends its content;
  caret-position insert is deferred.
- **Session templates need a current session** — with no session open, only
  global templates are reachable.
- **No template search** — the panel lists all templates; filtering is
  deferred until the template count justifies it.
- **Python backend needs a local interpreter** — install bootstraps a
  package-local venv with `uv`; a machine without `uv` must pre-create it.
