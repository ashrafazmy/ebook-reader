# Local EPUB Reader

A single-user web application being built for reading unencrypted EPUBs and listening to AI narration locally.

**Implemented: milestones 1–3.** FastAPI health endpoint, React connection indicator, Vite API proxy, EPUB upload, persistent bookshelf, a text reader, and single-paragraph narration through an external Voicebox service. Production code uses real HTTP calls; mocks are used only in tests.

Voicebox integration is **verified with contract mocks, not a live service or browser playback yet**. Books, extracted text, narration jobs, and cached audio persist across restarts. Continuous narration and saved reading/playback position are not implemented. Reading remains available without Voicebox.

## Prerequisites

- [uv](https://docs.astral.sh/uv/getting-started/installation/) for Python dependencies and Python 3.11 installation.
- Node.js 22.12+ (Node 22 LTS recommended) and npm. The installed Node 22.14.0 works with this setup; see [Vite requirements](https://vite.dev/guide/).
- Git. This workspace already has a repository; no remote or push was created.

## Setup

Run from the repository root:

```sh
cp .env.example .env
uv python install 3.11
cd backend
uv sync --locked
cd ../frontend
npm ci
cd ..
```

If `.env` already exists, keep it and copy only any missing settings from `.env.example`.

Upgrading from milestone 1: run `uv sync --locked` in `backend/`. This installs EbookLib, Beautiful Soup, SQLAlchemy, the multipart upload parser, and safe XML parsing dependencies. No new frontend dependencies are required. The database tables and storage folder are created automatically when FastAPI starts; no manual database command is needed.

Upgrading from milestone 2: run the same `uv sync --locked` command to install httpx as a runtime dependency. The additive `narrations` table is created automatically; existing EPUB tables and books are preserved. No speech-model dependencies are installed in this application.

## Run

Terminal 1, from the repository root:

```sh
cd backend
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2, from the repository root:

```sh
cd frontend
npm run dev
```

Open **http://127.0.0.1:5173**. You should see **Your bookshelf**, an **Upload EPUB** button, and **Backend connected**. The browser requests `/api` routes; Vite forwards them to FastAPI on port 8000. No CORS configuration is needed for this same-origin development flow.

The status checks on page load and when you press **Check again**, with a five-second timeout. To see the offline state, stop the backend and press **Check again**. Restart it and check again to recover. The status is API liveness, not Voicebox readiness.

FastAPI's interactive API documentation is at http://127.0.0.1:8000/docs. Stop either development server with Ctrl+C. The ports are fixed; if one is occupied, stop the conflicting service or update the corresponding command and proxy configuration together.

## Verify

With both servers running, from the repository root:

```sh
curl --fail http://127.0.0.1:8000/api/health
curl --fail http://127.0.0.1:5173/api/health
cd backend
uv run pytest
cd ../frontend
npm run build
```

Both curl requests should return `{"status":"ok"}`. Tests use small original synthetic EPUBs and isolated temporary databases. They cover metadata fallbacks, spine order, ordered section/block retrieval, restart persistence, unsafe text extraction, malformed files, upload and archive limits, encryption versus font obfuscation, and failed-import cleanup. The frontend build type-checks TypeScript and writes static assets to ignored `frontend/dist/`. This milestone uses Vite's development server for the complete local application; serving the static build with an API reverse proxy is not configured as a deployment.

### Try your own EPUB

1. Click **Upload EPUB** and choose an unencrypted `.epub` file. The default upload limit is 20 MiB. Wait for the importing message to finish.
2. A book card should show its title and author. Missing metadata appears as **Untitled book** or **Unknown author**.
3. Open the card. Use the section selector and **Previous/Next** controls to navigate. Adjust **Font size** to change the reading text from 16–32px.
4. Use **Back to bookshelf** to return. Stop and restart FastAPI, reload the browser, and confirm the book remains available.

To create a copyright-free sample, run from the repository root:

```sh
cd backend
uv run python tests/epub_fixtures.py data/samples/synthetic.epub
```

Upload `backend/data/samples/synthetic.epub`. Its manifest and alphabetical filenames put the second section first, but the reader must show **The beginning** before **Across the water**, following the spine.

For direct API verification, from the repository root with both servers running:

```sh
curl --fail-with-body -F 'file=@backend/data/samples/synthetic.epub' http://127.0.0.1:5173/api/books
curl --fail http://127.0.0.1:5173/api/books
```

Copy the returned book ID and section ID into these routes (replace the uppercase placeholders):

```sh
curl --fail http://127.0.0.1:5173/api/books/BOOK_ID
curl --fail http://127.0.0.1:5173/api/books/BOOK_ID/sections/SECTION_ID
```

Listing returns summaries only; book detail returns ordered section summaries; section detail returns ordered text blocks. Import failures return a readable `detail` message (400 for invalid/unsupported EPUBs, 413 for limits). Importing the same book again creates a separate copy.

### Manual browser checks

Browser automation was unavailable during implementation; visual checks were **not run**. Use the steps above, then verify:

- Before the first import, the empty state appears. During import, the upload button is disabled and an importing message appears.
- The sample shows a heading followed by two separate paragraphs in its first section. Previous is disabled at the first section; Next is disabled at the last.
- The section dropdown, both navigation control rows, font slider, bookshelf link, and browser Back button work. Resize the browser to a narrow mobile width and check for horizontal overflow.
- Try a text file renamed with `.epub`: an error should appear and no new card should be added.
- Stop FastAPI and reload the bookshelf: an error and retry action should appear. Restart it and retry.

## Reading limitations

One text-bearing HTML spine item becomes one section; it may contain several chapters or only part of a chapter. Non-linear spine items are included in their listed positions; empty/image-only items are skipped. Section titles use the first heading, then the document title, then a numbered fallback. The EPUB table of contents and internal fragment links do not drive navigation yet.

This is a text reader: headings and paragraph boundaries are preserved, but inline styling, layout, images, tables as grids, custom fonts, original pagination, and exact typography are not reproduced. Whitespace is normalized and explicit line breaks retained. Script/style/embedded content is discarded; remaining text is rendered as escaped React text, including literal HTML-looking text. No EPUB HTML is inserted into the page. Multiple renditions and non-HTML spine documents are unsupported. Bookmarks and saved reading location are not included; reopening starts at the first section.

## Configuration and structure

Root `.env` loads independently of the shell's working directory. Exported environment variables override `.env`. `VOICEBOX_BASE_URL` defaults to `http://127.0.0.1:17493` and points to the separately running speech service. Voicebox discovery happens in the reader; only unfinished narration jobs are reconciled in the background.

- `backend/app/main.py`: FastAPI application and typed health response.
- `backend/app/config.py`: validated environment settings.
- `backend/app/books.py`: import transaction and book routes.
- `backend/app/epub_parser.py`: bounded archive validation and spine-ordered text extraction.
- `backend/app/models.py`, `database.py`, `schemas.py`: persistent records, SQLite setup, and API response contracts.
- `backend/app/upload_limit.py`: request-body limit before multipart parsing completes.
- `backend/app/voicebox.py`: asynchronous Voicebox contract adapter and bounded audio retrieval.
- `backend/app/narration.py`: persisted requests, deduplication, reconciliation, and audio routes.
- `docs/voicebox-contract.md`: inspected upstream revision, contracts, compatibility checks, and verification limits.
- `backend/tests/`: focused pytest behavior tests.
- `frontend/src/`: React UI and connection state.
- `frontend/vite.config.ts`: development server and `/api` proxy.
- `docs/architecture.md`: component explanation and roadmap.
- `AGENTS.md`: stack, commands, and conventions for future work.

The default database is `backend/data/reader.sqlite3`; uploads are stored at `backend/data/books/<generated-book-uuid>.epub`. Original filenames are not used as storage paths. Both are ignored by Git. Keep the whole data directory to preserve your library. No migration system is needed for the initial schema; future schema changes will need an explicit migration.

Optional root `.env` settings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `DATA_DIR` | `backend/data` | Relative to the repository root, or an absolute path; independent of terminal directory |
| `MAX_UPLOAD_BYTES` | `20971520` | Maximum EPUB file bytes (20 MiB) |
| `MAX_ARCHIVE_BYTES` | `104857600` | Total expanded archive bytes (100 MiB) |
| `MAX_ARCHIVE_ENTRY_BYTES` | `10485760` | Expanded bytes per entry (10 MiB) |
| `MAX_ARCHIVE_ENTRIES` | `2000` | Maximum ZIP entries |

Restart the backend after changing settings. Multipart requests also have a total limit of the upload limit plus 64 KiB of envelope allowance, enforced even without Content-Length. ZIP sizes and actual expanded bytes/CRCs are checked before EbookLib loads the archive. Supported IDPF/Adobe font obfuscation is allowed only for declared font resources; encrypted text and encrypted ZIP entries are rejected.

Run **one backend worker** with this local setup. Imports roll back database changes and remove generated files on processing/save failure. On startup, interrupted `.upload` files and UUID-named EPUBs without committed records are removed from the books folder; place manual sample files elsewhere, such as `backend/data/samples/`. This handles interrupted processes, not hardware failure or externally removed database/files.

Lockfiles remain in version control; install dependencies with `uv sync --locked` and `npm ci`. No Voicebox or model dependencies are installed here.

## Voicebox setup and your first narration

1. Install and launch [Voicebox separately](https://github.com/jamiepine/voicebox#download), using its own setup instructions. The inspected source is **v0.5.0, revision `51f49dea198384b4eb6087b72c17057c6eb1c1cd`**. See [verified contracts](docs/voicebox-contract.md). The reader rejects older schemas that lack the explicit generation controls it needs.
2. In Voicebox, configure a preset or cloned voice profile and download a compatible TTS model yourself. For a cloned voice, add its reference samples. Generate a short test there to confirm the voice/model is ready. The reader does not create voices or download models.
3. Keep Voicebox running. Its default API should be at `http://127.0.0.1:17493`; check `http://127.0.0.1:17493/docs`. If needed, set `VOICEBOX_BASE_URL` in the root `.env` and restart our backend.
4. Start this project's backend and frontend using the two terminal commands above. Open a book at `http://127.0.0.1:5173`.
5. Click **Narrate this paragraph** beside one paragraph. It becomes highlighted, and its text appears in the narration panel above the section. Choose a voice/profile and a downloaded compatible model.
6. Click **Generate narration**. The status progresses from pending to queued/generating, then completed. Press **Play** in the browser audio player. Playback requires this user action; it never starts automatically. Use the native pause and seek controls.
7. Request the same paragraph/profile/model again to reuse its audio. After editing a voice in Voicebox, use **Refresh Voicebox** and **Regenerate** to explicitly create fresh audio. Normal requests also detect profile metadata/version/model identity changes where exposed.

Voicebox status is separate from backend health. An offline speech service does not prevent section navigation. Previously cached audio remains playable without Voicebox; select the same paragraph and use **Refresh saved narrations** to load its saved results. Selecting another paragraph or voice does not attach the previous request's audio to the new selection; generation can finish in the background and is available when you return.

### Narration configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `VOICEBOX_BASE_URL` | `http://127.0.0.1:17493` | External local service, no frontend direct calls |
| `VOICEBOX_TIMEOUT_SECONDS` | `10` | HTTP operation timeout; this is not a total model-generation timeout |
| `VOICEBOX_POLL_SECONDS` | `2` | Interval between background reconciliation passes |
| `MAX_NARRATION_CHARS` | `5000` | Local paragraph cap, also bounded by provider schema and 50,000 |
| `MAX_AUDIO_BYTES` | `104857600` | Maximum downloaded WAV bytes per result |

The inspected provider accepts up to 50,000 characters and performs its own internal splitting above 800 characters. This milestone submits one selected paragraph; our own general chunking and continuous playback remain deferred. Effects and personality rewriting are explicitly disabled. Language comes from the selected Voicebox profile.

Audio lives under `backend/data/audio/<audio-uuid>.wav` by default and is served only by `/api/audio/{audio_id}`. HTTP range responses support seeking. The cache includes exact stored text, paragraph ID, Voicebox address/version/backend, exposed model repository identity, profile ID/metadata, and all sent generation settings. Provider model weight hashes and sample-content revisions are not exposed; use **Regenerate** after changing them. Repeated explicit regenerations retain earlier audio versions and consume disk space; automatic eviction is outside this milestone.

### Failed or interrupted narration

- Before submission, missing models, invalid profiles, incompatible schemas, and excessive text produce clear errors without enqueueing work. Fix the Voicebox setup or choose another paragraph/model.
- When Voicebox reports generation failure, the job becomes failed. **Regenerate** is an explicit new request; ordinary repeated Generate calls do not silently resubmit failed work.
- With a saved provider ID, temporary connectivity failures keep the request available for polling. Restarting our backend resumes reconciliation by that ID, without generation resubmission.
- A timeout, server error, or reader shutdown during submission can leave the outcome unknown. The job becomes failed with an ambiguity message. Check Voicebox history before using **Regenerate**, since the provider might already be producing audio. There is no verified idempotency-key contract or safe automatic match by text.
- If downloading/caching audio fails, **Retry audio retrieval** polls the same provider ID and downloads again; it does not generate another recording.
- **Recheck provider job** only reconciles an existing ID. Use it after resolving provider/configuration problems. If you changed the Voicebox address, restore the original address before rechecking old jobs; IDs are not assumed portable between services.
- Startup recovers interrupted jobs and removes unreferenced UUID audio files/partial downloads. Run one backend worker with each data directory.

### Narration verification

Run `uv run pytest` in `backend/` and `npm run build` in `frontend/`. Narration tests use `httpx.MockTransport`, synthetic EPUBs, and synthetic WAV bytes. They verify the HTTP contract and application behavior; they do **not** verify actual TTS or browser decoding. The existing two upstream test-client deprecation warnings remain.

Live Voicebox at port 17493 was unavailable during implementation. Browser automation was also unavailable. To complete live/manual checks:

1. Follow the first-narration steps with a short paragraph and verify audible playback, pause, and seeking.
2. Repeat Generate and confirm cached reuse; explicitly Regenerate and confirm a new recording appears.
3. Start a generation, select another paragraph, and confirm the old result is not displayed as that paragraph's narration. Return to the original and refresh saved narrations.
4. Restart our backend while Voicebox is generating, then return to the paragraph; confirm the saved provider ID is reconciled.
5. Stop Voicebox, verify EPUB navigation still works and already-cached audio plays, then restart Voicebox and refresh its status.

No automatic next-paragraph playback, audiobook export, word highlighting, browser-speech fallback, or voice-cloning UI is included.
