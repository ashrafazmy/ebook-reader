from pathlib import Path
import struct
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, func, select
from sqlalchemy.orm import Session

from app.main import create_app
from app.models import Book, Section, TextBlock
from epub_fixtures import encryption_xml, make_epub


def upload(client, content=None, filename="book.epub"):
    return client.post("/api/books", files={"file": (filename, content if content is not None else make_epub(), "application/epub+zip")})


def assert_empty(client, configuration):
    assert client.get("/api/books").json() == []
    assert list(configuration.books_dir.iterdir()) == []
    with Session(client.app.state.engine) as session:
        for model in (Book, Section, TextBlock):
            assert session.scalar(select(func.count()).select_from(model)) == 0


def test_import_spine_order_api_and_restart(configuration):
    with TestClient(create_app(configuration)) as client:
        assert client.get("/api/books").json() == []
        response = upload(client, filename="../../untrusted.epub")
        assert response.status_code == 201, response.text
        book = response.json()
        assert book["title"] == "The Small Journey"
        assert book["author"] == "Reader Test Author"
        assert [section["title"] for section in book["sections"]] == ["The beginning", "Across the water"]
        assert [section["position"] for section in book["sections"]] == [0, 1]
        assert [section["spine_position"] for section in book["sections"]] == [0, 1]
        assert book["section_count"] == 2
        book_path = f'/api/books/{book["id"]}'
        assert client.get(book_path).json() == book
        listing = client.get("/api/books").json()
        assert len(listing) == 1 and "sections" not in listing[0]
        section_path = f'{book_path}/sections/{book["sections"][0]["id"]}'
        section = client.get(section_path).json()
        assert [block["text"] for block in section["blocks"]] == ["The beginning", "A small boat left the shore.", "The water was quiet."]
        assert [block["position"] for block in section["blocks"]] == [0, 1, 2]
        assert section["blocks"][0]["kind"] == "heading"
        assert section["blocks"][0]["heading_level"] == 1
        assert len({block["id"] for block in section["blocks"]}) == 3
        assert list(configuration.books_dir.iterdir()) == [configuration.books_dir / f'{book["id"]}.epub']
    with TestClient(create_app(configuration)) as restarted:
        assert restarted.get(book_path).json() == book
        assert restarted.get(section_path).json() == section
        assert len(restarted.get("/api/books").json()) == 1


def test_missing_metadata(client):
    response = upload(client, make_epub(metadata=False))
    assert response.status_code == 201, response.text
    assert response.json()["title"] == "Untitled book"
    assert response.json()["author"] == "Unknown author"


@pytest.mark.parametrize("content", [b"", b"not a zip", b"PK\x03\x04truncated", make_epub(missing_spine=True)])
def test_malformed_import_leaves_nothing(client, configuration, content):
    response = upload(client, content)
    assert response.status_code == 400
    assert isinstance(response.json()["detail"], str)
    assert_empty(client, configuration)


def test_wrong_extension(client, configuration):
    assert upload(client, filename="book.txt").status_code == 400
    assert_empty(client, configuration)


@pytest.mark.parametrize("setting,value,content", [
    ("max_upload_bytes", 100, make_epub()),
    ("max_archive_bytes", 1200, make_epub()),
    ("max_archive_entry_bytes", 200, make_epub()),
    ("max_archive_entries", 2, make_epub()),
    ("max_archive_bytes", 10_000, make_epub(extra={"large.txt": b"a" * 100_000})),
])
def test_limits(configuration, setting, value, content):
    setattr(configuration, setting, value)
    with TestClient(create_app(configuration)) as client:
        response = upload(client, content)
        assert response.status_code == 413, response.text
        assert_empty(client, configuration)


