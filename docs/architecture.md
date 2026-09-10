# Architecture and roadmap

## Milestone 1: implemented foundation

The browser runs React and TypeScript served by Vite on loopback port 5173. React fetches the relative URL `/api/health`. Vite forwards `/api` requests to FastAPI on loopback port 8000, keeping browser requests on one origin during development.

FastAPI returns HTTP 200 with `{"status":"ok"}`. This is a liveness check: it does not depend on a database or speech service. The UI shows checking, connected, or unreachable, rejects invalid health responses, and permits manual retries. Each request has a five-second timeout and is cancelled when the component is cleaned up. It does not poll in the background.

`backend/app/` is a Python package: `__init__.py` marks it as such, `main.py` owns HTTP entry points, and `config.py` owns validated settings. `uv sync` installs the package into `backend/.venv` with its dependencies. Uvicorn loads `app.main:app` (the `app` object in `app/main.py`) and serves HTTP. FastAPI's response model defines and documents the JSON contract. pytest uses FastAPI's in-process test client to exercise that contract without starting a server.

Pydantic Settings reads the root `.env` using a path relative to the source file, with environment variables taking precedence. Voicebox's base URL is configured now but unused. uv and npm lockfiles record resolved dependencies. EPUB, database, and model libraries are deliberately deferred until the milestone that needs them.

There is one repository, two application processes, and no authentication, cloud services, containers, queue server, or task platform. This foundation is intended for local loopback use. The frontend build is verified, but deployment is outside this milestone.

## Milestone 2: planned EPUB reader

Add upload APIs and local `data/books/` storage. Enforce upload bytes and decompressed archive limits, validate EPUB structure, and clearly reject invalid or unsupported encrypted files. Use EbookLib and Beautiful Soup to read metadata and content in spine order; supply readable defaults for missing metadata.

Preserve headings, paragraph boundaries, and original wording. Assign stable section and paragraph IDs at import and store them with book records in SQLite through SQLAlchemy (`data/reader.sqlite3`). React will render extracted text as text with semantic headings/paragraphs, without executing EPUB HTML or scripts. Build a bookshelf and chapter view. Add focused tests for valid import, malformed/encrypted archives, ordering, limits, and safe extraction.

## Milestone 3: planned Voicebox integration

Voicebox remains an external local service: https://github.com/jamiepine/voicebox. No source copy, fork, model installation, or model dependency belongs in this backend.

Before writing the adapter, inspect the current documentation, relevant source, and running service's OpenAPI schema if available. Record the verified voice-listing, generation, job-status, audio-retrieval contracts and provider text limits. No endpoint contract has been verified or assumed in milestone 1.

An isolated `VoiceboxProvider` will own HTTP communication using `VOICEBOX_BASE_URL` (default `http://127.0.0.1:17493`). Add speech connection status, voice selection, and generation of a short original passage. Retrieve playable audio for the browser rather than triggering desktop-only playback. Report unavailable service, missing models, timeouts, and generation failures without interrupting reading.

## Milestone 4: planned continuous narration

Split original text at paragraph or sentence boundaries within verified provider limits. Persist stable text-to-chunk mappings. Cache audio in `data/audio/` using text, provider/model identity, voice, and generation settings. Track generation jobs and deduplicate submissions; prepare only a small number of upcoming chunks and avoid blocking the API while waiting for generation. Choose the simplest in-process execution approach supported by the verified provider contract; no separate task platform is planned.

Add browser play/pause, previous/next chunk, playback speed, and active-chunk highlighting. Persist chunk ID and audio offset in SQLite to resume listening. Precise word highlighting is out of scope. Text remains readable without Voicebox, and narration never uses LLM rewriting.
