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

## Milestone 3: retained Voicebox narration foundation

The paragraph UI introduced in milestone 3 was removed in 5A.1. The following describes the retained backend contract and machinery used by chapter chunks.

Voicebox remains an external local service: https://github.com/jamiepine/voicebox. No source copy, fork, model installation, or model dependency belongs in this backend.

Source contracts were inspected at **v0.5.0 / `51f49dea198384b4eb6087b72c17057c6eb1c1cd`**. The local service was unavailable, so only mock-based integration has been verified. [Contract notes](voicebox-contract.md) include source links, the stale bundled-schema finding, route/payload details, model mappings, and text limits. Runtime discovery checks the running schema before submitting work.

`VoiceboxProvider` owns an asynchronous httpx client for the configured base URL. React calls only our API. Connection/profile discovery is separate from EPUB requests. Profile/model choices come from `/profiles` and `/models/status`, restricted to known compatible TTS combinations. Model readiness is checked before enqueueing; no download endpoint is invoked. Text is read from `TextBlock` by paragraph ID, never accepted from the browser. Heading IDs are rejected.

### Flow and state

1. `POST /api/narrations` takes `paragraph_id`, `profile_id`, `model_name`, and optional `regenerate`. It validates the stored paragraph and provider capabilities, then returns a persisted request (202) or an existing matching request/cache result.
2. A lifespan-managed asyncio reconciler submits `POST /generate` with exact text and explicit settings. Voicebox's existing serial queue owns inference; this app does not run models or maintain another inference platform. HTTP work uses async I/O; SQLite operations are short transactions, with no transaction held across network calls. Up to four network reconciliations may run concurrently.
3. Local `pending` means awaiting submission/result ID. Voicebox `generating` and `loading_model` map to local `running`. The provider also uses `generating` while queued, so the internal state does not claim an exact provider queue position.
4. The provider ID is committed as soon as submission returns. Subsequent reconciliation polls `GET /history/{id}`. Identity fields (text/profile/language/engine/model size/ID) must match before audio is attached.
5. Provider `completed` triggers `/audio/{id}` retrieval. Bounded async download writes a `.part` file, checks WAV identification, and atomically places a generated local audio ID. Only after successful caching does the local job become `completed`. Provider failure or permanent retrieval/contract errors produce `failed` with an error category.
6. The chapter coordinator observes these narration rows, mirrors chunk state, and assembles completed audio. React polls chapter status and loads only final chapter versions into the shared player. The former paragraph React panel is deleted.

### Persistent data and cache

The additive `narrations` table stores request ID, paragraph foreign key, selected profile/model, provider address, provider ID, submission-started marker, full payload/identity JSON, cache hash, state, error category/message, creation time, and optional unique audio ID. Existing EPUB tables are unchanged; `create_all` creates only the new table on upgrade.

Cache identity includes exact text and settings, Voicebox base URL/version/backend, model name and exposed Hugging Face repository ID, profile ID and exposed profile metadata. Caching is scoped to a stored paragraph ID; identical text in two different paragraphs has separate associations. A unique nullable `active_key` and a short application lock prevent simultaneous matching creates. Pending/running requests are reused even if Regenerate is clicked. Regeneration of a terminal job releases the reusable key and creates a separate record/audio ID, preserving older audio. Sample bytes and model weight hashes are not available from the inspected API; explicit Regenerate handles unreported changes.

`GET /api/narrations?paragraph_id=...` returns recent saved requests; `GET /api/narrations/{id}` reports durable state. `POST /api/narrations/{id}/retry-audio` retries only retrieval, and `/reconcile` rechecks a known provider ID. `/api/audio/{audio_id}` resolves a completed database record to a generated path under `DATA_DIR/audio` and uses Starlette FileResponse for byte-range playback/seek support (tested for 206 and 416). Provider filesystem paths are never trusted. Cached audio remains accessible while Voicebox is offline.

### Failure and restart rules

The submission-started marker is committed **before** the HTTP POST. No automatic retry is made for ambiguous POST timeouts/5xx/invalid responses. After restart, active rows with provider IDs are polled; active rows with a started submission but no returned ID become failed/ambiguous and require checking Voicebox history before explicit regeneration. Pending rows never submitted can proceed normally. No text-based guessing or invented idempotency key is used.

