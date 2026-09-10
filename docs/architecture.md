# Architecture and roadmap

## Milestone 1: implemented foundation

The browser runs React and TypeScript served by Vite on loopback port 5173. React fetches the relative URL `/api/health`. Vite forwards `/api` requests to FastAPI on loopback port 8000, keeping browser requests on one origin during development.

FastAPI returns HTTP 200 with `{"status":"ok"}`. This is a liveness check: it does not depend on a database or speech service. The UI shows checking, connected, or unreachable, rejects invalid health responses, and permits manual retries. Each request has a five-second timeout and is cancelled when the component is cleaned up. It does not poll in the background.

`backend/app/` is a Python package: `__init__.py` marks it as such, `main.py` owns HTTP entry points, and `config.py` owns validated settings. `uv sync` installs the package into `backend/.venv` with its dependencies. Uvicorn loads `app.main:app` (the `app` object in `app/main.py`) and serves HTTP. FastAPI's response model defines and documents the JSON contract. pytest uses FastAPI's in-process test client to exercise that contract without starting a server.

Pydantic Settings reads the root `.env` using a path relative to the source file, with environment variables taking precedence. Voicebox's base URL is configured but unused. uv and npm lockfiles record resolved dependencies. EPUB and database libraries are now installed for milestone 2; model libraries remain outside this project.

There is one repository, two application processes, and no authentication, cloud services, containers, queue server, or task platform. This foundation is intended for local loopback use. The frontend build is verified, but deployment is outside this milestone.

## Milestone 2: implemented EPUB reader

React provides a bookshelf with multipart upload, loading/error/empty states, and cards showing title and author. A book ID in the URL hash opens the reader and supports browser history. The reader fetches section text on demand, provides section selection and previous/next controls, and lets the user adjust font size within a readable width. Book data is never stored only in React state: it lives in SQLite and remains after restart. Current reading location and font-size preference are not persisted yet.

### Backend responsibilities

- `books.py` owns HTTP routes and the import transaction. Synchronous routes run blocking parsing, file, and database work in FastAPI's worker thread pool.
- `epub_parser.py` checks the ZIP container before EbookLib reads it, then uses EbookLib metadata/spine and Beautiful Soup text traversal. No archive extraction or network retrieval is performed.
- `models.py` defines SQLAlchemy records; `database.py` creates SQLite tables on startup and enables foreign keys. Each request uses a short-lived session. SQLite's default transactions are enough for this single-user milestone.
- `schemas.py` defines returned fields so list/detail routes cannot accidentally return all chapter text or local file paths.
- `config.py` anchors `DATA_DIR` to the repository root (default `backend/data`) and derives `reader.sqlite3` and `books/`. Absolute data paths are also accepted. Neither depends on the shell directory.

### Data model and reading order

| Record | Stored fields and purpose |
| --- | --- |
| Book | UUID, title, author, UTC creation time, section count; one row per import |
| Section | UUID, book foreign key, zero-based position, original zero-based spine position, source href, title |
| TextBlock | UUID, section foreign key, zero-based position, kind (`heading`/`paragraph`), optional original heading level 1–6, plain text |

Position is unique within each parent. SQLAlchemy relationships order sections and blocks explicitly by position. A generated book UUID namespaces deterministic section UUIDs derived from the original spine position; each section UUID namespaces its block UUIDs derived from block order. These IDs are stored once and survive rereads and restarts. Reimporting a file creates a new book and new IDs.

The importer iterates **`book.spine`**, resolves each `idref`, and never sorts filenames or assumes manifest order. Every text-bearing HTML spine item produces one section, including `linear="no"` items in their listed positions. Empty/image-only items are skipped; the original spine index is still retained. A section may span multiple chapters or only part of one. The first heading, document title, or `Section N` supplies its label. EPUB navigation/NCX entries and fragment links do not yet map to chapter navigation. Unsupported non-HTML spine documents and multiple package renditions are rejected clearly.

Beautiful Soup walks the body in document order, preserving heading levels, paragraph boundaries, and explicit line breaks. It retains prose in simple container/list structures and normalizes layout whitespace, while discarding scripts, styles, and embedded active/non-text content. Inline markup does not insert unwanted spaces into words. React renders only escaped text children with semantic heading/paragraph tags; it never uses raw HTML insertion. Links become plain text, images and custom typography are omitted, and tables are flattened. This is a text view, not reproduction of the EPUB layout, and it does not rewrite wording with an LLM.

