"""HTTP entry point. Start with: uv run uvicorn app.main:app --reload."""

from contextlib import asynccontextmanager
from typing import Literal

from fastapi import FastAPI
from pydantic import BaseModel

from app.config import Settings, settings
from app.books import router
from app.database import create_database
from app.upload_limit import UploadLimitMiddleware


def create_app(configuration: Settings = settings) -> FastAPI:
    @asynccontextmanager
    async def lifespan(application: FastAPI):
        engine = create_database(configuration)
        application.state.engine = engine
        try:
            yield
        finally:
            engine.dispose()

    application = FastAPI(title="EPUB Reader API", version="0.2.0", lifespan=lifespan)
    application.state.settings = configuration
    application.add_middleware(UploadLimitMiddleware, max_upload_bytes=configuration.max_upload_bytes)
    application.include_router(router)
    application.add_api_route("/api/health", health, response_model=HealthResponse)
    return application


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"


def health() -> HealthResponse:
    """Report API liveness independently of optional speech services."""
    return HealthResponse()


app = create_app()