Transient polling failures retain the known job for later reconciliation. Definitive provider failure is saved. Audio errors can retry download against the same provider ID. A changed base URL cannot accidentally reconcile IDs against another service. Startup removes generated partial/unreferenced audio files, so run one backend worker per data directory. As with EPUB storage, filesystem and SQLite are not a distributed transaction; startup cleanup addresses application interruptions, not hardware failure. Completed audio has no automatic eviction yet.

Limits and manual live checks are in README. The paragraph endpoint still submits one selected paragraph; chapter chunking and playback persistence are implemented separately below. The provider itself can internally split long text. Designed/import-only voice profiles remain unsupported. No LLM rewrite or alternate speech provider is used.

## Milestone 4: implemented chapter audiobooks

`chapters.py` coordinates persistent chapter plans; `chapter_audio.py` owns deterministic source spans and WAV assembly. `ChapterAudio.tsx` provides chapter generation and saved-version selection; `Playback.tsx` now owns shared listening controls (milestone 5A). The shared narration service and its durable cache remain intact; individual paragraph controls were removed in 5A.1.

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

Restoration selects the saved section/version and sets offset/speed without autoplay. After user-started playback ends, continuation chooses the next ready section in spine order with the same profile/model. If unavailable, an explanation is shown; no generation is automatically requested. Browser playback policies may still require a Play click. Chapter/version selection guards prevent stale results from attaching to another selection.

### Verification and boundaries

Tests cover splitting/order/cache reuse/duplicates, cancellation and partial retry, ambiguous submissions, snapshot changes, WAV format verification and atomic replacement, backend restart, and versioned progress. A live Voicebox 0.5.0/Kokoro test on 2026-09-12 produced a verified two-chunk, 4.525-second chapter. A restarted isolated backend served identical audio and range responses and restored progress with all Voicebox HTTP access blocked. No browser tooling was available; audible playback, continuation, and physically closing Voicebox remain explicit manual checks in README.

Saved audio needs our backend (and Vite during development), but no Voicebox connection. This milestone does not add PWA/phone downloads, cloud deployment, cache eviction, audiobook export UI, text scroll bookmarks, or word-level highlighting.


## Milestone 5A: responsive UI and opt-in LAN access

`App.tsx` wraps all page navigation in `PlaybackProvider`. A single native audio element belongs to this provider rather than to a reader or generation panel. Source selection is explicit; returning to the bookshelf, changing reading sections, and collapsing native `details` elements do not replace the element/source. Only chapter audio versions can be loaded (5A.1); there is no paragraph playback path. No backend schema, queue, generation contract, or audio cache changes were needed.

`ChapterAudio` continues polling existing persistent jobs even when its disclosure is closed, and reports state/count in the summary. It restores saved reading section/version once per book without replacing existing active audio. Explicit Load actions fetch the latest backend progress. `Playback` owns periodic and lifecycle saves, exact audio-version selection, and adjacent audio lookup in spine order, preferring the same voice/model. Asynchronous next/load results are guarded against newer selections. It never automatically generates missing audio. Native controls reflect actual paused/playing/buffering state; rejected programmatic continuation has a visible message. Native dialogs are unnecessary: chapter selection uses a native select, and panels use details/summary with normal keyboard focus.

Resume stores only a last-listened book ID in optional browser local storage. SQLite remains authoritative for offset, version and speed. A page refresh on the bookshelf can restore that book’s saved audio, while a direct reader URL restores its own book. Restoration is passive; no sound starts. Progress writes use monotonically increasing timestamps as before, and skip untouched metadata seeks. Saves run every five seconds during playback, on pause/seek/rate changes, and best-effort on pagehide/visibilitychange. Multiple tabs/devices remain independent players and share the latest backend position; 5A adds no cross-device playback lock.

CSS reserves the fixed bottom player’s measured height with ResizeObserver and safe-area insets. The dock can scroll in short landscape windows. Controls use minimum 44px targets where controlled by our CSS, 16px form text, visible focus, wrapping labels, and single-column narrow-screen forms. Browser-native media control dimensions remain browser-owned. Generation disclosure state and reader font size are session UI state, not new persisted records.

