import pytest
from pydantic import ValidationError

from dsh_prompt_templates.models import PromptTemplateCreate, PromptTemplateUpdate


def test_session_scope_requires_session_id() -> None:
    with pytest.raises(ValidationError):
        PromptTemplateCreate(name="x", content="y", scope="session")


def test_global_scope_rejects_session_id() -> None:
    with pytest.raises(ValidationError):
        PromptTemplateCreate(name="x", content="y", scope="global", session_id="s1")


def test_valid_session_template() -> None:
    template = PromptTemplateCreate(
        name="x", content="y", scope="session", session_id="s1"
    )
    assert template.scope == "session"
    assert template.session_id == "s1"


def test_empty_name_rejected() -> None:
    with pytest.raises(ValidationError):
        PromptTemplateCreate(name="", content="y")


def test_empty_content_rejected() -> None:
    with pytest.raises(ValidationError):
        PromptTemplateCreate(name="x", content="")


def test_negative_position_rejected() -> None:
    with pytest.raises(ValidationError):
        PromptTemplateCreate(name="x", content="y", position=-1)


def test_update_patch_optional_fields() -> None:
    patch = PromptTemplateUpdate(content="new")
    assert patch.name is None
    assert patch.content == "new"
    assert patch.model_dump(exclude_unset=True) == {"content": "new"}
