"""NOOA worker executed inside an OpenShell sandbox.

The Node runner writes a small trusted input document and streams this worker's
JSON lines back to the Canvas. It deliberately accepts no network, policy,
workspace host path, or credential input from the browser.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import traceback
from pathlib import Path
from typing import Any

from nooa import Agent, CodeActStrategy, strategy
from nooa.config import CodeActConfig
from nooa.unifiedllm.registry import get_llm_client


def emit(kind: str, **payload: Any) -> None:
    print(json.dumps({"kind": kind, **payload}, ensure_ascii=False, default=str), flush=True)


def json_value(value: Any) -> Any:
    """Keep the streaming protocol JSON-safe and bounded to event fields."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, list):
        return [json_value(item) for item in value]
    if isinstance(value, dict):
        return {str(key): json_value(item) for key, item in value.items()}
    if hasattr(value, "model_dump"):
        try:
            return json_value(value.model_dump(mode="json"))
        except Exception:  # noqa: BLE001 - tracing must never stop the run
            return str(value)
    return str(value)


def event_payload(event: Any) -> dict[str, Any]:
    event_type = str(getattr(event, "event_type", type(event).__name__)).lower()
    if hasattr(event, "model_dump"):
        try:
            body = json_value(event.model_dump(mode="json"))
        except Exception:  # noqa: BLE001 - an event may contain arbitrary values
            body = {"text": str(event)}
    else:
        body = {"text": str(event)}
    return {"eventType": event_type, "data": body}


INPUT_PATH = Path(os.environ.get("NOOA_INPUT_PATH", "/sandbox/.nodes/run.json"))
MODEL = os.environ.get("NOOA_MODEL", "gpt-5-mini")
MAX_ITERATIONS = int(os.environ.get("NOOA_MAX_ITERATIONS", "12"))
LLM = get_llm_client(MODEL)


class CanvasAgent(Agent, llm=LLM):
    """You are a careful software agent operating in an isolated workspace snapshot.

    Work only inside the supplied workspace path. Inspect before changing files,
    keep the task scoped, and finish with a concise account of what you did. The
    workspace is a snapshot: do not claim that edits have been applied to the
    host machine.
    """

    @strategy(CodeActStrategy(config=CodeActConfig(max_iterations=MAX_ITERATIONS)))
    async def execute(self, task: str, workspace_path: str | None, role: str) -> str:
        """Carry out the requested task.

        The task is: {task}

        The supplied role is {role}. If workspace_path is present, it points to
        the only uploaded project snapshot available to you. Use normal Python
        tools to inspect it and perform work inside that path. Return a concise
        final answer describing results, files changed in the snapshot, and any
        follow-up that needs a human.
        """


async def main() -> None:
    try:
        request = json.loads(INPUT_PATH.read_text(encoding="utf-8"))
        if not isinstance(request, dict):
            raise ValueError("Runner input must be a JSON object.")
        prompt = request.get("prompt")
        if not isinstance(prompt, str) or not prompt.strip():
            raise ValueError("Runner input is missing a prompt.")

        workspace = request.get("workspace")
        workspace_path = workspace.get("path") if isinstance(workspace, dict) else None
        if workspace_path is not None and not isinstance(workspace_path, str):
            raise ValueError("Runner workspace path must be a string.")
        role = request.get("role") if isinstance(request.get("role"), str) else "custom"

        agent = CanvasAgent()
        agent.event_manager.on("*", lambda event: emit("event", event=event_payload(event)))
        result = await agent.execute(prompt.strip(), workspace_path, role)
        emit("result", result={"text": json_value(result), "model": MODEL})
    except Exception as error:  # noqa: BLE001 - report a structured terminal runner event
        emit(
            "error",
            error={
                "message": str(error),
                "type": type(error).__name__,
                "traceback": traceback.format_exc(limit=12),
            },
        )
        raise


if __name__ == "__main__":
    asyncio.run(main())
