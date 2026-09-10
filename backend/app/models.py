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
