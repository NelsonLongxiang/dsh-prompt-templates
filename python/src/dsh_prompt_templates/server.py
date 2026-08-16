"""Newline-delimited JSON-RPC 2.0 server over stdio.

The Host bridge spawns `dsh-prompt-templates serve` and exchanges one JSON
object per line: requests carry `{"jsonrpc":"2.0","id",...,"method",...,
"params":{}}` and responses echo the id with `result` or `error`.
Notifications (no `id`) are processed without a response.

Methods are `<domain>/<operation>` (`templates/list`). The domain is created
lazily on its first request, so a child serving only templates never creates
another domain's database file."""

from __future__ import annotations

import json
import sys
from typing import Any, BinaryIO, Callable, Optional, Protocol

from .models import PromptTemplateCreate, PromptTemplateUpdate
from .store import PromptTemplateStore


def _error(code: int, message: str, data: Any = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"code": code, "message": message}
    if data is not None:
        payload["data"] = data
    return payload


def require_id(params: dict[str, Any]) -> str:
    """Extract the required template id as a business error when malformed."""
    value = params.get("id")
    if not isinstance(value, str) or value == "":
        raise ValueError("template id must be a non-empty string")
    return value


class Domain(Protocol):
    """One extension domain: dispatch `<operation>` within its namespace."""

    def dispatch(self, operation: str, params: dict[str, Any]) -> Any: ...


class TemplateDomain:
    """The prompt-template domain over one {@link PromptTemplateStore}."""

    def __init__(self, store: PromptTemplateStore) -> None:
        self._store = store

    def dispatch(self, operation: str, params: dict[str, Any]) -> Any:
        if operation == "list":
            return [
                template.model_dump(mode="json")
                for template in self._store.list(
                    scope=params.get("scope"), session_id=params.get("session_id")
                )
            ]
        if operation == "get":
            template_id = require_id(params)
            template = self._store.get(template_id)
            return template.model_dump(mode="json") if template is not None else None
        if operation == "create":
            data = PromptTemplateCreate.model_validate(params)
            return self._store.create(data).model_dump(mode="json")
        if operation == "update":
            template_id = require_id(params)
            patch = PromptTemplateUpdate.model_validate(
                {key: value for key, value in params.items() if key != "id"}
            )
            template = self._store.update(template_id, patch)
            return template.model_dump(mode="json") if template is not None else None
        if operation == "make_global":
            template = self._store.make_global(require_id(params))
            return template.model_dump(mode="json") if template is not None else None
        if operation == "delete":
            return self._store.delete(require_id(params))
        raise ValueError(f"unknown method: templates/{operation}")


def default_domains(
    templates_db: Optional[str] = None,
) -> dict[str, Callable[[], Domain]]:
    """The production domain table: every domain the
    `dsh-prompt-templates serve` child exposes, created lazily on first use.

    The domain resolves its own default database path; the argument overrides
    it (the Host bridge forwards `--db`)."""
    from .db import default_db_path

    def _templates() -> Domain:
        return TemplateDomain(PromptTemplateStore(templates_db or default_db_path()))

    return {"templates": _templates}


class JsonRpcServer:
    """Serve every extension domain over newline-delimited JSON-RPC 2.0."""

    def __init__(self, domains: dict[str, Callable[[], Domain]]) -> None:
        self._factories = domains
        self._domains: dict[str, Domain] = {}

    def _domain(self, namespace: str) -> Domain:
        domain = self._domains.get(namespace)
        if domain is None:
            factory = self._factories.get(namespace)
            if factory is None:
                raise ValueError(f"unknown method namespace: {namespace}")
            domain = factory()
            self._domains[namespace] = domain
        return domain

    def handle(self, request: dict[str, Any]) -> Optional[dict[str, Any]]:
        """Handle one parsed request; `None` for notifications."""
        method = request.get("method")
        params = request.get("params") or {}
        request_id = request.get("id")
        try:
            result = self._dispatch(method, params)
        except ValueError as exc:
            return self._response(request_id, error=_error(-32000, str(exc)))
        except Exception as exc:  # noqa: BLE001 -- reported to the peer, never raised
            return self._response(
                request_id, error=_error(-32603, f"internal error: {exc}")
            )
        if request_id is None:
            return None
        return self._response(request_id, result=result)

    def _dispatch(self, method: Optional[str], params: dict[str, Any]) -> Any:
        if not isinstance(method, str) or "/" not in method:
            raise ValueError(f"unknown method: {method}")
        namespace, _, operation = method.partition("/")
        return self._domain(namespace).dispatch(operation, params)

    def _response(
        self,
        request_id: Any,
        result: Any = None,
        error: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": request_id}
        if error is not None:
            payload["error"] = error
        else:
            payload["result"] = result
        return payload

    def serve(
        self,
        stdin: BinaryIO = sys.stdin.buffer,
        stdout: BinaryIO = sys.stdout.buffer,
    ) -> None:
        """Read requests line by line until EOF, writing one response per request."""
        for raw in stdin:
            line = raw.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except json.JSONDecodeError as exc:
                response = self._response(
                    None, error=_error(-32700, f"parse error: {exc}")
                )
                stdout.write(json.dumps(response).encode("utf-8") + b"\n")
                stdout.flush()
                continue
            response = self.handle(request)
            if response is not None:
                stdout.write(json.dumps(response).encode("utf-8") + b"\n")
                stdout.flush()