Network path: phone → Vite LAN port 5173 → `/api` proxy → FastAPI loopback port 8000 → Voicebox loopback port 17493 (only when generating). Relative media URLs also pass through Vite, including Range headers. The `dev:lan` command overrides only Vite’s bind address; the default dev/preview binding and Vite host/CORS restrictions remain intact. LAN access is opt-in on a trusted network; any reachable device can access this unauthenticated app through the proxy. It is not a deployment or secure-origin PWA environment.

Verification: eight jsdom/media-mock tests cover shared player lifecycle and persistence/continuation, alongside the existing 58 backend tests and frontend build. The LAN frontend HTML and proxied health response were checked from the Mac via its LAN address on temporary port 5174. No real-browser layout, mobile emulation, actual phone playback, backgrounding, or lock-screen checks were available; README supplies the device checklist. Prior live Voicebox evidence remains milestone 4 evidence. No new narration was necessary for this UI milestone.


## Milestone 5A.1: chapter-only narration interface

`Reader.tsx` now renders source paragraphs directly as semantic `p` elements, retaining `id=block-<id>` and `data-block-id` for each persisted block. No source strings, IDs, ordering, chunk spans, or EPUB parsing change. Native selection/copying remains available. The removed selected-paragraph highlight served individual narration only; there was no chapter-playback text highlight to preserve.

`NarrationPanel.tsx`, its request/polling code, selected-paragraph state, disclosure, narration buttons, and paragraph-only CSS are removed. `ChapterAudio.tsx` keeps voice/model selection, Generate/replacement, progress, queued status, cancellation, retry, and saved-version selection. The shared player requires chapter metadata, keeps a single media element mounted across app navigation, and retains seeking, speed, previous/next, ordered continuation, and backend progress restoration. It does not replace audio merely because the reader changes sections.

Backend dependencies inspected: `ChapterService` takes the lifespan-managed `NarrationService`, uses its provider and lock, and creates/reuses `Narration` rows by the existing cache key. `ChapterChunk.narration_id` links each chunk to provider IDs, errors, and cached audio; assembly reads those files. Retry and startup recovery depend on the same rows. Therefore the shared service, models, cache format, and all audio remain intact. No migration, deletion, or queue change is needed.

Legacy paragraph HTTP routes are not called by chapter scheduling or the new frontend. They remain intentionally for compatibility and inspecting/recovering old jobs; regression tests also use them to seed cache entries and verify cross-version reuse. Their router includes `/voicebox/profiles`, required by chapter controls. Keeping the router preserves those active routes and avoids expanding a UI simplification into API retirement. Existing pending legacy requests still reconcile normally. Final chapter files are served independently of Voicebox by the existing chapter-audio endpoint.

Verification for 5A.1: 58 existing backend tests and 12 frontend jsdom tests plus the production build. New app-level tests verify absent paragraph controls, unchanged/selectable text and IDs, chapter generation/cancel/retry wiring, and cached chapter restoration/navigation with mocked offline Voicebox. Setting window widths to 360/1280 verifies the same DOM path, not CSS layout. Browser tooling was unavailable; visual desktop/mobile checks, audible playback, and live provider calls were not run for this change. README lists the manual checks. Prior milestone live evidence is unchanged.


## Milestone 5B: explicit device offline application

No backend model or queue changes are required. Vite’s `pwa/build.ts` production plugin hashes the emitted JS/CSS/index plus manifest/icons and worker template, and emits a versioned `/sw.js`. Install caches the complete shell or fails; navigations use that cached index. API requests are never intercepted/cached. No worker registers in development. Updates do not call skipWaiting; activation happens once old windows close, and then removes only older reader-shell caches. IndexedDB downloads/progress are unaffected. The manifest starts the installed app at `/#downloads`.

`device-db.ts` opens a version-1 browser database with `downloads`, `audio`, and `progress` stores. This is device data, not a SQLite migration. Downloads hold the exact book metadata/ordered section summaries, one section’s plain text blocks, chapter job/version/profile/model, size, state and operation token. WAV Blobs are keyed by that version in `audio`. Metadata lists do not read whole audio files. Only explicit downloads fetch chapter text/audio. Their Ready metadata and audio publish in one transaction after length/WAV checks; interrupted or quota-failed work cannot publish partial Ready assets. Tokens prevent an older in-flight transfer from undoing removal/retry. The page’s transfer map suppresses duplicate clicks; retry in another tab supersedes the old token, without allowing it to publish stale data.

