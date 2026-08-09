"""Harbor Agent that relays exactly one subject execution back to @maka/eval."""

from __future__ import annotations

import asyncio
import contextlib
import json
import shlex
from typing import Any

try:
    from pier.agents.base import BaseAgent
except ModuleNotFoundError as error:
    if error.name != "pier":
        raise
    from harbor.agents.base import BaseAgent


class RelayAgent(BaseAgent):
    def __init__(self, *args: Any, relay_host: str, relay_port: int, relay_token: str, **kwargs: Any):
        super().__init__(*args, **kwargs)
        self._host = relay_host
        self._port = relay_port
        self._token = relay_token

    @staticmethod
    def name() -> str:
        return "maka-eval-relay"

    def version(self) -> str:
        return "1"

    async def setup(self, environment: Any) -> None:
        return None

    async def run(self, instruction: str, environment: Any, context: Any) -> None:
        reader, writer = await asyncio.open_connection(self._host, self._port)
        await _send(writer, {"token": self._token, "kind": "ready", "instruction": instruction})
        request = json.loads(await reader.readline())
        if request.get("token") != self._token or request.get("kind") != "execute":
            raise RuntimeError("invalid Maka Eval relay request")
        command = shlex.join([request["command"], *request["args"]])
        scope_path = f"/tmp/maka-eval-{self._token}.pid"
        scoped_command = f"setsid sh -c {shlex.quote(f'echo $$ > {scope_path}; exec {command}')}"
        execution = asyncio.create_task(
            environment.exec(scoped_command, cwd=request["cwd"], env=request["env"])
        )
        control = asyncio.create_task(reader.readline())
        try:
            done, _ = await asyncio.wait(
                {execution, control}, return_when=asyncio.FIRST_COMPLETED
            )
            if control in done:
                cancellation = json.loads(control.result())
                if cancellation.get("token") != self._token or cancellation.get("kind") != "cancel":
                    raise RuntimeError("invalid Maka Eval relay control")
                await _settle(environment, request, scope_path, execution)
                return_code, stdout = 130, ""
            else:
                result = execution.result()
                return_code, stdout = result.return_code, result.stdout or ""
            await _send(
                writer,
                {
                    "token": self._token,
                    "kind": "executed",
                    "exitCode": return_code,
                    "stdout": stdout,
                },
            )
        except BaseException:
            await _settle(environment, request, scope_path, execution)
            raise
        finally:
            control.cancel()
            with contextlib.suppress(BaseException):
                await control
            writer.close()
            await writer.wait_closed()


async def _send(writer: asyncio.StreamWriter, value: object) -> None:
    writer.write((json.dumps(value, separators=(",", ":")) + "\n").encode())
    await writer.drain()


async def _settle(environment: Any, request: dict[str, Any], scope_path: str, execution: Any) -> None:
    if execution.done():
        return
    cancel = request.get("cancel")
    if isinstance(cancel, dict):
        with contextlib.suppress(Exception):
            await environment.exec(
                shlex.join([cancel["command"], *cancel["args"]]),
                cwd=request["cwd"],
                env=request["env"],
                timeout_sec=10,
            )
    with contextlib.suppress(Exception):
        await environment.exec(
            f"kill -TERM -- -$(cat {shlex.quote(scope_path)})",
            cwd=request["cwd"],
            timeout_sec=10,
        )
    try:
        await asyncio.wait_for(asyncio.shield(execution), timeout=10)
    except TimeoutError:
        with contextlib.suppress(Exception):
            await environment.exec(
                f"kill -KILL -- -$(cat {shlex.quote(scope_path)})",
                cwd=request["cwd"],
                timeout_sec=10,
            )
        execution.cancel()
        await asyncio.wait({execution}, timeout=1)
