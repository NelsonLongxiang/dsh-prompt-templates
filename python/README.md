# dsh-prompt-templates Python backend

Quick prompt-template persistence: SQLAlchemy ORM over one SQLite database
under `$DSH_HOME/ext/prompt-templates/db.sqlite3`, Pydantic validation, a
Typer CLI, and a newline-delimited JSON-RPC 2.0 stdio server the plugin's
Host bridge spawns.

## Development

```sh
uv sync --group test
uv run pytest
```

## CLI

```sh
dsh-prompt-templates init
dsh-prompt-templates templates list [--scope global|session] [--session-id <id>] [--json]
dsh-prompt-templates templates add <name> <content> [--scope session] [--session-id <id>]
dsh-prompt-templates templates get <id> [--json]
dsh-prompt-templates templates update <id> [--name] [--content] [--description] [--position]
dsh-prompt-templates templates make-global <id>
dsh-prompt-templates templates remove <id>
dsh-prompt-templates serve [--db <path>]
```