### API

| Route | Response |
| --- | --- |
| `POST /api/books` | Multipart `file`; 201 book metadata and section summaries |
| `GET /api/books` | Newest-first book summaries, without sections or text |
| `GET /api/books/{book_id}` | Metadata and ordered section summaries |
| `GET /api/books/{book_id}/sections/{section_id}` | Ordered plain-text blocks; section must belong to that book |

Missing records return 404, invalid EPUBs 400, and configured limits 413 with human-readable `detail` messages. The existing `/api/health` response and Vite `/api` proxy are preserved.

### Import limits and failure handling

The file byte limit defaults to 20 MiB. An ASGI middleware limits the whole multipart request to that value plus 64 KiB, counting actual incoming bytes even without Content-Length. The importer also counts the individual file bytes while copying to a generated `.upload` path.

ZIP validation caps entries (2,000), expanded bytes per entry (10 MiB), and total expanded bytes (100 MiB). It checks both declared sizes and actual streamed expansion/CRCs before EbookLib can load the archive. Duplicate/traversal paths, malformed package XML, unresolved spine references, ZIP encryption, and unsupported content encryption are rejected. `defusedxml` parses container, package, and encryption metadata without XML entity expansion. No archive members are extracted to disk.

`encryption.xml` alone is not treated as text encryption: [EPUB explicitly uses it for font obfuscation](https://www.w3.org/TR/epub-33/). Known IDPF and Adobe obfuscation algorithms are allowed when their targets are declared font resources; other encrypted resources are unsupported. Fonts are not rendered or deobfuscated by this text reader.

Parsing completes before database inserts. A single SQLAlchemy transaction inserts the whole book, sections, and blocks. The upload is renamed to `<book-uuid>.epub` before commit; failures roll back all records and remove both temporary/final generated paths. On startup, UUID-named `.upload` files and EPUBs without committed books are cleaned up to recover interrupted imports. Only one backend worker should use a data directory because startup recovery assumes no concurrent importer. There is no distributed transaction across SQLite and the filesystem; this handles application failures and interrupted processes, not hardware failures or external file deletion. See [SQLAlchemy session transactions](https://docs.sqlalchemy.org/en/20/orm/session_basics.html) for the transaction convention.

The initial schema is created automatically; schema migration tooling is deferred until an actual schema change needs it. Tests generate original synthetic EPUBs in memory and use temporary data directories, including an application restart check. The sample fixture generator can write an EPUB for manual verification. Browser visual checks were not run because browser tooling was unavailable; README lists the manual checks.

## Milestone 3: planned Voicebox integration

Voicebox remains an external local service: https://github.com/jamiepine/voicebox. No source copy, fork, model installation, or model dependency belongs in this backend.

Before writing the adapter, inspect the current documentation, relevant source, and running service's OpenAPI schema if available. Record the verified voice-listing, generation, job-status, audio-retrieval contracts and provider text limits. No endpoint contract has been verified or assumed in milestone 1.

An isolated `VoiceboxProvider` will own HTTP communication using `VOICEBOX_BASE_URL` (default `http://127.0.0.1:17493`). Add speech connection status, voice selection, and generation of a short original passage. Retrieve playable audio for the browser rather than triggering desktop-only playback. Report unavailable service, missing models, timeouts, and generation failures without interrupting reading.

## Milestone 4: planned continuous narration

Split original text at paragraph or sentence boundaries within verified provider limits. Persist stable text-to-chunk mappings. Cache audio in `backend/data/audio/` (under configured `DATA_DIR`) using text, provider/model identity, voice, and generation settings. Track generation jobs and deduplicate submissions; prepare only a small number of upcoming chunks and avoid blocking the API while waiting for generation. Choose the simplest in-process execution approach supported by the verified provider contract; no separate task platform is planned.

Add browser play/pause, previous/next chunk, playback speed, and active-chunk highlighting. Persist chunk ID and audio offset in SQLite to resume listening. Precise word highlighting is out of scope. Text remains readable without Voicebox, and narration never uses LLM rewriting.
