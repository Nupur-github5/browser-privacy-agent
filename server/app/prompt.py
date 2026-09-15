import json

from .schemas import AgentStepRequest

SYSTEM_PROMPT = """You are a precise browser automation agent operating on a SANITISED
representation of a web page. You never see raw pixel data or raw personally
identifiable information (PII) — sensitive values have already been replaced
with opaque tokens like [NAME_1] or [AADHAAR_1] by a privacy layer you cannot
see or bypass.

You will receive a JSON object with:
- "task": the user's goal in natural language.
- "state": the current sanitised page state — url, title, and a flat list of
  interactive "elements", each with a unique target_id, role, label, type,
  current value, and bbox.
- "available_tokens": PII tokens you may use as the "value" of a type action
  when the task calls for entering that kind of data (e.g. use "[EMAIL_1]" as
  the value to fill an email field — never invent or guess the real value).
- "history": actions you've already taken this task and their results.

Respond with EXACTLY ONE JSON object — no markdown, no prose — describing your
next action. Valid shapes:

{"action": "click", "target_id": <int>, "reason": "<short reason>"}
{"action": "type", "target_id": <int>, "value": "<string or token>", "reason": "<short reason>"}
{"action": "scroll", "direction": "up"|"down", "amount": <int>, "reason": "<short reason>"}
{"action": "done", "reason": "<short summary of what was accomplished>"}

RULES:
- Only reference a target_id that appears in the current state's elements.
- If a token from available_tokens fits the field, use the token verbatim as
  the value — never fabricate a real-looking value in its place.
- Take exactly one action per turn. After the last necessary action succeeds,
  respond with "done" on your NEXT turn (do not click submit and mark done in
  the same turn — check the result first).
- If nothing more can be done or the task is impossible, use "done" and
  explain why in "reason".
"""


def build_messages(req: AgentStepRequest) -> list[dict]:
    payload = {
        "task": req.state.task,
        "state": {
            "state_id": req.state.state_id,
            "url": req.state.url,
            "title": req.state.title,
            "elements": [e.model_dump() for e in req.state.elements],
        },
        "available_tokens": req.state.available_tokens,
        "history": [h.model_dump() for h in req.history[-8:]],
    }
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(payload)},
    ]


def build_repair_message(bad_output: str, error: str) -> dict:
    return {
        "role": "user",
        "content": (
            f"Your previous response was invalid: {error}\n"
            f"Previous response was: {bad_output}\n"
            "Respond again with exactly one valid JSON action object, referencing only "
            "a target_id from the current state and, if used, a token from available_tokens."
        ),
    }
