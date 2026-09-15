import asyncio
import os

import httpx


class LLMError(Exception):
    pass


class GroqClient:
    """Thin wrapper over Groq's OpenAI-compatible chat completions endpoint."""

    BASE_URL = "https://api.groq.com/openai/v1/chat/completions"

    def __init__(self, api_key: str | None = None, model: str | None = None):
        self.api_key = api_key or os.getenv("GROQ_API_KEY", "").strip()
        self.model = model or os.getenv("GROQ_MODEL", "openai/gpt-oss-20b")

    def is_configured(self) -> bool:
        return bool(self.api_key)

    async def chat(self, messages: list[dict], temperature: float = 0.2, json_mode: bool = True) -> str:
        if not self.is_configured():
            raise LLMError("GROQ_API_KEY is not set. Copy server/.env.example to server/.env and fill it in.")

        body = {
            "model": self.model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": 1024,
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        if self.model.startswith("openai/gpt-oss"):
            # gpt-oss models emit hidden chain-of-thought tokens by default,
            # which blows through the free-tier TPM budget in a few steps.
            # We only need the final action JSON, so keep reasoning minimal.
            body["reasoning_effort"] = "medium"

        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {self.api_key}",
        }

        max_retries = 3
        async with httpx.AsyncClient(timeout=30.0) as client:
            for attempt in range(max_retries + 1):
                try:
                    resp = await client.post(self.BASE_URL, json=body, headers=headers)
                except httpx.RequestError as e:
                    raise LLMError(f"Groq request failed: {e}") from e

                if resp.status_code == 429 and attempt < max_retries:
                    wait_s = float(resp.headers.get("retry-after", 2.0))
                    await asyncio.sleep(min(wait_s, 15.0) + 0.2)
                    continue
                break

        if resp.status_code == 401:
            raise LLMError("Groq: invalid API key (401).")
        if resp.status_code == 429:
            retry_after = resp.headers.get("retry-after")
            raise LLMError(f"Groq: rate limited (429, retry-after={retry_after}s). Body: {resp.text[:500]}")
        if resp.status_code >= 400:
            raise LLMError(f"Groq API error {resp.status_code}: {resp.text[:500]}")

        data = resp.json()
        try:
            return data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError) as e:
            raise LLMError(f"Unexpected Groq response shape: {data}") from e


def get_default_client() -> GroqClient:
    return GroqClient()
