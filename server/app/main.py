import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from .agent import agent_step
from .llm import LLMError
from .schemas import AgentStepRequest, AgentStepResponse

load_dotenv(dotenv_path=Path(__file__).resolve().parent.parent / ".env")

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
    try:
        return await agent_step(req)
    except LLMError as e:
        raise HTTPException(status_code=502, detail=str(e))
