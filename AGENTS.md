# Project agreement

Build a single-user local EPUB reader with browser-based AI narration. Keep changes within the requested milestone. Milestones 1–3 are implemented; milestone 3 is verified with mocks only until a live Voicebox instance is tested. Milestone 4 is planned.

## Stack and layout

- `backend/`: Python 3.11, FastAPI, uv; pytest for behavior tests.
- `frontend/`: React, TypeScript, Vite; npm.
- EPUB reader: SQLite with SQLAlchemy; EbookLib and Beautiful Soup; local book storage under `backend/data/books` and database at `backend/data/reader.sqlite3` by default.
- Milestone 3: external Voicebox HTTP service, isolated behind `VoiceboxProvider`. Default `VOICEBOX_BASE_URL=http://127.0.0.1:17493`.
- Milestone 4: local audio cache and persisted narration progress.

## Commands

From `backend/`: `uv sync --locked`, `uv run pytest`, `uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000`.

From `frontend/`: `npm ci`, `npm run dev`, `npm run build`.

From the repository root: `curl --fail http://127.0.0.1:8000/api/health`.

## Conventions

- Keep Python modules small with explicit imports and type hints. Add modules when behavior needs them; avoid speculative layers.
- Use `/api` for backend routes and relative frontend requests. Vite proxies to port 8000. Bind development servers to loopback.
- Load backend configuration through `app/config.py`. Root `.env` is local; `.env.example` documents settings without secrets. Never place secrets in Vite client variables.
- Track `backend/uv.lock` and `frontend/package-lock.json`. Do not commit virtual environments, dependencies, generated output, databases, books, audio, or models.
- Add focused pytest tests for meaningful backend behavior; run tests and the frontend build for relevant changes.
- Preserve EPUB wording and spine order. Render extracted text safely. Implement archive/upload limits and encryption rejection before enabling uploads.
- Sections map to text-bearing HTML spine items, including non-linear items, in spine order. IDs and explicit positions are persisted; never regenerate them when reading. Font obfuscation alone is not text encryption.
- Keep imports transactional and clean up failed files. Run one backend worker; startup recovery removes only generated files without committed records. Resolve storage paths against the repository, never the current working directory.
- Before speech integration, inspect current Voicebox documentation, relevant source, and the running OpenAPI schema if available. Verify voice listing, generation, job status, audio retrieval, and text limits. Never invent contracts or use desktop-only playback.
- Do not fork/copy Voicebox or install its model dependencies here. Reading must remain usable when speech is offline.
- Voicebox contract evidence is in `docs/voicebox-contract.md`. Use the async `VoiceboxProvider` and `/generate` queue, with `personality=false` and `effects_chain=[]`. Never submit without model readiness checks or blindly repeat ambiguous POSTs.
- Narrations persist in SQLite; audio uses generated IDs under `DATA_DIR/audio`. Run one worker. Only known provider IDs may be reconciled automatically after restart; unresolved submissions need explicit user regeneration after checking provider history.
- No authentication, Docker, cloud deployment, Redis, or separate task platform at this stage.
- Distinguish implemented, planned, and mocked behavior in documentation. Do not push or create remote repositories without explicit authorization.