Incomplete downloading rows are shown as interrupted after reopening and support explicit retry from the beginning. Expected Content-Length drives size/quota preflight when present; actual size is saved at completion. Removal deletes the device Blob and leaves a small removed-state metadata record; it never calls a server delete endpoint. Completed assets are checked on opening. Missing/evicted audio marks a download failed. Full origin eviction cannot be recovered offline; reconnection is required. Persistent-storage requests are user initiated and may be denied.

`OfflineLibrary.tsx` reads device records without requiring any backend response and renders escaped headings/paragraphs with original IDs. It provides local chapter/version navigation, font sizing, and links to the single shared player. `Playback` prefers a downloaded version, creates a Blob URL for native local seeking, and revokes URLs when switching sources. Its last-listened book hint still fits in localStorage; no audio or chapter text is stored there. Offline cold restoration reads device progress and its exact downloaded version. Server playback remains available for undownloaded versions while connected. The downloaded player's Previous/Next and automatic continuation check the immediately adjacent section in the saved book order. They prefer the same voice/model, then another available version of that section; they never skip an undownloaded section. Successful player selection opens that version's local text route. The downloaded selector can explicitly jump across gaps.

`progress.ts` persists each edit before starting HTTP synchronization. The existing backend GET/PUT contract (version, offset, speed, updated_at_ms) remains unchanged. Same-version conflicts use latest edit time, with server winning ties; intentional rewinds are valid. A baseline timestamp records the previously synchronized position so an intentional next-chapter change can sync against an unchanged server. Independently changed versions are held as an explicit device/server choice. Every acknowledgement compares the pending edit’s timestamp before applying, preventing a stale response from clearing a later local edit. A missing server audio version leaves device progress pending and playable. Synchronization does not seek or replace the current player.

`DeviceStatus` retries pending positions on online/foreground events, every 30 seconds while visible, and manually. Browser background-sync support is not required. Wall-clock skew between devices remains a limitation of the existing timestamp contract; no furthest-position heuristic is used. Native media event saves retain the existing periodic/pause/seek/rate semantics and best-effort page exit handling. Forced termination can still lose the final unfinished asynchronous transaction.

Vite preview now proxies `/api` to loopback FastAPI. `preview:https` reads ignored `.certs/reader.pem` and `.certs/reader-key.pem` and binds the frontend to LAN port 4173. Default preview is loopback HTTP for secure-origin desktop testing. HTTPS trust on the phone is manual; no public exposure, cloud hosting, router forwarding, broad CORS/host permissions, or Voicebox network exposure is added. See `pwa-testing.md` for exact setup, current browser limitations and device checklist.

Tests use fake IndexedDB to cover atomic downloads, truncation, quota/transaction failure, removal, eviction, interrupted retries, rewinds and progress conflicts/races. Chromium tests run the production shell with a synthetic silent WAV and mocked API responses; they exercise offline navigation and seeking, browser restart, deletion/retry and update waiting. These are simulated offline Mac browser tests, not actual phone HTTPS/install/storage/lock-screen checks. The existing 58 backend tests remain unchanged; no live Voicebox generation was needed for this milestone.


Final verification (2026-09-13): 27 frontend unit/DOM tests, 4 Chromium end-to-end tests, 58 backend tests and the production build passed. Chromium checks include fresh-process offline startup and update activation after closing the previous window without losing downloads. Offline-page overflow checks passed at 320/390/430/1280 CSS pixels, with 320/1280 screenshots inspected. This is desktop browser emulation using mocked APIs and silent PCM audio; actual phone and trusted HTTPS installation remain unverified.

### Download progress and chapter selection follow-up

