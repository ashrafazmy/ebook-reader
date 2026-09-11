"""Durable single-paragraph requests; Voicebox owns the inference queue."""

import asyncio
from contextlib import suppress
import hashlib
import json
import logging
from uuid import UUID, uuid4

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models import Narration, TextBlock
from app.voicebox import MODEL_SETTINGS, ProviderError, VoiceboxProvider, compatible

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api", tags=["narration"])


def canonical(value: dict) -> str:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


class NarrationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    paragraph_id: UUID
    profile_id: str
    model_name: str
    regenerate: bool = False


def representation(row: Narration, reused: bool = False) -> dict:
    return {
        "id": row.id, "paragraph_id": row.paragraph_id,
        "profile_id": row.profile_id, "profile_name": row.profile_name,
        "model_name": row.model_name, "state": row.state,
        "error": row.error, "error_kind": row.error_kind,
        "provider_job_id": row.provider_job_id, "reused": reused,
        "audio_url": f"/api/audio/{row.audio_id}" if row.audio_id and row.state == "completed" else None,
    }


class NarrationService:
    def __init__(self, engine, settings, provider: VoiceboxProvider):
        self.engine = engine
        self.settings = settings
        self.provider = provider
        self.lock = asyncio.Lock()
        self.task: asyncio.Task | None = None

    def start(self) -> None:
        self.settings.audio_dir.mkdir(parents=True, exist_ok=True)
        with Session(self.engine) as session, session.begin():
            for row in session.scalars(select(Narration).where(Narration.state.in_(["pending", "running"]))):
                if row.submission_started and not row.provider_job_id:
                    row.state = "failed"
                    row.error_kind = "ambiguous"
                    row.error = "Reader stopped during submission. Voicebox may have accepted it. Check Voicebox history before explicitly regenerating."
            referenced_audio = set(session.scalars(select(Narration.audio_id).where(Narration.audio_id.is_not(None))))
        for path in self.settings.audio_dir.iterdir():
            if path.suffix not in {".wav", ".part"} or not path.is_file():
                continue
            try:
                owned = str(UUID(path.stem)) == path.stem
            except ValueError:
                continue
            if owned and (path.suffix == ".part" or path.stem not in referenced_audio):
                path.unlink()
        self.task = asyncio.create_task(self.run())

    async def close(self) -> None:
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task

    async def create(self, data: NarrationRequest) -> dict:
        paragraph_id = str(data.paragraph_id)
        with Session(self.engine) as session:
            paragraph = session.get(TextBlock, paragraph_id)
            if paragraph is None:
                raise HTTPException(404, "Paragraph not found.")
            if paragraph.kind != "paragraph":
                raise HTTPException(400, "Select a paragraph, not a heading.")
            text = paragraph.text
            # Preserve an in-flight or uncertain request even if Voicebox goes offline.
            active = session.scalar(select(Narration).where(
                Narration.paragraph_id == paragraph_id, Narration.profile_id == data.profile_id,
                Narration.model_name == data.model_name, Narration.active_key.is_not(None),
            ).order_by(Narration.created_at.desc()))
            if active and (active.state in {"pending", "running"} or
                           (active.error_kind == "ambiguous" and not data.regenerate)):
                return representation(active, True)

        payload, identity, profile = await self.provider.prepare(data.profile_id, data.model_name, text)
        key = hashlib.sha256(canonical({"paragraph_id": paragraph_id, "request": payload, "identity": identity}).encode()).hexdigest()
        async with self.lock:
            with Session(self.engine) as session, session.begin():
                existing = session.scalar(select(Narration).where(Narration.active_key == key))
                if existing:
                    if existing.state in {"pending", "running"} or not data.regenerate:
                        if existing.state == "completed" and not (self.settings.audio_dir / f"{existing.audio_id}.wav").is_file():
                            existing.state, existing.error_kind = "failed", "audio"
                            existing.error = "Cached audio is missing. Retry audio retrieval from Voicebox."
                        return representation(existing, True)
                    existing.active_key = None
                    session.flush()
                row = Narration(
                    id=str(uuid4()), paragraph_id=paragraph_id, profile_id=profile.id,
                    profile_name=profile.name, model_name=data.model_name,
                    cache_key=key, active_key=key, request_json=canonical(payload),
                    identity_json=canonical(identity), provider_base_url=self.provider.base_url,
                    state="pending",
                )
                session.add(row)
                session.flush()
                return representation(row)

    def get(self, job_id: str) -> dict:
        with Session(self.engine) as session:
            row = session.get(Narration, job_id)
            if row is None:
                raise HTTPException(404, "Narration not found.")
            return representation(row)

    def retry(self, job_id: str, *, audio_only: bool = True) -> dict:
        with Session(self.engine) as session, session.begin():
            row = session.get(Narration, job_id)
            if row is None:
                raise HTTPException(404, "Narration not found.")
            if row.state in {"pending", "running"}:
                return representation(row, True)
            if not row.provider_job_id or (audio_only and row.error_kind != "audio"):
                raise HTTPException(409, "Only failed audio retrieval can be retried here. For failed generation, use explicit Regenerate.")
            row.state, row.error, row.error_kind = "running", None, None
            return representation(row)

    def update(self, job_id: str, **values) -> None:
        with Session(self.engine) as session, session.begin():
            row = session.get(Narration, job_id)
            for name, value in values.items():
                setattr(row, name, value)

    async def process(self, job_id: str) -> None:
        with Session(self.engine) as session:
            row = session.get(Narration, job_id)
            payload = json.loads(row.request_json)
            identity = json.loads(row.identity_json)
            provider_id = row.provider_job_id
            base_url = row.provider_base_url
            model_name = row.model_name
            audio_id = row.audio_id or str(uuid4())
            started = row.submission_started
        try:
            if base_url != self.provider.base_url:
                raise ProviderError("Voicebox address changed. Restore the original address to reconcile this job; regeneration is a separate explicit action.", "configuration")
            if not provider_id:
                if started:
                    raise ProviderError("A previous submission may have reached Voicebox. Check its history before explicitly regenerating.", ambiguous=True)
                # Recheck immediately before enqueue: never request absent model downloads.
                _, current_identity, _ = await self.provider.prepare(payload["profile_id"], model_name, payload["text"])
                if current_identity != identity:
                    raise ProviderError("Voicebox profile or model identity changed before submission. Regenerate using the refreshed profile.", "configuration")
                self.update(job_id, submission_started=True)
                generation = await self.provider.submit(payload)
                provider_id = generation.id
                # Save the provider ID before any further HTTP operation.
                self.update(job_id, provider_job_id=provider_id, state="running")
            else:
                generation = await self.provider.status(provider_id)
            if (generation.id != provider_id or generation.profile_id != payload["profile_id"]
                    or generation.text != payload["text"] or generation.language != payload["language"]
                    or generation.engine != payload["engine"] or generation.model_size != payload["model_size"]):
                raise ProviderError("Voicebox returned a generation for different text or voice settings; audio was not attached.", "contract")
            if generation.status == "failed":
                raise ProviderError("Voicebox generation failed: " + (generation.error or "No provider detail available."), "generation")
            if generation.status in {"generating", "loading_model"}:
                self.update(job_id, state="running", error=None, error_kind=None)
            elif generation.status == "completed":
                await self.provider.download(provider_id, self.settings.audio_dir / f"{audio_id}.wav")
                self.update(job_id, state="completed", audio_id=audio_id, error=None, error_kind=None)
            else:
                raise ProviderError(f"Unknown Voicebox generation state: {generation.status}.", "contract")
        except ProviderError as exc:
            # A known provider ID can be polled again without submitting another job.
            if provider_id and exc.kind == "unavailable":
                self.update(job_id, error=str(exc), error_kind=exc.kind)
            else:
                self.update(job_id, state="failed", error=str(exc), error_kind=exc.kind)

    async def run(self) -> None:
        while True:
            try:
                with Session(self.engine) as session:
                    ids = list(session.scalars(select(Narration.id).where(Narration.state.in_(["pending", "running"]))))
                # Only network orchestration here; Voicebox serializes model inference.
                semaphore = asyncio.Semaphore(4)
                async def advance(job_id: str):
                    async with semaphore:
                        try:
                            await self.process(job_id)
                        except Exception:
                            logger.exception("Could not reconcile narration %s", job_id)
                            # Do not leave a possibly submitted request eligible for replay.
                            with Session(self.engine) as session:
                                row = session.get(Narration, job_id)
                                kind = "ambiguous" if row.submission_started and not row.provider_job_id else "storage"
                            self.update(job_id, state="failed", error_kind=kind,
                                        error="Narration processing was interrupted. Check Voicebox history before regenerating.")
                await asyncio.gather(*(advance(job_id) for job_id in ids))
            except Exception:
                logger.exception("Narration reconciliation failed")
            await asyncio.sleep(self.settings.voicebox_poll_seconds)


