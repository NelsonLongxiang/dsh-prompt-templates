"""dsh-prompt-templates: quick prompt-template backend for DeepSeek Harness.

One SQLite database owned by Python code (SQLAlchemy ORM + Pydantic
validation), exposed through a CLI and a newline-delimited JSON-RPC 2.0
server over stdio for Host-side bridge integration.
"""

from __future__ import annotations

from .db import default_db_path
from .models import PromptTemplate, PromptTemplateCreate, PromptTemplateUpdate
from .store import PromptTemplateStore

__all__ = [
    "PromptTemplate",
    "PromptTemplateCreate",
    "PromptTemplateStore",
    "PromptTemplateUpdate",
    "default_db_path",
]

__version__ = "0.0.0.dev0"
