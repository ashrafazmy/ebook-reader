# Architecture and roadmap

## Milestone 1: implemented foundation

The browser runs React and TypeScript served by Vite on loopback port 5173. React fetches the relative URL `/api/health`. Vite forwards `/api` requests to FastAPI on loopback port 8000, keeping browser requests on one origin during development.

FastAPI returns HTTP 200 with `{"status":"ok"}`. This is a liveness check: it does not depend on a database or speech service. The UI shows checking, connected, or unreachable, rejects invalid health responses, and permits manual retries. Each request has a five-second timeout and is cancelled when the component is cleaned up. It does not poll in the background.

`backend/app/` is a Python package: `__init__.py` marks it as such, `main.py` owns HTTP entry points, and `config.py` owns validated settings. `uv sync` installs the package into `backend/.venv` with its dependencies. Uvicorn loads `app.main:app` (the `app` object in `app/main.py`) and serves HTTP. FastAPI's response model defines and documents the JSON contract. pytest uses FastAPI's in-process test client to exercise that contract without starting a server.

Pydantic Settings reads the root `.env` using a path relative to the source file, with environment variables taking precedence. Voicebox's base URL is used by the milestone 3 adapter. uv and npm lockfiles record resolved dependencies. EPUB and database libraries are installed; model libraries remain outside this project.

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

## Milestone 3: implemented single-paragraph Voicebox integration

Voicebox remains an external local service: https://github.com/jamiepine/voicebox. No source copy, fork, model installation, or model dependency belongs in this backend.

Source contracts were inspected at **v0.5.0 / `51f49dea198384b4eb6087b72c17057c6eb1c1cd`**. The local service was unavailable, so only mock-based integration has been verified. [Contract notes](voicebox-contract.md) include source links, the stale bundled-schema finding, route/payload details, model mappings, and text limits. Runtime discovery checks the running schema before submitting work.

`VoiceboxProvider` owns an asynchronous httpx client for the configured base URL. React calls only our API. Connection/profile discovery is separate from EPUB requests. Profile/model choices come from `/profiles` and `/models/status`, restricted to known compatible TTS combinations. Model readiness is checked before enqueueing; no download endpoint is invoked. Text is read from `TextBlock` by paragraph ID, never accepted from the browser. Heading IDs are rejected.

### Flow and state

1. `POST /api/narrations` takes `paragraph_id`, `profile_id`, `model_name`, and optional `regenerate`. It validates the stored paragraph and provider capabilities, then returns a persisted request (202) or an existing matching request/cache result.
2. A lifespan-managed asyncio reconciler submits `POST /generate` with exact text and explicit settings. Voicebox's existing serial queue owns inference; this app does not run models or maintain another inference platform. HTTP work uses async I/O; SQLite operations are short transactions, with no transaction held across network calls. Up to four network reconciliations may run concurrently.
3. Local `pending` means awaiting submission/result ID. Voicebox `generating` and `loading_model` map to local `running`. The provider also uses `generating` while queued, so the UI says queued or generating and does not claim exact queue position.
4. The provider ID is committed as soon as submission returns. Subsequent reconciliation polls `GET /history/{id}`. Identity fields (text/profile/language/engine/model size/ID) must match before audio is attached.
5. Provider `completed` triggers `/audio/{id}` retrieval. Bounded async download writes a `.part` file, checks WAV identification, and atomically places a generated local audio ID. Only after successful caching does the local job become `completed`. Provider failure or permanent retrieval/contract errors produce `failed` with an error category.
6. React polls the local job status, guarded by paragraph/profile/model selection. The audio element uses native controls without autoplay; a user must start playback. Changing selections leaves the provider job intact and prevents its result being attached to a different paragraph.

### Persistent data and cache

The additive `narrations` table stores request ID, paragraph foreign key, selected profile/model, provider address, provider ID, submission-started marker, full payload/identity JSON, cache hash, state, error category/message, creation time, and optional unique audio ID. Existing EPUB tables are unchanged; `create_all` creates only the new table on upgrade.

Cache identity includes exact text and settings, Voicebox base URL/version/backend, model name and exposed Hugging Face repository ID, profile ID and exposed profile metadata. Caching is scoped to a stored paragraph ID; identical text in two different paragraphs has separate associations. A unique nullable `active_key` and a short application lock prevent simultaneous matching creates. Pending/running requests are reused even if Regenerate is clicked. Regeneration of a terminal job releases the reusable key and creates a separate record/audio ID, preserving older audio. Sample bytes and model weight hashes are not available from the inspected API; explicit Regenerate handles unreported changes.

`GET /api/narrations?paragraph_id=...` returns recent saved requests; `GET /api/narrations/{id}` reports durable state. `POST /api/narrations/{id}/retry-audio` retries only retrieval, and `/reconcile` rechecks a known provider ID. `/api/audio/{audio_id}` resolves a completed database record to a generated path under `DATA_DIR/audio` and uses Starlette FileResponse for byte-range playback/seek support (tested for 206 and 416). Provider filesystem paths are never trusted. Cached audio remains accessible while Voicebox is offline.

### Failure and restart rules

The submission-started marker is committed **before** the HTTP POST. No automatic retry is made for ambiguous POST timeouts/5xx/invalid responses. After restart, active rows with provider IDs are polled; active rows with a started submission but no returned ID become failed/ambiguous and require checking Voicebox history before explicit regeneration. Pending rows never submitted can proceed normally. No text-based guessing or invented idempotency key is used.

Transient polling failures retain the known job for later reconciliation. Definitive provider failure is saved. Audio errors can retry download against the same provider ID. A changed base URL cannot accidentally reconcile IDs against another service. Startup removes generated partial/unreferenced audio files, so run one backend worker per data directory. As with EPUB storage, filesystem and SQLite are not a distributed transaction; startup cleanup addresses application interruptions, not hardware failure. Completed audio has no automatic eviction yet.

Limits and manual live checks are in README. Only one selected paragraph is submitted; no reader-side chunking, automatic next paragraph, playback-offset persistence, LLM rewrite, or alternate speech provider is present. The provider itself can internally split long text. Designed/import-only voice profiles are not supported by this milestone's selector.

## Milestone 4: planned continuous narration

Split original text at paragraph or sentence boundaries within verified provider limits. Persist stable text-to-chunk mappings. Cache audio in `backend/data/audio/` (under configured `DATA_DIR`) using text, provider/model identity, voice, and generation settings. Track generation jobs and deduplicate submissions; prepare only a small number of upcoming chunks and avoid blocking the API while waiting for generation. Choose the simplest in-process execution approach supported by the verified provider contract; no separate task platform is planned.

Add browser play/pause, previous/next chunk, playback speed, and active-chunk highlighting. Persist chunk ID and audio offset in SQLite to resume listening. Precise word highlighting is out of scope. Text remains readable without Voicebox, and narration never uses LLM rewriting.
