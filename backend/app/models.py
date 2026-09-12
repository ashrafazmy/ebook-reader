"""Persistent import records; ordering is explicit rather than inferred from IDs."""

from datetime import datetime, timezone

from sqlalchemy import ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class Book(Base):
    __tablename__ = "books"

    id: Mapped[str] = mapped_column(primary_key=True)
    title: Mapped[str]
    author: Mapped[str]
    created_at: Mapped[str] = mapped_column(
        default=lambda: datetime.now(timezone.utc).isoformat()
    )
    section_count: Mapped[int]
    sections: Mapped[list["Section"]] = relationship(
        cascade="all, delete-orphan", order_by="Section.position"
    )


class Section(Base):
    __tablename__ = "sections"
    __table_args__ = (UniqueConstraint("book_id", "position"),)

    id: Mapped[str] = mapped_column(primary_key=True)
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id"), index=True)
    position: Mapped[int]
    spine_position: Mapped[int]
    source_href: Mapped[str]
    title: Mapped[str]
    blocks: Mapped[list["TextBlock"]] = relationship(
        cascade="all, delete-orphan", order_by="TextBlock.position"
    )


class TextBlock(Base):
    __tablename__ = "text_blocks"
    __table_args__ = (UniqueConstraint("section_id", "position"),)

    id: Mapped[str] = mapped_column(primary_key=True)
    section_id: Mapped[str] = mapped_column(ForeignKey("sections.id"), index=True)
    position: Mapped[int]
    kind: Mapped[str]
    heading_level: Mapped[int | None]
    text: Mapped[str] = mapped_column(Text)


class Narration(Base):
    __tablename__ = "narrations"

    id: Mapped[str] = mapped_column(primary_key=True)
    paragraph_id: Mapped[str] = mapped_column(ForeignKey("text_blocks.id"), index=True)
    profile_id: Mapped[str]
    profile_name: Mapped[str]
    model_name: Mapped[str]
    cache_key: Mapped[str] = mapped_column(index=True)
    # One reusable or unresolved attempt per exact cache key. Regeneration releases it.
    active_key: Mapped[str | None] = mapped_column(unique=True)
    request_json: Mapped[str] = mapped_column(Text)
    identity_json: Mapped[str] = mapped_column(Text)
    provider_base_url: Mapped[str]
    provider_job_id: Mapped[str | None]
    submission_started: Mapped[bool] = mapped_column(default=False)
    state: Mapped[str] = mapped_column(default="pending")
    error: Mapped[str | None]
    error_kind: Mapped[str | None]
    audio_id: Mapped[str | None] = mapped_column(unique=True)
    created_at: Mapped[str] = mapped_column(default=lambda: datetime.now(timezone.utc).isoformat())


class ChapterJob(Base):
    __tablename__ = "chapter_jobs"
    id: Mapped[str] = mapped_column(primary_key=True)
    section_id: Mapped[str] = mapped_column(ForeignKey("sections.id"), index=True)
    profile_id: Mapped[str]
    profile_name: Mapped[str]
    model_name: Mapped[str]
    request_json: Mapped[str] = mapped_column(Text)
    identity_json: Mapped[str] = mapped_column(Text)
    active_key: Mapped[str | None] = mapped_column(unique=True)
    state: Mapped[str] = mapped_column(default="queued")
    error: Mapped[str | None]
    replacement: Mapped[bool] = mapped_column(default=False)
    audio_id: Mapped[str] = mapped_column(unique=True)
    duration: Mapped[float | None]
    created_at: Mapped[str] = mapped_column(default=lambda: datetime.now(timezone.utc).isoformat())
    chunks: Mapped[list["ChapterChunk"]] = relationship(cascade="all, delete-orphan", order_by="ChapterChunk.position")


class ChapterChunk(Base):
    __tablename__ = "chapter_chunks"
    __table_args__ = (UniqueConstraint("job_id", "position"),)
    id: Mapped[str] = mapped_column(primary_key=True)
    job_id: Mapped[str] = mapped_column(ForeignKey("chapter_jobs.id"), index=True)
    source_id: Mapped[str]
    block_id: Mapped[str] = mapped_column(ForeignKey("text_blocks.id"))
    position: Mapped[int]
    start_offset: Mapped[int]
    end_offset: Mapped[int]
    text: Mapped[str] = mapped_column(Text)
    narration_id: Mapped[str | None] = mapped_column(ForeignKey("narrations.id"))
    state: Mapped[str] = mapped_column(default="queued")
    error: Mapped[str | None]
    start_seconds: Mapped[float | None]
    end_seconds: Mapped[float | None]


class ListeningProgress(Base):
    __tablename__ = "listening_progress"
    book_id: Mapped[str] = mapped_column(ForeignKey("books.id"), primary_key=True)
    version_id: Mapped[str] = mapped_column(ForeignKey("chapter_jobs.id"))
    offset: Mapped[float]
    speed: Mapped[float]
    updated_at_ms: Mapped[int]
