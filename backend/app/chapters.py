"""Persistent chapter plans backed by the existing narration queue and cache."""

import asyncio
from contextlib import suppress
import hashlib
import json
import logging
from uuid import UUID, uuid4, uuid5

import anyio
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select
from sqlalchemy.orm import Session
from sqlalchemy.dialects.sqlite import insert

from app.chapter_audio import assemble_wav, split_block
from app.models import Book, ChapterChunk, ChapterJob, ListeningProgress, Narration, Section
from app.narration import canonical
from app.voicebox import ProviderError

router = APIRouter(prefix="/api", tags=["chapter audio"])
logger = logging.getLogger(__name__)


class ChapterRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    section_id: UUID
    profile_id: str
    model_name: str
    replace: bool = False


class RetryRequest(BaseModel):
    confirm_unknown: bool = False


class ProgressRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    version_id: UUID
    offset: float = Field(ge=0, allow_inf_nan=False)
    speed: float = Field(default=1, ge=.5, le=3, allow_inf_nan=False)
    updated_at_ms: int = Field(ge=0)


def job_view(job: ChapterJob) -> dict:
    return {"id": job.id, "section_id": job.section_id, "profile_id": job.profile_id,
            "profile_name": job.profile_name, "model_name": job.model_name, "state": job.state,
            "error": job.error, "completed": sum(c.state == "completed" for c in job.chunks),
            "total": len(job.chunks), "audio_url": f"/api/chapter-audio/{job.audio_id}" if job.state == "ready" else None,
            "duration": job.duration, "created_at": job.created_at}


