import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

load_dotenv()

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
