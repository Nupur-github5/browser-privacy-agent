import json
import os
import time
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .agent import agent_step
from .llm import LLMError
from .schemas import AgentStepRequest, AgentStepResponse

load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")

# Privacy proof: when enabled, every /agent/step request this server actually
# received (not what the client claims to have sent) is appended verbatim to
# a JSONL log. eval/ and the demo read this file to prove no raw PII ever
# reached the server — see PVA_LOG_PAYLOADS in server/.env.example.
PAYLOAD_LOG_PATH = Path(__file__).resolve().parent.parent.parent / "eval" / "network-payload.jsonl"


def log_payload(req: AgentStepRequest) -> None:
    if not os.getenv("PVA_LOG_PAYLOADS"):
        return
    PAYLOAD_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(PAYLOAD_LOG_PATH, "a") as f:
        f.write(json.dumps({"ts": time.time(), "path": "/agent/step", "body": req.model_dump()}) + "\n")

CONFIG_PATH = Path(__file__).resolve().parent.parent / "config.json"
config = json.loads(CONFIG_PATH.read_text()) if CONFIG_PATH.exists() else {}

app = FastAPI(title="Privacy-Preserving Vision Agent Server", version="0.1.0")

allow_origins = config.get("cors_allow_origins", ["http://localhost:*", "chrome-extension://*"])
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^(chrome-extension://.*|https?://localhost(:\d+)?|https?://127\.0\.0\.1(:\d+)?)$",
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/agent/step", response_model=AgentStepResponse)
async def agent_step_endpoint(req: AgentStepRequest):
    log_payload(req)
    try:
        return await agent_step(req)
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
