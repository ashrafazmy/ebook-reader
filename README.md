# Local EPUB Reader

A single-user web application being built for reading unencrypted EPUBs and listening to AI narration locally.

**Implemented: milestones 1 and 2.** FastAPI health endpoint, React connection indicator, Vite API proxy, EPUB upload, persistent bookshelf, and a text reader with section navigation and adjustable font size. There is no mocked API behavior.

Voicebox calls, audio playback, and saved reading/narration progress are **not implemented yet**. Voicebox does not need to be running. Books and extracted text persist in SQLite across application restarts.

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

Root `.env` loads independently of the shell's working directory. Exported environment variables override `.env`. `VOICEBOX_BASE_URL` defaults to `http://127.0.0.1:17493` and is reserved for milestone 3; it causes no network requests now.

- `backend/app/main.py`: FastAPI application and typed health response.
- `backend/app/config.py`: validated environment settings.
- `backend/app/books.py`: import transaction and book routes.
- `backend/app/epub_parser.py`: bounded archive validation and spine-ordered text extraction.
- `backend/app/models.py`, `database.py`, `schemas.py`: persistent records, SQLite setup, and API response contracts.
- `backend/app/upload_limit.py`: request-body limit before multipart parsing completes.
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
