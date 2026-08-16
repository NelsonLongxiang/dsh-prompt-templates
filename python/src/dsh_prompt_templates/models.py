"""Pydantic models for the dsh-ext domain."""

from __future__ import annotations

from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, ConfigDict, Field, model_validator

PromptScope = Literal["global", "session"]

_NAME_MAX = 128
_CONTENT_MIN = 1
_DESCRIPTION_MAX = 512
_SESSION_ID_MAX = 128


class PromptTemplateCreate(BaseModel):
    """Payload for creating one prompt template."""

    name: str = Field(min_length=1, max_length=_NAME_MAX)
    content: str = Field(min_length=_CONTENT_MIN)
    scope: PromptScope = "global"
    session_id: Optional[str] = Field(default=None, max_length=_SESSION_ID_MAX)
    description: Optional[str] = Field(default=None, max_length=_DESCRIPTION_MAX)
    position: int = Field(default=0, ge=0)

    @model_validator(mode="after")
    def _scope_session_consistency(self) -> PromptTemplateCreate:
        if self.scope == "session" and not self.session_id:
            raise ValueError("scope='session' requires session_id")
        if self.scope == "global" and self.session_id is not None:
            raise ValueError("scope='global' must not carry session_id")
        return self


class PromptTemplateUpdate(BaseModel):
    """Patch payload; every field is optional."""

    name: Optional[str] = Field(default=None, min_length=1, max_length=_NAME_MAX)
    content: Optional[str] = Field(default=None, min_length=_CONTENT_MIN)
    description: Optional[str] = Field(default=None, max_length=_DESCRIPTION_MAX)
    position: Optional[int] = Field(default=None, ge=0)


class PromptTemplate(BaseModel):
    """Canonical template record."""

    model_config = ConfigDict(from_attributes=True)

    id: str
    name: str
    content: str
    scope: PromptScope
    session_id: Optional[str] = None
    description: Optional[str] = None
    position: int
    created_at: datetime
    updated_at: datetime
