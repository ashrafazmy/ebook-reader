# Architecture and roadmap

## Milestone 1: implemented foundation

The browser runs React and TypeScript served by Vite on loopback port 5173. React fetches the relative URL `/api/health`. Vite forwards `/api` requests to FastAPI on loopback port 8000, keeping browser requests on one origin during development.

FastAPI returns HTTP 200 with `{"status":"ok"}`. This is a liveness check: it does not depend on a database or speech service. The UI shows checking, connected, or unreachable, rejects invalid health responses, and permits manual retries. Each request has a five-second timeout and is cancelled when the component is cleaned up. It does not poll in the background.

`backend/app/` is a Python package: `__init__.py` marks it as such, `main.py` owns HTTP entry points, and `config.py` owns validated settings. `uv sync` installs the package into `backend/.venv` with its dependencies. Uvicorn loads `app.main:app` (the `app` object in `app/main.py`) and serves HTTP. FastAPI's response model defines and documents the JSON contract. pytest uses FastAPI's in-process test client to exercise that contract without starting a server.

Pydantic Settings reads the root `.env` using a path relative to the source file, with environment variables taking precedence. Voicebox's base URL is used by the milestone 3 adapter. uv and npm lockfiles record resolved dependencies. EPUB and database libraries are installed; model libraries remain outside this project.

There is one repository, two application processes, and no authentication, cloud services, containers, queue server, or task platform. This foundation is intended for local loopback use. The frontend build is verified, but deployment is outside this milestone.

## Milestone 2: implemented EPUB reader

React provides a bookshelf with multipart upload, loading/error/empty states, and cards showing title and author. A book ID in the URL hash opens the reader and supports browser history. The reader fetches section text on demand, provides section selection and previous/next controls, and lets the user adjust font size within a readable width. Book data lives in SQLite and remains after restart. Milestone 4 persists the last listening chapter/version/offset; text scroll and font-size preferences are not persisted.

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

Limits and manual live checks are in README. The paragraph endpoint still submits one selected paragraph; chapter chunking and playback persistence are implemented separately below. The provider itself can internally split long text. Designed/import-only voice profiles remain unsupported. No LLM rewrite or alternate speech provider is used.

## Milestone 4: implemented chapter audiobooks

`chapters.py` coordinates persistent chapter plans; `chapter_audio.py` owns deterministic source spans and WAV assembly. `ChapterAudio.tsx` provides chapter generation, saved versions, and listening controls. Existing paragraph generation and its durable cache remain intact.

### Mapping and data model

A chapter initially means an existing section: one text-bearing HTML spine item, in existing spine order. Headings and paragraphs are both narrated in block order. An EPUB item may contain multiple chapters or a partial chapter; navigation/NCX hierarchy is not reinterpreted.

| Table | Purpose |
| --- | --- |
| `chapter_jobs` | Section, profile/model/settings/identity snapshot, unique reusable key, state/error, replacement flag, audio UUID, duration, creation time |
| `chapter_chunks` | Job/order, deterministic source UUID, block FK, exact start/end character offsets and text, narration FK, mirrored state/error, assembled start/end audio seconds |
| `listening_progress` | One latest position per book: exact chapter job/version FK, seconds offset, speed, timestamp |

Provider IDs and submission-started markers remain on the referenced `narrations` rows, avoiding a second submission implementation. The new tables are additive; existing tables and files are not rebuilt.

The splitter never reorders blocks or rewrites strings. Each span is a slice of stored text with offsets measured in Python Unicode code points. UUIDs derive from the stable block ID, splitter version, and offsets. The effective limit is the minimum of `CHAPTER_CHUNK_CHARS` (800), paragraph cap, and verified running schema limit. Sentence-ending punctuation and trailing whitespace stay with their source slices. Overlong sentences use whitespace boundaries; an overlong unbroken word is rejected. No characters are dropped or added within a block.

### Scheduling, reuse, and recovery

Create validates Voicebox readiness and snapshots payload/identity once. All chunk requests use that snapshot, including language, engine/model size, normalization, disabled personality/effects, and fixed provider chunk settings. The existing adapter rechecks identity before each new POST; a changed exposed profile/model fails remaining work rather than mixing configurations.