def test_streamed_request_limit_without_content_length(configuration):
    configuration.max_upload_bytes = 100
    def body():
        yield b'--test\r\nContent-Disposition: form-data; name="file"; filename="book.epub"\r\n\r\n'
        for _ in range(100):
            yield b"a" * 1024
        yield b"\r\n--test--\r\n"
    with TestClient(create_app(configuration)) as client:
        response = client.post("/api/books", content=body(), headers={"Content-Type": "multipart/form-data; boundary=test"})
        assert response.status_code == 413, response.text
        assert_empty(client, configuration)


@pytest.mark.parametrize("algorithm", ["http://www.idpf.org/2008/embedding", "http://ns.adobe.com/pdf/enc#RC"])
def test_font_obfuscation_allowed(client, algorithm):
    response = upload(client, make_epub(encryption=encryption_xml(algorithm, "OEBPS/font.otf")))
    assert response.status_code == 201, response.text


@pytest.mark.parametrize("algorithm,target", [
    ("http://www.w3.org/2001/04/xmlenc#aes256-cbc", "OEBPS/z-first.xhtml"),
    ("http://www.idpf.org/2008/embedding", "OEBPS/z-first.xhtml"),
])
def test_encrypted_text_rejected(client, configuration, algorithm, target):
    response = upload(client, make_epub(encryption=encryption_xml(algorithm, target)))
    assert response.status_code == 400
    assert "Encrypted" in response.json()["detail"]
    assert_empty(client, configuration)


def test_safe_text_and_boundaries(client):
    body = '<script>alert("evil")</script><h2 onclick="bad()">Heading</h2><div>Before<p>hel<em>lo</em>, world &amp; friends.<br/>Next line.</p>After</div><p>&lt;script&gt;literal&lt;/script&gt;</p><iframe src="https://example.com">hidden</iframe>'
    book = upload(client, make_epub(body=body)).json()
    section = client.get(f'/api/books/{book["id"]}/sections/{book["sections"][0]["id"]}').json()
    assert [block["text"] for block in section["blocks"]] == ["Heading", "Before", "hello, world & friends.\nNext line.", "After", "<script>literal</script>"]
    assert all(set(block) == {"id", "position", "kind", "heading_level", "text"} for block in section["blocks"])


def test_section_belongs_to_book(client):
    first = upload(client).json()
    second = upload(client).json()
    assert client.get(f'/api/books/{second["id"]}/sections/{first["sections"][0]["id"]}').status_code == 404
    assert client.get(f'/api/books/{uuid4()}').status_code == 404


def test_commit_failure_rolls_back_and_removes_file(client, configuration):
    def fail_commit(_session):
        raise RuntimeError("synthetic commit failure")
    event.listen(Session, "before_commit", fail_commit)
    try:
        assert upload(client).status_code == 500
    finally:
        event.remove(Session, "before_commit", fail_commit)
    assert_empty(client, configuration)


def test_file_move_failure_rolls_back(client, configuration, monkeypatch):
    def fail_replace(*_args):
        raise OSError("synthetic disk failure")
    monkeypatch.setattr(Path, "replace", fail_replace)
    assert upload(client).status_code == 500
    assert_empty(client, configuration)


def test_archive_path_traversal_rejected(client, configuration):
    response = upload(client, make_epub(extra={"../outside.txt": b"unsafe"}))
    assert response.status_code == 400
    assert_empty(client, configuration)


def test_encrypted_zip_flag_rejected(client, configuration):
    content = bytearray(make_epub())
    central_header = content.index(b"PK\x01\x02")
    flags = struct.unpack_from("<H", content, central_header + 8)[0]
    struct.pack_into("<H", content, central_header + 8, flags | 1)
    response = upload(client, bytes(content))
    assert response.status_code == 400
    assert "Encrypted ZIP" in response.json()["detail"]
    assert_empty(client, configuration)


def test_declared_request_limit_rejected(configuration):
    configuration.max_upload_bytes = 100
    with TestClient(create_app(configuration)) as client:
        response = client.post("/api/books", content=b"x" * 70_000)
        assert response.status_code == 413
        assert_empty(client, configuration)