class ChapterService:
    def __init__(self, engine, settings, narration):
        self.engine, self.settings, self.narration = engine, settings, narration
        self.task = None

    def start(self):
        self.settings.chapters_dir.mkdir(parents=True, exist_ok=True)
        with Session(self.engine) as session, session.begin():
            for job in session.scalars(select(ChapterJob).where(ChapterJob.state == "assembling")):
                job.state = "queued"  # Assembly has no provider side effect and can safely resume.
            ready = set(session.scalars(select(ChapterJob.audio_id).where(ChapterJob.state == "ready")))
        for path in self.settings.chapters_dir.iterdir():
            try:
                owned = str(UUID(path.stem)) == path.stem
            except ValueError:
                continue
            if owned and path.is_file() and (path.suffix == ".part" or (path.suffix == ".wav" and path.stem not in ready)):
                path.unlink()
        self.task = asyncio.create_task(self.run())

    async def close(self):
        if self.task:
            self.task.cancel()
            with suppress(asyncio.CancelledError):
                await self.task

    async def create(self, data: ChapterRequest) -> dict:
        with Session(self.engine) as session:
            section = session.get(Section, str(data.section_id))
            if section is None:
                raise HTTPException(404, "Section not found.")
            blocks = [(block.id, block.text) for block in section.blocks]
            active = session.scalar(select(ChapterJob).where(
                ChapterJob.section_id == str(data.section_id), ChapterJob.profile_id == data.profile_id,
                ChapterJob.model_name == data.model_name, ChapterJob.state.in_(["queued", "generating", "assembling"])))
            if active:
                return job_view(active)
        info = await self.narration.provider.discovery()
        limit = min(self.settings.chapter_chunk_chars, info["text_limit"])
        try:
            chunks = [span for block_id, text in blocks for span in split_block(block_id, text, limit)]
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        if not chunks:
            raise HTTPException(400, "This section has no readable text.")
        payload, identity, profile = await self.narration.provider.prepare(data.profile_id, data.model_name, chunks[0]["text"])
        payload.pop("text")
        key = hashlib.sha256(canonical({"section": str(data.section_id), "chunks": chunks,
                                       "settings": payload, "identity": identity}).encode()).hexdigest()
        async with self.narration.lock:
            with Session(self.engine) as session, session.begin():
                previous = session.scalar(select(ChapterJob).where(ChapterJob.active_key == key))
                if previous:
                    if previous.state in {"queued", "generating", "assembling"} or not data.replace:
                        return job_view(previous)
                    previous.active_key = None
                    session.flush()
                job = ChapterJob(id=str(uuid4()), section_id=str(data.section_id), profile_id=profile.id,
                                 profile_name=profile.name, model_name=data.model_name, request_json=canonical(payload),
                                 identity_json=canonical(identity), active_key=key, state="queued",
                                 audio_id=str(uuid4()), replacement=data.replace)
                job.chunks = [ChapterChunk(id=str(uuid5(UUID(job.id), span["source_id"])), position=i,
                                           state="queued", **span) for i, span in enumerate(chunks)]
                session.add(job)
                session.flush()
                return job_view(job)

    def action(self, job_id: str, cancel: bool, confirm_unknown: bool = False):
        with Session(self.engine) as session, session.begin():
            job = session.get(ChapterJob, job_id)
            if not job:
                raise HTTPException(404, "Chapter job not found.")
            if job.state == "ready":
                return job_view(job)
            if cancel:
                job.state = "cancelled"
                job.error = "Remaining work cancelled. Already submitted Voicebox work may finish and is retained."
                for chunk in job.chunks:
                    if not chunk.narration_id:
                        chunk.state = "cancelled"
            else:
                if job.state in {"generating", "assembling", "queued"}:
                    return job_view(job)
                for chunk in job.chunks:
                    row = session.get(Narration, chunk.narration_id) if chunk.narration_id else None
                    if row and row.state == "failed":
                        if row.error_kind == "ambiguous" and not confirm_unknown:
                            raise HTTPException(409, "A chunk's submission outcome is unknown. Check Voicebox history, then explicitly confirm retrying unknown submissions.")
                        if row.provider_job_id and row.error_kind not in {"generation", "not_found"}:
                            row.state, row.error, row.error_kind = "running", None, None
                        else:
                            row.active_key = None
                            chunk.narration_id = None
                    if not row or row.state != "completed":
                        chunk.state, chunk.error = "queued", None
                job.state, job.error = "queued", None
            session.flush()
            return job_view(job)

    async def tick(self):
        assembly = []
        async with self.narration.lock:
            with Session(self.engine) as session, session.begin():
                jobs = list(session.scalars(select(ChapterJob).where(ChapterJob.state != "ready").order_by(ChapterJob.created_at)))
                # One outstanding chapter narration across all jobs. Paragraph jobs still work independently.
                busy = bool(session.scalar(select(Narration.id).join(ChapterChunk, ChapterChunk.narration_id == Narration.id)
                                           .where(Narration.state.in_(["pending", "running"])).limit(1)))
                for job in jobs:
                    for chunk in job.chunks:
                        row = session.get(Narration, chunk.narration_id) if chunk.narration_id else None
                        if row:
                            chunk.state = "completed" if row.state == "completed" else "failed" if row.state == "failed" else "generating"
                            chunk.error = row.error
                    if job.state in {"cancelled", "failed"}:
                        continue
                    if any(c.state == "failed" for c in job.chunks):
                        detail = next((c.error for c in job.chunks if c.state == "failed" and c.error), "No provider detail available.")
                        job.state, job.error = "failed", f"Chunk failed: {detail} Retry retains completed audio."
                        continue
                    job.error = next((c.error for c in job.chunks if c.error), None)
                    if all(c.state == "completed" for c in job.chunks):
                        job.state = "assembling"
                        paths = [self.settings.audio_dir / f"{session.get(Narration, c.narration_id).audio_id}.wav" for c in job.chunks]
                        assembly.append((job.id, job.audio_id, paths))
                        continue
                    if busy:
                        continue
                    chunk = next((c for c in job.chunks if not c.narration_id), None)
                    if chunk is None:
                        continue
                    payload = {**json.loads(job.request_json), "text": chunk.text}
                    identity = json.loads(job.identity_json)
                    key = hashlib.sha256(canonical({"paragraph_id": chunk.block_id, "request": payload, "identity": identity}).encode()).hexdigest()
                    row = session.scalar(select(Narration).where(Narration.active_key == key))
                    if row and row.state == "completed" and not (self.settings.audio_dir / f"{row.audio_id}.wav").exists():
                        row.state, row.error_kind, row.error = "failed", "audio", "Cached chunk audio is missing. Retry retrieval."
                    if row and job.replacement and row.state not in {"pending", "running"}:
                        row.active_key = None
                        session.flush()
                        row = None
                    if row is None:
                        row = Narration(id=str(uuid4()), paragraph_id=chunk.block_id, profile_id=job.profile_id,
                                        profile_name=job.profile_name, model_name=job.model_name, cache_key=key, active_key=key,
                                        request_json=canonical(payload), identity_json=job.identity_json,
                                        provider_base_url=identity["base_url"], state="pending")
                        session.add(row)
                        session.flush()
                    chunk.narration_id, chunk.state = row.id, "generating"
                    job.state = "generating"
                    busy = row.state in {"pending", "running"}
        for job_id, audio_id, paths in assembly:
            destination = self.settings.chapters_dir / f"{audio_id}.wav"
            try:
                duration, spans = await anyio.to_thread.run_sync(assemble_wav, paths, destination, self.settings.max_chapter_audio_bytes)
                with Session(self.engine) as session, session.begin():
                    job = session.get(ChapterJob, job_id)
                    if job.state == "cancelled":
                        destination.unlink(missing_ok=True)
                        continue
                    job.state, job.duration, job.error = "ready", duration, None
                    for chunk, (start, end) in zip(job.chunks, spans, strict=True):
                        chunk.start_seconds, chunk.end_seconds = start, end
            except Exception as exc:
                logger.exception("Chapter assembly failed")
                with Session(self.engine) as session, session.begin():
                    job = session.get(ChapterJob, job_id)
                    if job.state != "cancelled":
                        job.state, job.error = "failed", f"Assembly failed: {exc}. Completed chunks retained; retry assembly after fixing the cause."

    async def run(self):
        while True:
            try:
                await self.tick()
            except Exception:
                logger.exception("Chapter reconciliation failed")
            await asyncio.sleep(self.settings.voicebox_poll_seconds)


