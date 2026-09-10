from uuid import uuid4

from fastapi.testclient import TestClient

from app.main import create_app
from epub_fixtures import make_epub


def test_startup_removes_interrupted_imports_only(configuration):
    with TestClient(create_app(configuration)) as client:
        book = client.post("/api/books", files={"file": ("book.epub", make_epub())}).json()
    committed = configuration.books_dir / f'{book["id"]}.epub'
    interrupted = configuration.books_dir / f"{uuid4()}.upload"
    uncommitted = configuration.books_dir / f"{uuid4()}.epub"
    unrelated = configuration.books_dir / "personal.epub"
    for path in (interrupted, uncommitted, unrelated):
        path.write_bytes(b"placeholder")
    with TestClient(create_app(configuration)) as client:
        assert len(client.get("/api/books").json()) == 1
        assert committed.exists()
        assert unrelated.exists()
        assert not interrupted.exists()
        assert not uncommitted.exists()