Audio downloads consume the existing assembled WAV response through a Fetch stream. Transferred byte counts are persisted and announced to mounted download displays at most about every 150 ms, with a final count before verification. A usable Content-Length supplies the total and percentage; absent/encoded responses use an indeterminate bar and actual received bytes. Verification and saving have separate phases. WAV length/header checks precede the single IndexedDB transaction publishing text, book/section/version metadata and the Blob as Available offline. A failed transfer retains its last count and never publishes partial audio. Global download activity remains mounted across routes. Closing the application interrupts downloads; explicit retry starts a new transfer.

The navigation fault was that the player's adjacent action replaced its source without changing the reader route. It also required matching voice/model, while device text links skipped gaps. Player navigation now opens a local download route without fetching book details, and online source navigation supplies a section route parameter. Both player and downloaded-text Previous/Next target the immediate adjacent section; an unavailable chapter produces an explanation. The selector lists all downloaded versions in section order, including their known duration, voice and version identity.

A silent detached media element checks replacement metadata before the single visible player changes source; it never calls play. Failed preparation leaves current audio intact. Successful explicit selection preserves playing/paused intent; rejected play promises show a manual Play instruction. Chapter/book labels derive solely from the active audio snapshot and the expandable title reveals full text. The local selector validates the stored Blob, marks evicted entries failed and never silently falls back to a backend download.

IndexedDB version 2 adds a positions store without removing or rewriting existing downloads, audio or progress. Each listening save atomically writes both the latest book position (the existing synchronization contract) and an exact book/audio-version position. Selecting a previously heard version restores that local history. Server progress can supersede history only for that same version with a newer timestamp. Older device downloads remain compatible; versions without history start at zero. SQLite schemas, generated audio and TTS services are unchanged.

## Milestone 5B.1: book generation and device download plans

`POST /api/books/{book_id}/chapters` accepts only `profile_id` and `model_name`. It obtains the provider text limit and prepares one settings/identity snapshot using actual stored text, then invokes the existing chapter-create path in section order. Each job persists with the existing exact-span/settings/identity hash, lock and unique active key. Snapshot calls bypass the single-chapter profile/model-only shortcut so changed identities are not incorrectly treated as matching cache entries. Each chapter commits independently; results include its job or eligibility/submission error. Retrying a lost/partial response reuses matching keys. Failed/cancelled jobs require existing explicit retry. There is no batch replacement or generation cancellation.

The scheduler, one outstanding chapter chunk limit, cache, assembly and provider recovery are unchanged. Settings preserve wording and existing language/engine/model/defaults. Exposed profile changes before inference still fail rather than changing remaining work silently. Unavailable Voicebox prevents a fresh snapshot, but persisted jobs, text and audio remain accessible.

`ChapterAudio` reuses its voice/model selector and polling. Whole book audio counts the latest job per section for that voice/model and opens existing chapter controls for retry/cancel. Submission errors are returned individually; after refresh, committed jobs remain and Generate all can retry missing submissions safely.

`downloadBatch.ts` snapshots one newest ready version per section. IndexedDB version 3 adds `download_batches`, keyed by book ID, containing metadata, fixed versions, completion IDs, sizes and per-version errors; it holds no audio. The page-owned runner validates copies individually, requests remaining sizes with `HEAD /api/chapter-audio/{audio_id}`, checks estimated quota, then awaits the existing downloader one file at a time. HEAD reuses the validated FileResponse without an audio body. No aggregate audiobook Blob or new encoding is created.

Each version retains atomic text/metadata/WAV publication. Per-file errors are recorded; offline/storage failures stop the attempt. Cancellation is checked between operations and leaves completed audio intact. Continue validates actual copies instead of trusting completion IDs. A new explicit action after completion, cancellation or partial failure snapshots current ready versions; Continue retains the original snapshot. Older device versions are never deleted automatically.

`BatchDownloads` remains mounted across routes and reads persisted state after reopening. Continue is explicit; there is no background service-worker download or lock-screen guarantee. Web Locks serialize batches across supporting secure-origin tabs; the fallback guard only covers one page. Single-chapter downloads remain independent. Existing transferred-byte progress is reused. Size estimates omit unknown audio sizes and metadata overhead, so actual quota failures remain authoritative.

No SQLite schema or dependencies change. The additive device store supports restartable plans without rewriting any existing stores. The player, original-title dropdown, controls and per-version progress are preserved.
