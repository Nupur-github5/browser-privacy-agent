import pytest

from app.agent import agent_step
from app.llm import GroqClient
from app.schemas import AgentStepRequest, Element, SanitizedState


def make_state(**overrides):
    base = dict(
        state_id="state_abc123",
        url="http://127.0.0.1/employee-portal.html",
        title="Employee Portal",
        task="fill this form with test data and submit",
        elements=[
            Element(target_id=1, role="textbox", label="Full Name", type="text", value=""),
            Element(target_id=2, role="button", label="Submit", type="submit", value=""),
        ],
        available_tokens=[],
    )
    base.update(overrides)
    return SanitizedState(**base)


class FakeLLM(GroqClient):
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = []

    def is_configured(self):
        return True

    async def chat(self, messages, temperature=0.2, json_mode=True):
        self.calls.append(messages)
        return self._responses.pop(0)


@pytest.mark.asyncio
async def test_valid_action_passes_through():
    llm = FakeLLM(['{"action": "type", "target_id": 1, "value": "Asha Verma", "reason": "fill name"}'])
    req = AgentStepRequest(state=make_state())
    resp = await agent_step(req, llm=llm)
    assert resp.action["action"] == "type"
    assert resp.action["target_id"] == 1
    assert resp.repaired is False


@pytest.mark.asyncio
async def test_unknown_target_id_triggers_repair_and_recovers():
    llm = FakeLLM([
        '{"action": "click", "target_id": 999, "reason": "bad"}',
        '{"action": "click", "target_id": 2, "reason": "submit"}',
    ])
    req = AgentStepRequest(state=make_state())
    resp = await agent_step(req, llm=llm)
    assert resp.action == {"action": "click", "target_id": 2, "reason": "submit"}
    assert resp.repaired is True
    assert len(llm.calls) == 2


@pytest.mark.asyncio
async def test_markdown_fenced_json_is_stripped():
    llm = FakeLLM(['```json\n{"action": "done", "reason": "finished"}\n```'])
    req = AgentStepRequest(state=make_state())
    resp = await agent_step(req, llm=llm)
    assert resp.action["action"] == "done"


@pytest.mark.asyncio
async def test_token_not_in_available_tokens_is_rejected_then_repaired():
    llm = FakeLLM([
        '{"action": "type", "target_id": 1, "value": "[NAME_1]", "reason": "fill"}',
        '{"action": "type", "target_id": 1, "value": "[NAME_2]", "reason": "fill"}',
    ])
    req = AgentStepRequest(state=make_state(available_tokens=["[NAME_2]"]))
    resp = await agent_step(req, llm=llm)
    assert resp.action["value"] == "[NAME_2]"
    assert resp.repaired is True


@pytest.mark.asyncio
async def test_persistent_garbage_falls_back_to_done():
    llm = FakeLLM(["not json at all", "still not json"])
    req = AgentStepRequest(state=make_state())
    resp = await agent_step(req, llm=llm)
    assert resp.action["action"] == "done"
    assert resp.repaired is True