@router.get("/voicebox/status")
async def voicebox_status(request: Request):
    try:
        info = await request.app.state.voicebox.discovery()
        return {"connected": True, "version": info["version"], "text_limit": info["text_limit"], "provider_text_limit": info["provider_text_limit"], "error": None}
    except ProviderError as exc:
        return {"connected": False, "error": str(exc)}


@router.get("/voicebox/profiles")
async def voicebox_profiles(request: Request):
    try:
        info = await request.app.state.voicebox.discovery()
        return {"text_limit": info["text_limit"], "profiles": [
            {"id": profile.id, "name": profile.name, "language": profile.language,
             "models": [{"id": model.model_name, "name": model.display_name,
                         "downloaded": model.downloaded and not model.downloading}
                        for model in info["models"] if compatible(profile, MODEL_SETTINGS[model.model_name][0])]}
            for profile in info["profiles"]
        ]}
    except ProviderError as exc:
        raise HTTPException(503, str(exc)) from exc


@router.post("/narrations", status_code=202)
async def create_narration(data: NarrationRequest, request: Request):
    try:
        return await request.app.state.narration.create(data)
    except ProviderError as exc:
        raise HTTPException(503 if exc.kind in {"unavailable", "contract"} else 400, str(exc)) from exc


@router.get("/narrations")
def paragraph_narrations(paragraph_id: UUID, request: Request):
    with Session(request.app.state.engine) as session:
        return [representation(row, True) for row in session.scalars(select(Narration).where(
            Narration.paragraph_id == str(paragraph_id),
        ).order_by(Narration.created_at.desc()).limit(100))]


@router.get("/narrations/{job_id}")
def narration_status(job_id: UUID, request: Request):
    return request.app.state.narration.get(str(job_id))


@router.post("/narrations/{job_id}/retry-audio")
def retry_audio(job_id: UUID, request: Request):
    return request.app.state.narration.retry(str(job_id))


@router.post("/narrations/{job_id}/reconcile")
def reconcile(job_id: UUID, request: Request):
    """Recheck an existing provider ID; never submits another generation."""
    return request.app.state.narration.retry(str(job_id), audio_only=False)


@router.get("/audio/{audio_id}")
def audio(audio_id: UUID, request: Request):
    with Session(request.app.state.engine) as session:
        row = session.scalar(select(Narration).where(Narration.audio_id == str(audio_id), Narration.state == "completed"))
        if row is None:
            raise HTTPException(404, "Audio not found.")
    path = request.app.state.settings.audio_dir / f"{audio_id}.wav"
    if not path.is_file():
        raise HTTPException(404, "Cached audio is missing. Use Generate, then retry audio retrieval.")
    return FileResponse(path, media_type="audio/wav", content_disposition_type="inline")
