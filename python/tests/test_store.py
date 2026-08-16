import pytest

from dsh_prompt_templates.models import PromptTemplateCreate, PromptTemplateUpdate
from dsh_prompt_templates.store import PromptTemplateStore


def make_store(tmp_path) -> PromptTemplateStore:
    return PromptTemplateStore(tmp_path / "db.sqlite3")


def test_crud_roundtrip(tmp_path) -> None:
    store = make_store(tmp_path)
    created = store.create(PromptTemplateCreate(name="hello", content="\u4f60\u597d"))
    assert created.scope == "global"
    assert created.session_id is None

    got = store.get(created.id)
    assert got is not None
    assert got.content == "\u4f60\u597d"

    updated = store.update(created.id, PromptTemplateUpdate(content="\u65b0\u5185\u5bb9"))
    assert updated is not None
    assert updated.content == "\u65b0\u5185\u5bb9"

    assert store.delete(created.id) is True
    assert store.get(created.id) is None
    assert store.delete(created.id) is False


def test_scope_isolation(tmp_path) -> None:
    store = make_store(tmp_path)
    store.create(PromptTemplateCreate(name="g", content="global"))
    store.create(
        PromptTemplateCreate(name="s", content="session", scope="session", session_id="s1")
    )

    assert [t.name for t in store.list(scope="global")] == ["g"]
    assert [t.name for t in store.list(scope="session")] == ["s"]
    assert [t.name for t in store.list(scope="session", session_id="s1")] == ["s"]
    assert store.list(scope="session", session_id="other") == []
    # No filter returns everything, ordered by position then creation.
    assert len(store.list()) == 2


def test_duplicate_name_rejected_in_same_partition(tmp_path) -> None:
    store = make_store(tmp_path)
    store.create(PromptTemplateCreate(name="dup", content="a"))
    with pytest.raises(ValueError):
        store.create(PromptTemplateCreate(name="dup", content="b"))
    # Same name in a different partition is fine.
    store.create(
        PromptTemplateCreate(name="dup", content="c", scope="session", session_id="s1")
    )


def test_update_rename_to_taken_name_rejected(tmp_path) -> None:
    store = make_store(tmp_path)
    first = store.create(PromptTemplateCreate(name="first", content="a"))
    store.create(PromptTemplateCreate(name="second", content="b"))
    # Renaming onto a taken name rejects; the stored row keeps its old name.
    with pytest.raises(ValueError):
        store.update(first.id, PromptTemplateUpdate(name="second"))
    kept = store.get(first.id)
    assert kept is not None and kept.name == "first"
    # Renaming onto a free name succeeds.
    renamed = store.update(first.id, PromptTemplateUpdate(name="renamed"))
    assert renamed is not None and renamed.name == "renamed"


def test_memory_database_never_touches_the_filesystem(monkeypatch) -> None:
    # The in-memory database must not mkdir/chmod the working directory.
    calls: list[str] = []
    monkeypatch.setattr("dsh_prompt_templates.db._ensure_private_dir", lambda p: calls.append(f"dir:{p}"))
    monkeypatch.setattr("dsh_prompt_templates.db._ensure_private_file", lambda p: calls.append(f"file:{p}"))
    store = PromptTemplateStore(":memory:")
    store.create(PromptTemplateCreate(name="m", content="x"))
    assert [t.name for t in store.list()] == ["m"]
    assert calls == []


def test_position_ordering(tmp_path) -> None:
    store = make_store(tmp_path)
    store.create(PromptTemplateCreate(name="a", content="a", position=2))
    store.create(PromptTemplateCreate(name="b", content="b", position=0))
    store.create(PromptTemplateCreate(name="c", content="c", position=1))
    assert [t.name for t in store.list()] == ["b", "c", "a"]


def test_update_absent_returns_none(tmp_path) -> None:
    store = make_store(tmp_path)
    assert store.update("missing", PromptTemplateUpdate(content="x")) is None


def test_make_global_moves_the_row_and_clears_session(tmp_path) -> None:
    store = make_store(tmp_path)
    created = store.create(
        PromptTemplateCreate(name="s", content="body", scope="session", session_id="s1")
    )
    promoted = store.make_global(created.id)
    assert promoted is not None
    assert promoted.scope == "global"
    assert promoted.session_id is None
    kept = store.get(created.id)
    assert kept is not None and kept.scope == "global" and kept.session_id is None


def test_make_global_rejects_global_name_collision(tmp_path) -> None:
    store = make_store(tmp_path)
    store.create(PromptTemplateCreate(name="dup", content="global"))
    session_row = store.create(
        PromptTemplateCreate(name="dup", content="session", scope="session", session_id="s1")
    )
    with pytest.raises(ValueError):
        store.make_global(session_row.id)
    kept = store.get(session_row.id)
    assert kept is not None and kept.scope == "session" and kept.session_id == "s1"


def test_make_global_rejects_already_global(tmp_path) -> None:
    store = make_store(tmp_path)
    created = store.create(PromptTemplateCreate(name="g", content="global"))
    with pytest.raises(ValueError):
        store.make_global(created.id)


def test_make_global_absent_returns_none(tmp_path) -> None:
    store = make_store(tmp_path)
    assert store.make_global("missing") is None
