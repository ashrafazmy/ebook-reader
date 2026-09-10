# Local EPUB Reader

A single-user web application being built for reading unencrypted EPUBs and listening to AI narration locally.

**Implemented: milestone 1 only.** FastAPI health endpoint, environment configuration, React connection indicator, Vite API proxy, backend tests, and reproducible dependency lockfiles. There is no mocked API behavior.

Book uploads, EPUB parsing, SQLite persistence, chapter views, Voicebox calls, audio playback, and saved progress are **not implemented yet**. Voicebox does not need to be running for this milestone.

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

Open **http://127.0.0.1:5173**. You should see the EPUB Reader foundation page and **Backend connected**. The browser requests `/api/health`; Vite forwards it to FastAPI on port 8000. No CORS configuration is needed for this same-origin development flow.

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

Both curl requests should return `{"status":"ok"}`. Tests cover the health response and settings defaults/precedence. The frontend build type-checks TypeScript and writes static assets to ignored `frontend/dist/`. This milestone uses Vite's development server for the complete local application; serving the static build with an API reverse proxy is not configured as a deployment.

## Configuration and structure

Root `.env` loads independently of the shell's working directory. Exported environment variables override `.env`. `VOICEBOX_BASE_URL` defaults to `http://127.0.0.1:17493` and is reserved for milestone 3; it causes no network requests now.

- `backend/app/main.py`: FastAPI application and typed health response.
- `backend/app/config.py`: validated environment settings.
- `backend/tests/`: focused pytest behavior tests.
- `frontend/src/`: React UI and connection state.
- `frontend/vite.config.ts`: development server and `/api` proxy.
- `docs/architecture.md`: component explanation and roadmap.
- `AGENTS.md`: stack, commands, and conventions for future work.

Future local databases, uploads, and cached audio will live under ignored `data/`. No storage directories or database are needed yet. Lockfiles are included for version control; dependencies should be installed with `uv sync --locked` and `npm ci`.
