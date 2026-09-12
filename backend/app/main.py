"""HTTP entry point. Start with: uv run uvicorn app.main:app --reload."""

from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel
import httpx

from app.config import Settings, settings
from app.books import router
from app.database import create_database
from app.upload_limit import UploadLimitMiddleware
from app.voicebox import VoiceboxProvider
from app.narration import NarrationService, router as narration_router
from app.chapters import ChapterService, router as chapters_router


def create_app(configuration: Settings = settings, *, voicebox_transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        engine = create_database(configuration)
        application.state.engine = engine
        client = httpx.AsyncClient(timeout=configuration.voicebox_timeout_seconds, follow_redirects=False, transport=voicebox_transport)
        application.state.voicebox = VoiceboxProvider(configuration, client)
        application.state.narration = NarrationService(engine, configuration, application.state.voicebox)
        application.state.narration.start()
        application.state.chapters = ChapterService(engine, configuration, application.state.narration)
        application.state.chapters.start()
        try:
            yield
        finally:
            await application.state.chapters.close()
            await application.state.narration.close()
            await client.aclose()
            engine.dispose()

    application = FastAPI(title="EPUB Reader API", version="0.2.0", lifespan=lifespan)
    application.state.settings = configuration
    application.add_middleware(UploadLimitMiddleware, max_upload_bytes=configuration.max_upload_bytes)
    application.include_router(router)
    application.include_router(narration_router)
    application.include_router(chapters_router)
    application.add_api_route("/api/health", health, response_model=HealthResponse)
    return application


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


def health() -> HealthResponse:
    """Report API liveness independently of optional speech services."""
    return HealthResponse()


app = create_app()
