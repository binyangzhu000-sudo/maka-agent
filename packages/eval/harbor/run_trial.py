"""Run one Harbor or Pier Trial from its canonical config."""

from __future__ import annotations

import asyncio
import importlib
import sys
from pathlib import Path


async def main() -> None:
    framework, config_path = sys.argv[1:]
    if framework not in {"harbor", "pier"}:
        raise ValueError("framework must be harbor or pier")
    config_module = importlib.import_module(f"{framework}.models.trial.config")
    trial_module = importlib.import_module(f"{framework}.trial.trial")
    config = config_module.TrialConfig.model_validate_json(Path(config_path).read_text())
    trial = await trial_module.Trial.create(config)
    await trial.run()


asyncio.run(main())
