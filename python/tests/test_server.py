import io
import json

from dsh_prompt_templates.server import JsonRpcServer, TemplateDomain
from dsh_prompt_templates.store import PromptTemplateStore


def make_server(tmp_path) -> JsonRpcServer:
    store = PromptTemplateStore(tmp_path / "db.sqlite3")
    return JsonRpcServer({"templates": lambda: TemplateDomain(store)})


def _run(server: JsonRpcServer, lines: list[dict]) -> list[dict]:
    payload = "".join(json.dumps(line) + "\n" for line in lines)
    stdout = io.BytesIO()
    server.serve(io.BytesIO(payload.encode("utf-8")), stdout)
    return [json.loads(line) for line in stdout.getvalue().decode("utf-8").splitlines() if line]


def test_list_empty(tmp_path) -> None:
    responses = _run(make_server(tmp_path), [{"jsonrpc": "2.0", "id": 1, "method": "templates/list", "params": {}}])
    assert responses == [{"jsonrpc": "2.0", "id": 1, "result": []}]


def test_create_then_list_and_get(tmp_path) -> None:
    server = make_server(tmp_path)
    responses = _run(server, [
        {"jsonrpc": "2.0", "id": 1, "method": "templates/create", "params": {"name": "x", "content": "body"}},
        {"jsonrpc": "2.0", "id": 2, "method": "templates/list", "params": {}},
    ])
    assert "error" not in responses[0] and "id" in responses[0]["result"]
    template_id = responses[0]["result"]["id"]
    assert responses[1]["result"][0]["id"] == template_id

    responses = _run(server, [{"jsonrpc": "2.0", "id": 3, "method": "templates/get", "params": {"id": template_id}}])
    assert responses[0]["result"]["content"] == "body"


def test_update_and_delete(tmp_path) -> None:
    server = make_server(tmp_path)
    created = _run(server, [{"jsonrpc": "2.0", "id": 1, "method": "templates/create", "params": {"name": "x", "content": "a"}}])[0]["result"]
    template_id = created["id"]

    responses = _run(server, [
        {"jsonrpc": "2.0", "id": 2, "method": "templates/update", "params": {"id": template_id, "content": "b"}},
        {"jsonrpc": "2.0", "id": 3, "method": "templates/delete", "params": {"id": template_id}},
        {"jsonrpc": "2.0", "id": 4, "method": "templates/list", "params": {}},
    ])
    assert responses[0]["result"]["content"] == "b"
    assert responses[1]["result"] is True
    assert responses[2]["result"] == []


def test_make_global_promotes_and_reports_absent(tmp_path) -> None:
    server = make_server(tmp_path)
    created = _run(server, [
        {"jsonrpc": "2.0", "id": 1, "method": "templates/create", "params": {"name": "s", "content": "a", "scope": "session", "session_id": "s1"}},
    ])[0]["result"]
    responses = _run(server, [
        {"jsonrpc": "2.0", "id": 2, "method": "templates/make_global", "params": {"id": created["id"]}},
        {"jsonrpc": "2.0", "id": 3, "method": "templates/make_global", "params": {"id": "missing"}},
        {"jsonrpc": "2.0", "id": 4, "method": "templates/make_global", "params": {"id": created["id"]}},
    ])
    assert responses[0]["result"]["scope"] == "global"
    assert responses[0]["result"]["session_id"] is None
    assert responses[1]["result"] is None
    assert responses[2]["error"]["code"] == -32000
    assert "already global" in responses[2]["error"]["message"]


def test_validation_error_is_reported(tmp_path) -> None:
    responses = _run(make_server(tmp_path), [
        {"jsonrpc": "2.0", "id": 1, "method": "templates/create", "params": {"name": "x", "content": "y", "scope": "session"}},
    ])
    assert responses[0]["error"]["code"] == -32000
    assert "session_id" in responses[0]["error"]["message"]


def test_unknown_method_is_reported(tmp_path) -> None:
    responses = _run(make_server(tmp_path), [
        {"jsonrpc": "2.0", "id": 1, "method": "templates/nope", "params": {}},
    ])
    assert responses[0]["error"]["code"] == -32000
    assert "unknown method" in responses[0]["error"]["message"]


def test_missing_id_is_a_business_error(tmp_path) -> None:
    responses = _run(make_server(tmp_path), [
        {"jsonrpc": "2.0", "id": 1, "method": "templates/delete", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "templates/get", "params": {"id": ""}},
    ])
    assert responses[0]["error"]["code"] == -32000
    assert "non-empty string" in responses[0]["error"]["message"]
    assert responses[1]["error"]["code"] == -32000


def test_notification_gets_no_response(tmp_path) -> None:
    responses = _run(make_server(tmp_path), [
        {"jsonrpc": "2.0", "method": "templates/list", "params": {}},
    ])
    assert responses == []


def test_parse_error(tmp_path) -> None:
    stdout = io.BytesIO()
    server = make_server(tmp_path)
    server.serve(io.BytesIO(b"{not json}\n"), stdout)
    response = json.loads(stdout.getvalue().decode("utf-8"))
    assert response["error"]["code"] == -32700
