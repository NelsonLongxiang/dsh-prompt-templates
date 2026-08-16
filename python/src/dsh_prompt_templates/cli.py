"""dsh-prompt-templates command-line interface."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Optional

import typer

from .db import default_db_path
from .models import PromptTemplateCreate, PromptTemplateUpdate
from .server import JsonRpcServer, default_domains
from .store import PromptTemplateStore

app = typer.Typer(help="Quick prompt-templates backend for DeepSeek Harness.")
templates = typer.Typer(help="Manage prompt templates.")
app.add_typer(templates, name="templates")


def _store(db: Optional[Path]) -> PromptTemplateStore:
    return PromptTemplateStore(db if db is not None else default_db_path())


def _fail(exc: Exception) -> None:
    typer.secho(f"error: {exc}", fg=typer.colors.RED, err=True)
    raise typer.Exit(code=1)


@app.command()
def init(
    db: Optional[Path] = typer.Option(
        None,
        "--db",
        help="Database path (default: $DSH_HOME/ext/prompt-templates/db.sqlite3).",
    ),
) -> None:
    """Create the database schema if absent."""
    store = _store(db)
    typer.echo(f"database ready at {store.path}")


@app.command()
def serve(
    templates_db: Optional[Path] = typer.Option(
        None,
        "--db",
        "--templates-db",
        help="Prompt-template database path (default: $DSH_HOME/ext/prompt-templates/db.sqlite3).",
    ),
) -> None:
    """Run the stdio JSON-RPC server for Host bridge integration."""
    JsonRpcServer(
        default_domains(str(templates_db) if templates_db is not None else None)
    ).serve()


@templates.command("list")
def list_templates(
    scope: Optional[str] = typer.Option(
        None, "--scope", help="Filter by scope: global|session."
    ),
    session_id: Optional[str] = typer.Option(
        None, "--session-id", help="Filter by owning session id."
    ),
    json_output: bool = typer.Option(False, "--json", help="Emit a JSON array."),
    db: Optional[Path] = typer.Option(
        None,
        "--db",
        help="Database path (default: $DSH_HOME/ext/prompt-templates/db.sqlite3).",
    ),
) -> None:
    """List prompt templates."""
    items = _store(db).list(scope=scope, session_id=session_id)
    if json_output:
        typer.echo(
            json.dumps(
                [item.model_dump(mode="json") for item in items],
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        for item in items:
            typer.echo(f"{item.id}\t{item.scope}\t{item.name}\t{item.position}")


@templates.command("add")
def add_template(
    name: str = typer.Argument(..., help="Template name."),
    content: str = typer.Argument(..., help="Template body."),
    scope: str = typer.Option("global", "--scope", help="global|session."),
    session_id: Optional[str] = typer.Option(
        None, "--session-id", help="Owning session id; required when scope=session."
    ),
    description: Optional[str] = typer.Option(None, "--description"),
    position: int = typer.Option(0, "--position"),
    db: Optional[Path] = typer.Option(
        None,
        "--db",
        help="Database path (default: $DSH_HOME/ext/prompt-templates/db.sqlite3).",
    ),
) -> None:
    """Add a prompt template and print its id."""
    try:
        data = PromptTemplateCreate(
            name=name,
            content=content,
            scope=scope,
            session_id=session_id,
            description=description,
            position=position,
        )
        item = _store(db).create(data)
    except ValueError as exc:
        _fail(exc)
    typer.echo(item.id)


@templates.command("get")
def get_template(
    template_id: str = typer.Argument(..., help="Template id."),
    json_output: bool = typer.Option(False, "--json", help="Emit the record as JSON."),
    db: Optional[Path] = typer.Option(
        None,
        "--db",
        help="Database path (default: $DSH_HOME/ext/prompt-templates/db.sqlite3).",
    ),
) -> None:
    """Show one prompt template."""
    item = _store(db).get(template_id)
    if item is None:
        _fail(ValueError(f"template {template_id!r} not found"))
    if json_output:
        typer.echo(json.dumps(item.model_dump(mode="json"), ensure_ascii=False, indent=2))
    else:
        typer.echo(f"{item.id}\t{item.scope}\t{item.name}")
        typer.echo(item.content)


@templates.command("update")
def update_template(
    template_id: str = typer.Argument(..., help="Template id."),
    name: Optional[str] = typer.Option(None, "--name"),
    content: Optional[str] = typer.Option(None, "--content"),
    description: Optional[str] = typer.Option(None, "--description"),
    position: Optional[int] = typer.Option(None, "--position"),
    db: Optional[Path] = typer.Option(
        None,
        "--db",
        help="Database path (default: $DSH_HOME/ext/prompt-templates/db.sqlite3).",
    ),
) -> None:
    """Update one prompt template."""
    try:
        fields = {
            "name": name,
            "content": content,
            "description": description,
            "position": position,
        }
        # Only fields the caller actually passed become part of the patch;
        # an untouched typer Option defaults to None and must stay absent so
        # `exclude_unset` keeps the stored column intact.
        patch = PromptTemplateUpdate(
            **{key: value for key, value in fields.items() if value is not None}
        )
        item = _store(db).update(template_id, patch)
    except ValueError as exc:
        _fail(exc)
    if item is None:
        _fail(ValueError(f"template {template_id!r} not found"))
    typer.echo(item.id)


@templates.command("make-global")
def make_global_template(
    template_id: str = typer.Argument(..., help="Template id."),
    db: Optional[Path] = typer.Option(
        None,
        "--db",
        help="Database path (default: $DSH_HOME/ext/prompt-templates/db.sqlite3).",
    ),
) -> None:
    """Promote one session template to the global scope."""
    try:
        item = _store(db).make_global(template_id)
    except ValueError as exc:
        _fail(exc)
    if item is None:
        _fail(ValueError(f"template {template_id!r} not found"))
    typer.echo(item.id)


@templates.command("remove")
def remove_template(
    template_id: str = typer.Argument(..., help="Template id."),
    db: Optional[Path] = typer.Option(
        None,
        "--db",
        help="Database path (default: $DSH_HOME/ext/prompt-templates/db.sqlite3).",
    ),
) -> None:
    """Remove one prompt template."""
    removed = _store(db).delete(template_id)
    if not removed:
        _fail(ValueError(f"template {template_id!r} not found"))
    typer.echo("removed")


def main() -> None:
    app()


if __name__ == "__main__":
    main()
