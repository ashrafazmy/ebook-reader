"""Book APIs and transactional import; blocking work runs in FastAPI's thread pool."""

import logging
from pathlib import Path
from uuid import UUID, uuid4, uuid5

from fastapi import APIRouter, File, HTTPException, Request, UploadFile
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.epub_parser import EpubLimitExceeded, InvalidEpub, parse_epub
from app.models import Book, Section, TextBlock
from app.schemas import BookDetail, BookSummary, SectionDetail

router = APIRouter(prefix="/api/books", tags=["books"])
logger = logging.getLogger(__name__)


@router.post("", response_model=BookDetail, status_code=201)
def upload_book(request: Request, file: UploadFile = File(...)) -> BookDetail:
    settings = request.app.state.settings
    if not file.filename or Path(file.filename).suffix.lower() != ".epub":
        raise HTTPException(400, "Choose a file with an .epub extension.")
    book_id = uuid4()
    temporary = settings.books_dir / f"{book_id}.upload"
    destination = settings.books_dir / f"{book_id}.epub"
    saved = False
    try:
        size = 0
        with temporary.open("xb") as output:
            while chunk := file.file.read(64 * 1024):
                size += len(chunk)
                if size > settings.max_upload_bytes:
                    raise EpubLimitExceeded(f"EPUB exceeds the upload limit of {settings.max_upload_bytes} bytes.")
                output.write(chunk)
        title, author, parsed = parse_epub(temporary, settings)
        book = Book(id=str(book_id), title=title, author=author, section_count=len(parsed))
        for position, source in enumerate(parsed):
            section_id = uuid5(book_id, f"spine:{source.spine_position}")
            section = Section(
                id=str(section_id), position=position, spine_position=source.spine_position,
                source_href=source.source_href, title=source.title,
            )
            section.blocks = [TextBlock(
                id=str(uuid5(section_id, f"block:{index}")), position=index,
                kind=block.kind, heading_level=block.heading_level, text=block.text,
            ) for index, block in enumerate(source.blocks)]
            book.sections.append(section)
        with Session(request.app.state.engine) as session, session.begin():
            session.add(book)
            session.flush()
            result = BookDetail.model_validate(book)
            temporary.replace(destination)
        saved = True
        return result
    except EpubLimitExceeded as exc:
        raise HTTPException(413, str(exc)) from exc
    except InvalidEpub as exc:
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        logger.exception("Book import failed")
        raise HTTPException(500, "Could not save the book. Check available disk space and try again.") from exc
    finally:
        temporary.unlink(missing_ok=True)
        if not saved:
            destination.unlink(missing_ok=True)


@router.get("", response_model=list[BookSummary])
def list_books(request: Request) -> list[BookSummary]:
    with Session(request.app.state.engine) as session:
        books = session.scalars(select(Book).order_by(Book.created_at.desc(), Book.id))
        return [BookSummary.model_validate(book) for book in books]


@router.get("/{book_id}", response_model=BookDetail)
def get_book(book_id: UUID, request: Request) -> BookDetail:
    with Session(request.app.state.engine) as session:
        book = session.get(Book, str(book_id))
        if book is None:
            raise HTTPException(404, "Book not found.")
        return BookDetail.model_validate(book)


@router.get("/{book_id}/sections/{section_id}", response_model=SectionDetail)
def get_section(book_id: UUID, section_id: UUID, request: Request) -> SectionDetail:
    with Session(request.app.state.engine) as session:
        section = session.scalar(select(Section).where(
            Section.id == str(section_id), Section.book_id == str(book_id),
        ))
        if section is None:
            raise HTTPException(404, "Section not found in this book.")
        return SectionDetail.model_validate(section)
