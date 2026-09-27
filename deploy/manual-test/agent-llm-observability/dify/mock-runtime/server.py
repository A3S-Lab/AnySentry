#!/usr/bin/env python3
"""Binary-safe local OpenAI-compatible and HTTP-tool fixture.

The server deliberately never logs request headers or body content. It keeps only
bounded hashes/byte counts so Observer output can be reconciled without creating a
second plaintext-content sink.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import ssl
import threading
import time
import uuid
from collections import deque
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit


HTTP_PORT = int(os.environ.get("MOCK_HTTP_PORT", "8000"))
HTTPS_PORT = int(os.environ.get("MOCK_HTTPS_PORT", "443"))
ROLE = os.environ.get("MOCK_ROLE", "llm")
CERT_FILE = os.environ.get("MOCK_TLS_CERT_FILE", "/run/tls/server.crt")
KEY_FILE = os.environ.get("MOCK_TLS_KEY_FILE", "/run/tls/server.key")
API_KEY_FILE = os.environ.get("MOCK_API_KEY_FILE", "/run/secrets/mock-api-key")
MODEL_NAME = os.environ.get("MOCK_MODEL_NAME", "anysentry-observation-model")
MAX_BODY_BYTES = int(os.environ.get("MOCK_MAX_BODY_BYTES", str(4 * 1024 * 1024)))

_records: deque[dict[str, Any]] = deque(maxlen=128)
_records_lock = threading.Lock()


def _read_api_key() -> bytes:
    try:
        value = Path(API_KEY_FILE).read_bytes().strip()
    except OSError:
        value = b""
    return value


def _json_bytes(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def _sha256(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def _extract_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            if isinstance(item, dict) and isinstance(item.get("text"), str):
                parts.append(item["text"])
            elif isinstance(item, str):
                parts.append(item)
        return " ".join(parts)
    return ""


def _last_prompt(payload: dict[str, Any]) -> str:
    messages = payload.get("messages")
    if isinstance(messages, list):
        for message in reversed(messages):
            if isinstance(message, dict) and message.get("role") == "user":
                return _extract_text(message.get("content"))
    input_value = payload.get("input")
    return _extract_text(input_value)


class FixtureHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "AnySentryDifyFixture/1"
    sys_version = ""

    def log_message(self, _format: str, *_args: object) -> None:
        # BaseHTTPRequestHandler logs the raw target, which may contain sensitive
        # query parameters. Emit only the normalized path and status ourselves.
        return

    def _path(self) -> str:
        return urlsplit(self.path).path

    def _send_json(self, status: HTTPStatus, value: Any) -> bytes:
        body = _json_bytes(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        self.wfile.write(body)
        self.wfile.flush()
        return body

    def _authorized(self) -> bool:
        expected = _read_api_key()
        if not expected:
            return False
        supplied = self.headers.get("Authorization", "").encode("utf-8")
        return hmac.compare_digest(supplied, b"Bearer " + expected)

    def _read_body(self) -> bytes:
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("invalid content length") from exc
        if content_length < 0 or content_length > MAX_BODY_BYTES:
            raise ValueError("body exceeds fixture limit")
        return self.rfile.read(content_length)

    def _record(
        self,
        *,
        request_id: str,
        request_body: bytes,
        response_body: bytes,
        stream: bool,
        status: int,
    ) -> None:
        item = {
            "request_id": request_id,
            "role": ROLE,
            "method": self.command,
            "path": self._path(),
            "http_version": self.request_version,
            "stream": stream,
            "status": status,
            "request_bytes": len(request_body),
            "request_sha256": _sha256(request_body),
            "final_selected_rag_marker_present": b"ANYSENTRY_FINAL_SELECTED_RAG" in request_body,
            "internal_rag_sentinel_present": b"ANYSENTRY_INTERNAL_RAG_MUST_NOT_EGRESS" in request_body,
            "response_bytes": len(response_body),
            "response_sha256": _sha256(response_body),
            "recorded_at_unix_ns": time.time_ns(),
        }
        with _records_lock:
            _records.append(item)
        print(
            json.dumps(
                {
                    "event": "fixture_exchange",
                    "role": ROLE,
                    "path": item["path"],
                    "http_version": item["http_version"],
                    "stream": stream,
                    "status": status,
                    "request_bytes": item["request_bytes"],
                    "request_sha256": item["request_sha256"],
                    "final_selected_rag_marker_present": item["final_selected_rag_marker_present"],
                    "internal_rag_sentinel_present": item["internal_rag_sentinel_present"],
                    "response_bytes": item["response_bytes"],
                    "response_sha256": item["response_sha256"],
                },
                separators=(",", ":"),
            ),
            flush=True,
        )

    def do_GET(self) -> None:  # noqa: N802 - stdlib handler contract
        path = self._path()
        if path == "/health":
            self._send_json(HTTPStatus.OK, {"status": "ok", "role": ROLE})
            return
        if path == "/debug/records":
            with _records_lock:
                snapshot = list(_records)
            self._send_json(HTTPStatus.OK, {"data": snapshot})
            return
        if path in {"/models", "/v1/models"}:
            if not self._authorized():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": {"message": "unauthorized"}})
                return
            self._send_json(
                HTTPStatus.OK,
                {
                    "object": "list",
                    "data": [{"id": MODEL_NAME, "object": "model", "owned_by": "anysentry-fixture"}],
                },
            )
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "not found"}})

    def do_POST(self) -> None:  # noqa: N802 - stdlib handler contract
        path = self._path()
        if path == "/debug/reset":
            if not self._authorized():
                self._send_json(HTTPStatus.UNAUTHORIZED, {"error": {"message": "unauthorized"}})
                return
            with _records_lock:
                _records.clear()
            self._send_json(HTTPStatus.OK, {"result": "reset", "role": ROLE})
            return
        if path == "/tool/execute":
            self._handle_tool()
            return
        if path in {"/chat/completions", "/v1/chat/completions"}:
            self._handle_chat_completions()
            return
        if path in {"/responses", "/v1/responses"}:
            self._handle_responses()
            return
        self._send_json(HTTPStatus.NOT_FOUND, {"error": {"message": "not found"}})

    def _parse_payload(self) -> tuple[bytes, dict[str, Any]]:
        body = self._read_body()
        try:
            payload = json.loads(body)
        except json.JSONDecodeError as exc:
            raise ValueError("invalid json") from exc
        if not isinstance(payload, dict):
            raise ValueError("json body must be an object")
        return body, payload

    def _handle_tool(self) -> None:
        request_id = f"tool_{uuid.uuid4().hex}"
        try:
            request_body, payload = self._parse_payload()
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": str(exc)})
            return
        started_at = time.time_ns()
        instruction = _extract_text(payload.get("instruction"))
        result = {
            "tool_call_id": request_id,
            "status": "succeeded",
            "result": f"ANYSENTRY_TOOL_RESULT:{instruction[:256]}",
            "started_at_unix_ns": started_at,
            "finished_at_unix_ns": time.time_ns(),
        }
        response_body = self._send_json(HTTPStatus.OK, result)
        self._record(
            request_id=request_id,
            request_body=request_body,
            response_body=response_body,
            stream=False,
            status=HTTPStatus.OK,
        )

    def _handle_chat_completions(self) -> None:
        if not self._authorized():
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": {"message": "unauthorized"}})
            return
        request_id = f"chatcmpl-{uuid.uuid4().hex}"
        try:
            request_body, payload = self._parse_payload()
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": str(exc)}})
            return
        prompt = _last_prompt(payload)
        text = f"ANYSENTRY_DIFY_MOCK_RESPONSE: {prompt[:512]}"
        if payload.get("stream") is True:
            response_body = self._send_chat_stream(request_id, text)
            self._record(
                request_id=request_id,
                request_body=request_body,
                response_body=response_body,
                stream=True,
                status=HTTPStatus.OK,
            )
            return
        response = {
            "id": request_id,
            "object": "chat.completion",
            "created": int(time.time()),
            "model": payload.get("model") or MODEL_NAME,
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "content": text},
                    "finish_reason": "stop",
                }
            ],
            "usage": {"prompt_tokens": 17, "completion_tokens": 13, "total_tokens": 30},
        }
        response_body = self._send_json(HTTPStatus.OK, response)
        self._record(
            request_id=request_id,
            request_body=request_body,
            response_body=response_body,
            stream=False,
            status=HTTPStatus.OK,
        )

    def _write_http_chunk(self, payload: bytes) -> None:
        self.wfile.write(f"{len(payload):X}\r\n".encode("ascii"))
        self.wfile.write(payload)
        self.wfile.write(b"\r\n")
        self.wfile.flush()

    def _send_chat_stream(self, request_id: str, text: str) -> bytes:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Transfer-Encoding", "chunked")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        events: list[bytes] = []
        pieces = [text[:13], text[13:31], text[31:]]
        for index, piece in enumerate(pieces):
            value = {
                "id": request_id,
                "object": "chat.completion.chunk",
                "created": int(time.time()),
                "model": MODEL_NAME,
                "choices": [
                    {
                        "index": 0,
                        "delta": {"role": "assistant", "content": piece}
                        if index == 0
                        else {"content": piece},
                        "finish_reason": None,
                    }
                ],
            }
            events.append(b"data: " + _json_bytes(value) + b"\n\n")
        usage = {
            "id": request_id,
            "object": "chat.completion.chunk",
            "created": int(time.time()),
            "model": MODEL_NAME,
            "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": 17, "completion_tokens": 13, "total_tokens": 30},
        }
        events.append(b"data: " + _json_bytes(usage) + b"\n\n")
        events.append(b"data: [DONE]\n\n")
        response_body = b"".join(events)

        # Split at awkward byte boundaries, including inside JSON/SSE records. The
        # chunk framing remains valid while the client and Observer must reassemble.
        cursor = 0
        split_sizes = (1, 2, 5, 3, 13, 8, 21, 7, 34)
        split_index = 0
        while cursor < len(response_body):
            size = split_sizes[split_index % len(split_sizes)]
            part = response_body[cursor : cursor + size]
            self._write_http_chunk(part)
            cursor += len(part)
            split_index += 1
            time.sleep(0.003)
        self.wfile.write(b"0\r\n\r\n")
        self.wfile.flush()
        return response_body

    def _handle_responses(self) -> None:
        if not self._authorized():
            self._send_json(HTTPStatus.UNAUTHORIZED, {"error": {"message": "unauthorized"}})
            return
        request_id = f"resp_{uuid.uuid4().hex}"
        try:
            request_body, payload = self._parse_payload()
        except ValueError as exc:
            self._send_json(HTTPStatus.BAD_REQUEST, {"error": {"message": str(exc)}})
            return
        text = f"ANYSENTRY_DIFY_MOCK_RESPONSE: {_last_prompt(payload)[:512]}"
        response = {
            "id": request_id,
            "object": "response",
            "created_at": time.time(),
            "status": "completed",
            "model": payload.get("model") or MODEL_NAME,
            "output": [
                {
                    "id": f"msg_{uuid.uuid4().hex}",
                    "type": "message",
                    "role": "assistant",
                    "status": "completed",
                    "content": [{"type": "output_text", "text": text, "annotations": []}],
                }
            ],
            "usage": {"input_tokens": 17, "output_tokens": 13, "total_tokens": 30},
        }
        response_body = self._send_json(HTTPStatus.OK, response)
        self._record(
            request_id=request_id,
            request_body=request_body,
            response_body=response_body,
            stream=False,
            status=HTTPStatus.OK,
        )


def _serve(port: int, *, tls: bool) -> None:
    server = ThreadingHTTPServer(("0.0.0.0", port), FixtureHandler)
    if tls:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(CERT_FILE, KEY_FILE)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    print(
        json.dumps(
            {"event": "fixture_ready", "role": ROLE, "tls": tls, "port": port},
            separators=(",", ":"),
        ),
        flush=True,
    )
    server.serve_forever(poll_interval=0.25)


def main() -> None:
    http_thread = threading.Thread(target=_serve, args=(HTTP_PORT,), kwargs={"tls": False}, daemon=True)
    http_thread.start()
    _serve(HTTPS_PORT, tls=True)


if __name__ == "__main__":
    main()
