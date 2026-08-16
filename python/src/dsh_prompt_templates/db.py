"""Shared SQLite plumbing for extension domains plus the prompt-template schema.

Each extension domain owns its own database file under `$DSH_HOME/ext/<domain>/`
and its own `DeclarativeBase`; this module owns the cross-domain pieces: the
home-path rule, private-file hardening, WAL, and the monotonic `user_version`
gate (an unversioned empty database initializes at the domain's schema version;
any other on-disk version rejects instead of migrating).
"""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Optional

from sqlalchemy import DateTime, Integer, String, Text, create_engine, event, func
from sqlalchemy.engine import Engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

TEMPLATES_SCHEMA_VERSION = 1


class Base(DeclarativeBase):
    pass


class TemplateRow(Base):
    """One prompt template row. `scope` discriminates global vs session; a
    session-scoped row carries the owning session id in `session_id`."""

    __tablename__ = "templates"

    id: Mapped[str] = mapped_column(String(32), primary_key=True)
    name: Mapped[str] = mapped_column(String(128))
    content: Mapped[str] = mapped_column(Text)
    scope: Mapped[str] = mapped_column(String(16))
    session_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    description: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)
    position: Mapped[int] = mapped_column(Integer, nullable=False, server_default="0")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, nullable=False, server_default=func.now(), onupdate=func.now()
    )


def ext_home() -> Path:
    """Resolve `$DSH_HOME` (default `~/.dsh`), matching the repository
    home-paths convention."""
    home = os.environ.get("DSH_HOME")
    return Path(home).expanduser() if home and home.strip() else Path.home() / ".dsh"


def default_domain_db_path(domain: str) -> Path:
    """Resolve `<ext_home>/ext/<domain>/db.sqlite3` for one extension domain.

    The `ext/` subdirectory keeps extension data out of the root (never flat
    files beside `settings.yaml`)."""
    return ext_home() / "ext" / domain / "db.sqlite3"


def default_db_path() -> Path:
    """The prompt-template domain's default database path."""
    return default_domain_db_path("prompt-templates")


def _ensure_private_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(path, 0o700)
    except OSError:
        # Best-effort on platforms without POSIX modes.
        pass


def _ensure_private_file(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def _enable_wal(dbapi_connection, _record) -> None:
    cursor = dbapi_connection.cursor()
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


def open_domain_engine(db_path: str | Path, base: type[DeclarativeBase], schema_version: int) -> Engine:
    """Create the SQLite engine for one domain database, creating the schema
    when absent and gating on the monotonic `user_version`.

    The parent directory is created owner-only and the database file is
    chmodded to owner-only, matching the TS persistence backends. The
    in-memory database skips all filesystem handling. An empty database with
    `user_version` 0 initializes at `schema_version`; any other non-current
    version rejects rather than migrating."""
    if str(db_path) == ":memory:":
        engine = create_engine("sqlite:///:memory:", future=True)
    else:
        path = Path(db_path)
        _ensure_private_dir(path.parent)
        engine = create_engine(f"sqlite:///{path}", future=True)
    event.listen(engine, "connect", _enable_wal)
    with engine.begin() as connection:
        on_disk = connection.exec_driver_sql("PRAGMA user_version").scalar_one()
        if on_disk == 0:
            base.metadata.create_all(connection)
            connection.exec_driver_sql(f"PRAGMA user_version={schema_version}")
        elif on_disk != schema_version:
            raise RuntimeError(
                f"{db_path} has schema version {on_disk}, "
                f"incompatible with this build (expected {schema_version})"
            )
    if str(db_path) != ":memory:":
        _ensure_private_file(Path(db_path))
    return engine


def create_engine_for(db_path: str | Path) -> Engine:
    """Create the prompt-template domain engine (see {@link open_domain_engine})."""
    return open_domain_engine(db_path, Base, TEMPLATES_SCHEMA_VERSION)