An application-lifespan coordinator mirrors narration states and schedules **one outstanding chapter chunk globally**, across chapter jobs. Voicebox still owns the inference queue; there is no Redis/Celery platform. HTTP calls remain asynchronous, DB transactions are short, and assembly runs in a worker thread. Browser navigation does not own or cancel backend work.

Whole-block chunks reuse compatible milestone 3 audio through the exact existing hash (block ID, text, payload, provider/model/profile identity). Split spans receive their own matching hashes. The same lock used by paragraph creation plus unique database keys prevent duplicate cache/job submissions. Normal repeated chapter creation reuses a matching job; explicit replacement creates a new version while retaining the old one. In-flight identical work is shared even during replacement.

States are `queued`, `generating`, `assembling`, `ready`, `failed`, and `cancelled`. Progress counts actual completed chunks. Cancellation stops further scheduling; one already scheduled/shared recording may finish and be retained. Retry keeps completed audio and resumes remaining work. Known provider IDs are reconciled/downloaded without resubmission when appropriate; definite inference failures may create fresh requests only through explicit retry. Ambiguous submissions require a separate explicit acknowledgement after checking provider history. Restart uses the existing submission-started safeguards. Assembly can be retried offline from completed chunks.

### Audio publication

Python 3.11's standard [`wave` module](https://docs.python.org/3.11/library/wave.html) reads/writes PCM frames. Inputs must have matching channel count, sample width, and sample rate. Mono/stereo PCM is supported; encoded/non-PCM/EXTENSIBLE WAV, format mismatches, truncation, and configured size overflow fail clearly. No FFmpeg dependency, silent resampling, or encoded-byte concatenation is used.

Frames are streamed in chunk order to a `.part` file, with per-chunk audio ranges recorded. The output frame count is verified and the file fsynced before atomic rename under `DATA_DIR/chapters`. Only then is the job marked ready. Cancellation is rechecked before ready publication. A failed replacement does not change old ready records/files. Startup removes generated partial/unpublished files and safely restarts interrupted assembly. Chunk WAVs stay under `DATA_DIR/audio`, protected by their existing narration records. A one-worker data directory is required.

### API and player

| Route | Purpose |
| --- | --- |
| `POST /api/chapters` | Section/profile/model and optional explicit `replace`; create/reuse a job |
| `GET /api/chapters?book_id=...` | Saved versions and progress summaries across the book |
| `GET /api/chapters/{id}` | Ordered chunk mappings, states/errors, provider IDs and audio ranges |
| `POST /api/chapters/{id}/cancel` | Stop remaining scheduling |
| `POST /api/chapters/{id}/retry` | Resume/retry; optional `confirm_unknown` explicitly permits ambiguous resubmission |
| `GET /api/chapter-audio/{audio_id}` | Serve a ready generated file with HTTP byte ranges |
| `GET/PUT /api/books/{id}/listening-progress` | Restore/save exact version, offset, speed and timestamp |

The player chooses a saved version independently of generation controls, keeping previous audio available through replacements. Position saves occur every five seconds while playing, on pause/seek/speed change, and best-effort at navigation/page exit. SQLite UPSERT accepts only newer timestamps, protecting against out-of-order requests; audio version ownership and duration bounds are validated. The latest save wins across tabs.

Restoration selects the saved section/version and sets offset/speed without autoplay. After user-started playback ends, continuation chooses the next ready section in spine order with the same profile/model. If unavailable, an explanation is shown; no generation is automatically requested. Browser playback policies may still require a Play click. Chapter/paragraph selection guards prevent stale results from attaching to another selection.

### Verification and boundaries

Tests cover splitting/order/cache reuse/duplicates, cancellation and partial retry, ambiguous submissions, snapshot changes, WAV format verification and atomic replacement, backend restart, and versioned progress. A live Voicebox 0.5.0/Kokoro test on 2026-09-12 produced a verified two-chunk, 4.525-second chapter. A restarted isolated backend served identical audio and range responses and restored progress with all Voicebox HTTP access blocked. No browser tooling was available; audible playback, continuation, and physically closing Voicebox remain explicit manual checks in README.

Saved audio needs our backend (and Vite during development), but no Voicebox connection. This milestone does not add PWA/phone downloads, cloud deployment, cache eviction, audiobook export UI, text scroll bookmarks, or word-level highlighting.