@router.post("/chapters", status_code=202)
async def create_chapter(data: ChapterRequest, request: Request):
    try:
        return await request.app.state.chapters.create(data)
    except ProviderError as exc:
        raise HTTPException(503, str(exc)) from exc


@router.get("/chapters")
def list_chapters(book_id: UUID, request: Request):
    with Session(request.app.state.engine) as session:
        return [job_view(job) for job in session.scalars(select(ChapterJob).join(Section)
                .where(Section.book_id == str(book_id)).order_by(ChapterJob.created_at.desc()))]


@router.get("/chapters/{job_id}")
def chapter_detail(job_id: UUID, request: Request):
    with Session(request.app.state.engine) as session:
        job = session.get(ChapterJob, str(job_id))
        if not job:
            raise HTTPException(404, "Chapter job not found.")
        result = job_view(job)
        result["chunks"] = []
        for chunk in job.chunks:
            row = session.get(Narration, chunk.narration_id) if chunk.narration_id else None
            result["chunks"].append({"id": chunk.source_id, "block_id": chunk.block_id, "position": chunk.position,
                                     "start_offset": chunk.start_offset, "end_offset": chunk.end_offset,
                                     "state": chunk.state, "error": chunk.error,
                                     "provider_job_id": row.provider_job_id if row else None,
                                     "error_kind": row.error_kind if row else None,
                                     "start_seconds": chunk.start_seconds, "end_seconds": chunk.end_seconds})
        return result


@router.post("/chapters/{job_id}/cancel")
async def cancel_chapter(job_id: UUID, request: Request):
    return request.app.state.chapters.action(str(job_id), True)


@router.post("/chapters/{job_id}/retry")
async def retry_chapter(job_id: UUID, data: RetryRequest, request: Request):
    return request.app.state.chapters.action(str(job_id), False, data.confirm_unknown)


@router.get("/chapter-audio/{audio_id}")
def chapter_audio(audio_id: UUID, request: Request):
    with Session(request.app.state.engine) as session:
        job = session.scalar(select(ChapterJob).where(ChapterJob.audio_id == str(audio_id), ChapterJob.state == "ready"))
        if not job:
            raise HTTPException(404, "Ready chapter audio not found.")
    path = request.app.state.settings.chapters_dir / f"{audio_id}.wav"
    if not path.is_file():
        raise HTTPException(404, "Saved chapter file is missing.")
    return FileResponse(path, media_type="audio/wav", content_disposition_type="inline")


def progress_view(row, session):
    if row is None:
        return None
    job = session.get(ChapterJob, row.version_id)
    return {"version_id": row.version_id, "section_id": job.section_id, "offset": row.offset,
            "speed": row.speed, "updated_at_ms": row.updated_at_ms}


@router.get("/books/{book_id}/listening-progress")
def get_progress(book_id: UUID, request: Request):
    with Session(request.app.state.engine) as session:
        return progress_view(session.get(ListeningProgress, str(book_id)), session)


@router.put("/books/{book_id}/listening-progress")
def save_progress(book_id: UUID, data: ProgressRequest, request: Request):
    with Session(request.app.state.engine) as session, session.begin():
        job = session.get(ChapterJob, str(data.version_id))
        if not job or job.state != "ready" or session.get(Section, job.section_id).book_id != str(book_id):
            raise HTTPException(400, "Audio version does not belong to a ready chapter in this book.")
        values = {"book_id": str(book_id), "version_id": str(data.version_id),
                  "offset": min(data.offset, job.duration or 0), "speed": data.speed, "updated_at_ms": data.updated_at_ms}
        statement = insert(ListeningProgress).values(**values)
        session.execute(statement.on_conflict_do_update(index_elements=[ListeningProgress.book_id],
            set_=values, where=ListeningProgress.updated_at_ms < data.updated_at_ms))
        return progress_view(session.get(ListeningProgress, str(book_id)), session)
