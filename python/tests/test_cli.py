import json

from typer.testing import CliRunner

from dsh_prompt_templates.cli import app

runner = CliRunner()


def test_add_list_get_remove(tmp_path) -> None:
    db = tmp_path / "db.sqlite3"
    result = runner.invoke(app, ["templates", "add", "hello", "\u4f60\u597d", "--db", str(db)])
    assert result.exit_code == 0, result.output
    template_id = result.output.strip()

    result = runner.invoke(app, ["templates", "list", "--db", str(db), "--json"])
    assert result.exit_code == 0, result.output
    items = json.loads(result.output)
    assert len(items) == 1
    assert items[0]["id"] == template_id
    assert items[0]["name"] == "hello"
    assert items[0]["scope"] == "global"

    result = runner.invoke(app, ["templates", "get", template_id, "--db", str(db), "--json"])
    assert result.exit_code == 0, result.output
    assert json.loads(result.output)["content"] == "\u4f60\u597d"

    result = runner.invoke(
        app, ["templates", "update", template_id, "--content", "new", "--db", str(db)]
    )
    assert result.exit_code == 0, result.output

    result = runner.invoke(app, ["templates", "remove", template_id, "--db", str(db)])
    assert result.exit_code == 0, result.output
    result = runner.invoke(app, ["templates", "list", "--db", str(db), "--json"])
    assert json.loads(result.output) == []


def test_add_requires_session_id_for_session_scope(tmp_path) -> None:
    db = tmp_path / "db.sqlite3"
    result = runner.invoke(
        app, ["templates", "add", "s", "body", "--scope", "session", "--db", str(db)]
    )
    assert result.exit_code == 1
    assert "session_id" in result.output


def test_init_creates_db(tmp_path) -> None:
    db = tmp_path / "sub" / "db.sqlite3"
    result = runner.invoke(app, ["init", "--db", str(db)])
    assert result.exit_code == 0, result.output
    assert db.exists()
