"""HTTP entry point. Start with: uv run uvicorn app.main:app --reload."""

from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from app.config import settings

app = FastAPI(title="EPUB Reader API", version="0.1.0")
app.state.settings = settings


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


@app.get("/api/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Report API liveness independently of optional speech services."""
    return HealthResponse()
