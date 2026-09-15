import json
import re

from pydantic import TypeAdapter, ValidationError

from .llm import GroqClient, LLMError
from .prompt import build_messages, build_repair_message
from .schemas import Action, AgentStepRequest, AgentStepResponse

TOKEN_RE = re.compile(r"^\[[A-Z_]+_\d+\]$")

_action_adapter = TypeAdapter(Action)


class ActionValidationError(Exception):
    pass


def parse_action(raw: str):
    raw = raw.strip()
    # Strip markdown code fences if the model added them despite instructions.
    if raw.startswith("```"):
        raw = re.sub(r"^```[a-zA-Z]*\n?", "", raw)
        raw = re.sub(r"\n?```$", "", raw)
    data = json.loads(raw)
    return _action_adapter.validate_python(data)


def validate_action(action, state) -> None:
    valid_target_ids = {e.target_id for e in state.elements}

    target_id = getattr(action, "target_id", None)
    if target_id is not None and target_id not in valid_target_ids:
        raise ActionValidationError(f"target_id {target_id} not found in current state")

    value = getattr(action, "value", None)
    if isinstance(value, str) and TOKEN_RE.match(value):
        if value not in state.available_tokens:
            raise ActionValidationError(f"token {value} not in available_tokens")


async def agent_step(req: AgentStepRequest, llm: GroqClient | None = None) -> AgentStepResponse:
    llm = llm or GroqClient()
    messages = build_messages(req)

    last_error = None
    last_raw = None
    had_generation = False
    max_attempts = 3
    for attempt in range(max_attempts):
        if attempt > 0 and had_generation and last_error and last_raw:
            messages.append({"role": "assistant", "content": last_raw})
            messages.append(build_repair_message(last_raw, last_error))

        try:
            raw = await llm.chat(messages)
        except LLMError as e:
            # Transient provider-side failures (e.g. Groq's own JSON-mode
            # validation occasionally fails and returns an empty generation)
            # count as one failed attempt rather than aborting the whole
            # step — a straight retry with the same messages usually
            # succeeds, so no repair message is appended (there is no bad
            # generation to show the model).
            if attempt == max_attempts - 1:
                raise
            last_error = str(e)
            had_generation = False
            continue

        had_generation = True
        last_raw = raw
        try:
            action = parse_action(raw)
            validate_action(action, req.state)
            return AgentStepResponse(
                action=action.model_dump(),
                repaired=attempt > 0,
                raw_llm_output=raw,
            )
        except (json.JSONDecodeError, ValidationError, ActionValidationError) as e:
            last_error = str(e)
            continue

    return AgentStepResponse(
        action={"action": "done", "reason": f"agent could not produce a valid action: {last_error}"},
        repaired=True,
        raw_llm_output=last_raw,
    )
