import asyncio
import json
import sys
import types
import unittest
from unittest.mock import patch


base_module = types.ModuleType("harbor.agents.base")


class BaseAgent:
    def __init__(self, *args, **kwargs):
        pass


base_module.BaseAgent = BaseAgent
sys.modules["harbor"] = types.ModuleType("harbor")
sys.modules["harbor.agents"] = types.ModuleType("harbor.agents")
sys.modules["harbor.agents.base"] = base_module

from relay_agent import RelayAgent


class Reader:
    def __init__(self, request):
        self._request = request

    async def readline(self):
        if self._request is not None:
            request, self._request = self._request, None
            return (json.dumps(request) + "\n").encode()
        await asyncio.Future()


class Writer:
    def write(self, value):
        pass

    async def drain(self):
        pass

    def close(self):
        pass

    async def wait_closed(self):
        pass


class Environment:
    def __init__(self):
        self.active = False
        self.commands = []
        self._terminated = asyncio.Event()

    async def exec(self, command, **kwargs):
        self.commands.append(command)
        if command.startswith("setsid "):
            self.active = True
            await self._terminated.wait()
            self.active = False
            return types.SimpleNamespace(return_code=143, stdout="")
        if command.startswith("kill -TERM"):
            self._terminated.set()
        return types.SimpleNamespace(return_code=0, stdout="")


class RelayAgentTest(unittest.IsolatedAsyncioTestCase):
    async def test_framework_timeout_settles_subject_before_returning(self):
        environment = Environment()
        request = {
            "token": "token",
            "kind": "execute",
            "command": "subject",
            "args": [],
            "cwd": "/app",
            "env": {},
        }
        agent = RelayAgent(relay_host="host", relay_port=1, relay_token="token")
        with patch("relay_agent.asyncio.open_connection", return_value=(Reader(request), Writer())):
            with self.assertRaises(TimeoutError):
                await asyncio.wait_for(agent.run("task", environment, None), timeout=0.01)

        self.assertFalse(environment.active)
        self.assertTrue(any(command.startswith("kill -TERM") for command in environment.commands))


if __name__ == "__main__":
    unittest.main()
