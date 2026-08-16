"""Domain CRUD over the SQLite schema."""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Optional

from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from .db import TemplateRow, create_engine_for
from .models import PromptTemplate, PromptTemplateCreate, PromptTemplateUpdate


class PromptTemplateStore:
    """Owns one SQLite database and exposes template CRUD.

    A template name is unique within its scope partition
    (`(scope, session_id)`); a global template must not carry a session id
    and a session template must."""

    def __init__(self, db_path: str | Path) -> None:
        self._db_path = Path(db_path)
        self._engine = create_engine_for(self._db_path)
        self._session_factory = sessionmaker(self._engine, expire_on_commit=False)

    @property
    def path(self) -> Path:
        """Absolute database path this store owns."""
        return self._db_path

    def list(
        self,
        scope: Optional[str] = None,
        session_id: Optional[str] = None,
    ) -> list[PromptTemplate]:
        """List templates, ordered by position then creation time.

        `scope` and `session_id` are optional filters; pass `session_id`
        alone to select one session's private templates."""
        with self._session_factory() as session:
            stmt = select(TemplateRow).order_by(
                TemplateRow.position, TemplateRow.created_at
            )
            if scope is not None:
                stmt = stmt.where(TemplateRow.scope == scope)
            if session_id is not None:
                stmt = stmt.where(TemplateRow.session_id == session_id)
            rows = session.scalars(stmt).all()
            return [PromptTemplate.model_validate(row) for row in rows]

    def get(self, template_id: str) -> Optional[PromptTemplate]:
        """Fetch one template by id; `None` when absent."""
        with self._session_factory() as session:
            row = session.get(TemplateRow, template_id)
            return PromptTemplate.model_validate(row) if row is not None else None

    def create(self, data: PromptTemplateCreate) -> PromptTemplate:
        """Insert a template, rejecting a duplicate name in its scope partition."""
        with self._session_factory() as session:
            existing = session.scalars(
                select(TemplateRow).where(
                    TemplateRow.scope == data.scope,
                    TemplateRow.session_id == data.session_id,
                    TemplateRow.name == data.name,
                )
            ).first()
            if existing is not None:
                raise ValueError(
                    f"template name {data.name!r} already exists in scope {data.scope}"
                )
            row = TemplateRow(
                id=uuid.uuid4().hex,
                name=data.name,
                content=data.content,
                scope=data.scope,
                session_id=data.session_id,
                description=data.description,
                position=data.position,
            )
            session.add(row)
            session.commit()
            session.refresh(row)
            return PromptTemplate.model_validate(row)

    def update(
        self, template_id: str, patch: PromptTemplateUpdate
    ) -> Optional[PromptTemplate]:
        """Apply a patch; `None` when the template is absent.

        A renamed template keeps the create-path uniqueness rule: a name
        already taken in its scope partition rejects the update."""
        with self._session_factory() as session:
            row = session.get(TemplateRow, template_id)
            if row is None:
                return None
            fields = patch.model_dump(exclude_unset=True)
            new_name = fields.get("name")
            if new_name is not None and new_name != row.name:
                existing = session.scalars(
                    select(TemplateRow).where(
                        TemplateRow.id != row.id,
                        TemplateRow.scope == row.scope,
                        TemplateRow.session_id == row.session_id,
                        TemplateRow.name == new_name,
                    )
                ).first()
                if existing is not None:
                    raise ValueError(
                        f"template name {new_name!r} already exists in scope {row.scope}"
                    )
            for field, value in fields.items():
                setattr(row, field, value)
            session.commit()
            session.refresh(row)
            return PromptTemplate.model_validate(row)

    def make_global(self, template_id: str) -> Optional[PromptTemplate]:
        """Promote one session template to the global partition.

        `None` when the template is absent. Rejects a template that is
        already global and a global name collision, mirroring the
        create-path uniqueness rule across the partition move."""
        with self._session_factory() as session:
            row = session.get(TemplateRow, template_id)
            if row is None:
                return None
            if row.scope == "global":
                raise ValueError(f"template {template_id!r} is already global")
            existing = session.scalars(
                select(TemplateRow).where(
                    TemplateRow.scope == "global",
                    TemplateRow.session_id.is_(None),
                    TemplateRow.name == row.name,
                )
            ).first()
            if existing is not None:
                raise ValueError(
                    f"template name {row.name!r} already exists in scope global"
                )
            row.scope = "global"
            row.session_id = None
            session.commit()
            session.refresh(row)
            return PromptTemplate.model_validate(row)

    def delete(self, template_id: str) -> bool:
        """Delete a template; `False` when it is absent."""
        with self._session_factory() as session:
            row = session.get(TemplateRow, template_id)
            if row is None:
                return False
            session.delete(row)
            session.commit()
            return True
