# Local EPUB Reader

A single-user web application being built for reading unencrypted EPUBs and listening to AI narration locally.

**Implemented: milestones 1–4, 5A, 5A.1, and 5B.** EPUB upload and reading, chapter-only narration, saved chapter audiobooks, persistent listening position, responsive controls, home Wi-Fi access, and a production PWA with explicit device chapter downloads. Production code uses real HTTP calls; mocks are used only in tests.

Voicebox/Kokoro chapter generation was **verified live on 2026-09-12**, alongside mock-based tests. Browser playback and automatic continuation remain manual checks. Books, text, jobs, cached chunks, chapter files, and listening position persist across restarts. Saved audio and reading remain available without Voicebox.

For installation and network-independent reading/listening, use the **[5B private HTTPS and offline testing guide](docs/pwa-testing.md)**. Ordinary LAN HTTP development remains online-only. Only chapters explicitly marked **Available offline** are available without the laptop.

## Prerequisites

- [uv](https://docs.astral.sh/uv/getting-started/installation/) for Python dependencies and Python 3.11 installation.
- Node.js 22.12+ on the 22.x line (recommended), 24.x, or 26+, and npm. The installed Node 22.14.0 works with this setup; see [Vite requirements](https://vite.dev/guide/).
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

Upgrading to milestone 4: restart the backend to create the additive chapter job, chunk, and listening-progress tables. Existing book/narration tables and cached audio are preserved. Run the usual `uv sync --locked` and `npm ci`; there are no new dependencies. PCM WAV assembly uses Python 3.11's standard `wave` module; FFmpeg is not required.

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

This is a text reader: headings and paragraph boundaries are preserved, but inline styling, layout, images, tables as grids, custom fonts, original pagination, and exact typography are not reproduced. Whitespace is normalized during import and explicit line breaks retained. Script/style/embedded content is discarded; remaining text is rendered as escaped React text. Multiple renditions and non-HTML spine documents are unsupported. Reopening restores the last saved listening chapter/version and audio offset when available; text-only bookmarks and scroll position are not persisted.

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
5. Choose a section using the reader’s **Section** selector. Expand **Chapter audio**, then choose a voice and downloaded model.
6. Click **Generate chapter**. Watch queued/generating/assembling status and the completed chunk count. Once ready, choose a **Saved audio version** and click **Load chapter in player**, then press **Play** in the bottom player.
7. Repeating Generate reuses compatible cached chapter/chunk audio. After changing a profile in Voicebox, click **Refresh chapter voices** and use **Generate replacement** to request a fresh version. Older chapter versions remain available.

Voicebox status is separate from backend health. It is required for new speech generation, but reading and saved chapter playback work without it. Chapter generation continues when you navigate away. Paragraphs are ordinary selectable, copyable text; narration is selected at chapter level only.

### Narration configuration

| Setting | Default | Meaning |
| --- | --- | --- |
| `VOICEBOX_BASE_URL` | `http://127.0.0.1:17493` | External local service, no frontend direct calls |
| `VOICEBOX_TIMEOUT_SECONDS` | `10` | HTTP operation timeout; this is not a total model-generation timeout |
| `VOICEBOX_POLL_SECONDS` | `2` | Interval between background reconciliation passes |
| `MAX_NARRATION_CHARS` | `5000` | Per-request cap used by internal chunking and legacy APIs; also bounded by provider schema and 50,000 |
| `MAX_AUDIO_BYTES` | `104857600` | Maximum downloaded WAV bytes per result |

The inspected provider accepts up to 50,000 characters and performs its own internal splitting above 800 characters. The chapter service splits stored text into bounded chunks; paragraph-level controls are no longer part of the interface. Effects and personality rewriting are explicitly disabled. Language comes from the selected Voicebox profile.

Internal chunk audio remains under `backend/data/audio/<audio-uuid>.wav`; final chapter files are under `backend/data/chapters/` and served by `/api/chapter-audio/{audio_id}` with byte-range seeking. Exact text, source IDs, voice/model/provider identity, and settings remain part of cache identity. Use **Generate replacement** after changing a profile whose sample revisions are not exposed by Voicebox. Earlier files are retained; automatic cache eviction is outside this milestone.

### Retained internal narration machinery

The original `NarrationService`, `narrations` table, and cached recordings remain because chapter chunks reference those rows for provider job IDs, deduplication, retries, and restart recovery. Whole-block chunks can reuse compatible audio created before 5A.1. The frontend no longer calls `/api/narrations` or renders individual recordings.

Legacy `/api/narrations` and `/api/audio/{audio_id}` routes are retained for compatibility, inspection/recovery of existing jobs, and regression tests that seed legacy cache entries. Chapter scheduling calls the shared service/database directly rather than these HTTP routes. The same router also provides `/api/voicebox/profiles`, which chapter voice selection needs. Removing the old UI requires no backend removal or migration; no records, uploaded books, cached chunks, or chapter files are deleted.

Failed/interrupted chapter work is handled through **Retry / resume remaining work** and the ambiguity acknowledgement described below. Provider IDs are reconciled rather than blindly resubmitted. Existing legacy requests can still finish during backend recovery.

## Generate and listen to a saved chapter

1. Keep Voicebox running with your profile and compatible model downloaded. Start the backend and frontend using the commands in **Run** above, then open a book.
2. Select the section you want to narrate. Expand **Chapter audio**, then in **Chapter audiobook** choose a voice and model, then click **Generate chapter**. The initial chapter mapping is one existing section (one text-bearing EPUB spine item), which may be part of a chapter or contain several chapters.
3. Watch queued/generating/assembling/ready status and the completed-chunk count. There are no time estimates. You may navigate away or close the browser; the backend keeps working while it remains running.
4. When ready, select a **Saved audio version**, click **Load chapter in player**, then press the bottom player's native **Play** button. Use its pause/seek controls and the playback-speed selector. Position is saved every five seconds during playback, on pause/seek/speed changes, and best-effort during page exit/navigation.
5. Refresh or reopen the book: the saved chapter/audio version, offset, and speed are restored, **without autoplay**. Periodic saves limit loss on an abrupt browser crash to roughly five seconds; exit saves cannot be guaranteed after a force quit.
6. After user-started playback reaches the end, the player continues to the next section's ready audio with the same profile/model, if available. Otherwise it explains the missing audio. Browser autoplay restrictions may require another Play click. The bottom player’s Previous/Next chapter buttons select adjacent ready audio. Reading navigation is independent and never replaces the active audio.
7. Close Voicebox after the chapter is ready and continue listening. Keep our FastAPI backend running, and keep Vite running when using this development setup; server playback still needs the laptop. For network-independent playback, explicitly download the chapter using milestone 5B.

**Saved audio version** lets you choose earlier ready recordings; press **Load chapter in player** to explicitly switch audio. Generation uses a snapshot of profile, engine/model, language, and all generation settings. Changing the selectors does not mutate a running job. If the exposed profile/model identity changes mid-generation, remaining submissions fail clearly instead of mixing voices. Use **Generate replacement** for an intentionally changed profile; older ready versions remain playable until and after the replacement succeeds. The player does not switch away from a selected old version mid-playback. Device downloads remain tied to that exact version after server replacement.

Ordinary Generate clicks reuse a matching chapter job and compatible cached chunks, including whole-paragraph audio generated in milestone 3. Generate replacement explicitly creates fresh chunk recordings (already in-flight matching work can still be shared). Repeated clicks while a matching job runs do not enqueue duplicates.

### Cancel, retry, and restart

- **Cancel remaining work** stops further chunk scheduling. One already scheduled/shared chunk may still complete in Voicebox; its recording is retained. Cancellation does not kill Voicebox or invalidate another consumer's cached recording.
- **Retry / resume remaining work** keeps completed chunks. It resumes cancelled work, retries definitively failed generations, and rechecks known provider IDs for retrieval/configuration errors. Failed assembly can retry using only cached chunks, with Voicebox offline.
- Unknown submission outcomes are never silently resubmitted. Check Voicebox history first; the explicit checkbox authorizes creating a new submission for unresolved chunks. Without that acknowledgement, Retry returns a clear error.
- Backend restarts reconcile saved provider IDs through history. A submission-started marker without a provider ID becomes ambiguous. Interrupted assembly can safely restart because it only reads cached chunks.
- Assembly accepts only matching mono/stereo PCM WAV chunks (same sample rate and sample width). Unsupported, mismatched, truncated, or oversized audio fails without publishing a ready file. Completed chunks and old chapter versions remain. Fix storage/format issues and retry, or request a replacement if new recordings are required.

### Chapter storage and limits

- Chunk WAVs remain under `DATA_DIR/audio`; final chapter WAVs are under `DATA_DIR/chapters/<audio-uuid>.wav`. Never move or rename these files independently of SQLite.
- `CHAPTER_CHUNK_CHARS=800` sets the default deterministic split limit, additionally bounded by the configured per-request cap and live provider schema. Blocks/headings remain in section order. Long blocks prefer sentence boundaries; a sentence longer than the limit falls back to whitespace between words. An individual over-limit word is rejected rather than modified. Every source character, punctuation mark, and offset is preserved within stored chunk spans.
- `MAX_CHAPTER_AUDIO_BYTES=1073741824` limits an assembled file to 1 GiB by default. PCM files are larger than compressed MP3s. No resampling, encoding conversion, cache eviction, or external audio dependency is added.
- Run one backend worker per data directory. At most one chapter chunk is outstanding globally, while the existing paragraph API remains available. Voicebox owns model inference scheduling.
- Progress is one latest listening position per book, associated with the exact chapter job/audio version. Timestamp-ordered writes reject stale save requests; the newest save wins across tabs on this single-user machine.

### Milestone 4 verification

From the repository root:

```sh
cd backend
uv run pytest
cd ../frontend
npm run build
```

Mock tests cover deterministic spans and order, paragraph-cache reuse, concurrent duplicate prevention, cancellation/resume, partial failure/retry, ambiguous outcomes, assembly format checks/atomic replacement, restart reconciliation, profile snapshot protection, and saved progress. Existing paragraph and EPUB tests remain included.

**Live result (2026-09-12):** Voicebox 0.5.0 with the configured Kokoro profile generated two original-text chunks: “A short journey” and “The little boat crossed the quiet lake.” The assembled output was verified as 24 kHz, mono, 16-bit PCM, 108,600 frames (4.525 seconds). A restarted test backend served identical audio, HTTP 206 seek ranges, and the saved one-second offset at 1.25× with all Voicebox HTTP access deliberately blocked. The isolated test library is ignored at `backend/data/live-chapter-check`; it does not alter your normal bookshelf.

**Not verified automatically:** audible browser playback, automatic chapter continuation, and playback after physically closing the Voicebox application. No browser tooling was available. Complete these exact manual checks:

1. Generate two adjacent sections with the same voice/model. Play the first and let it end; confirm the second starts. With the next section ungenerated, confirm the unavailable-audio explanation.
2. Pause midway, change speed, refresh, and confirm chapter/version/offset/speed restoration without sound starting by itself. Navigate to the bookshelf and reopen the book; repeat after restarting our backend.
3. Close Voicebox completely, reload the reader, and play/seek a ready chapter. Our frontend/backend must remain running.
4. Start a longer chapter, navigate away, return, and confirm its count advances. Cancel, wait for any outstanding chunk, then resume; completed counts/audio should be retained.
5. Generate a replacement and confirm the old version keeps playing until you explicitly choose the new ready version.

PWA support, cloud deployment, offline phone downloads, full-book export, and word-level highlighting remain outside this milestone.


## Milestone 5A: use your phone on home Wi-Fi

Run `npm ci` in `frontend/` after updating; Vitest and jsdom are new development-only dependencies for playback regression tests. The test runner requires Node 22.12+ on 22.x, 24.x, or 26+; your existing Node 22.14.0 is supported. Node 20 is no longer supported for this frontend development setup. There are no backend dependencies or database changes for 5A.

On the laptop, terminal 1, from the repository root:

```sh
cd backend
uv sync --locked
uv run uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Terminal 2, from the repository root:

```sh
cd frontend
npm ci
npm run dev:lan
```

`dev:lan` explicitly binds **only Vite** to `0.0.0.0:5173`. The regular `npm run dev` remains loopback-only. Vite proxies relative `/api` requests, including upload and seekable audio, to `127.0.0.1:8000` on the laptop. FastAPI and Voicebox stay on loopback. No unrestricted allowed-host or CORS settings are enabled.

Find the Wi-Fi interface and address on the Mac:

```sh
networksetup -listallhardwareports
ipconfig getifaddr en0
```

In the first command’s output, find **Hardware Port: Wi-Fi** and its **Device**. Replace `en0` in the second command if that device has another name. Alternatively, see System Settings → Wi-Fi → your connected network’s Details → TCP/IP. Use the Wi-Fi address, not a VPN interface address.

On a phone connected to the **same home Wi-Fi**, open **`http://<MAC_WIFI_IP>:5173`** in Safari or Chrome. For example, if the Wi-Fi IP is `192.168.1.25`, open `http://192.168.1.25:5173`. Use HTTP for this milestone. The IP is never stored in frontend code. The laptop must remain awake, with both servers running; its address can change after reconnecting. Voicebox is needed for new generation, but can be closed for saved playback.

This is an unauthenticated, single-user development app: other devices able to reach this LAN port can access the library and its API through the proxy. Use a trusted home network and stop Vite when finished. Do not expose Voicebox, disable your firewall, or configure router port forwarding.

### Mobile controls and playback

The native section selector replaces the need for a sidebar or modal drawer. Chapter generation uses a keyboard-accessible disclosure control; its completed chunk count remains visible in the heading when closed. Paragraphs remain normal text with native text selection and copying. There are no modal dialogs or custom focus traps.

One shared player stays mounted when you open/close these controls, choose reading sections, visit the bookshelf, or open another book. Only loading different audio or choosing an adjacent audio chapter changes the source. All chapter versions use this one player, preventing overlap within one tab. Separate browser tabs/devices remain independent; avoid starting several at once.

The bottom player uses native play/pause and seeking, plus speed and chapter controls. Its measured height reserves reading space, including the phone safe area; in short landscape viewports its controls can scroll. Book text wraps and retains adjustable size. Loading/restoring audio does not autoplay; automatic next-chapter playback remains subject to browser permission and displays a message if rejected. The native player reflects actual browser playback state rather than an optimistic “playing” label.

Chapter progress saves to SQLite every five seconds during playback, on pause/seek/speed change, and best-effort on hiding/leaving the page. A local-storage book ID is only a resume hint; the backend and device IndexedDB synchronize the saved version/position/speed under the 5B rules below. Opening a book restores its saved position without replacing audio already loaded. Refreshing reloads the media; it cannot preserve uninterrupted sound. Force quits and OS suspension can prevent the final save. A phone and laptop share the latest saved position per book; simultaneous playback can overwrite it.

### Verification and manual phone checks

Automated checks for 5A: `cd frontend && npm test` includes eight playback jsdom tests with mocked media/network APIs (navigation continuity, single-player replacement, passive restoration, versioned saves, ordered continuation/rejected play, and missing next audio, stale continuation responses, and failed-save retry). `npm run build` checks TypeScript and builds Vite. `cd backend && uv run pytest` runs the 58 existing tests. These are not browser audio or layout tests.

A temporary opt-in Vite server on port 5174 served the page and proxied `/api/health` through the Mac’s LAN address, returning `{"status":"ok"}`. This was a request from the Mac itself, not a phone. No browser automation was available: desktop/mobile emulation, horizontal-overflow measurements, audible playback, and actual phone/background/lock-screen behavior have **not** been verified for 5A. The milestone 4 live generation evidence remains separate above.

On your phone, check:

1. Open the LAN URL. Confirm **Backend connected**, browse books, upload your unencrypted EPUB using the file picker, and check upload loading/error states.
2. Open a book. Use the section selector, previous/next buttons, and font-size slider. At narrow widths (320, 375, 390, and 430 CSS pixels in desktop developer tools), also check long titles and that the page does not scroll sideways. Check desktop width (1280 pixels) separately. Emulation does not replace phone testing.
3. Expand **Chapter audio**. Generate a short section or load a saved version. Close the disclosure while generation runs and confirm its chunk count updates. Leave and return; completed audio should remain available.
4. Load chapter audio and press Play. Seek forward/back, pause, and change speed. While it plays, open menus, navigate reading sections, visit the bookshelf, and open another book: the same recording should continue. Explicitly load another saved chapter/version and confirm the old recording stops with only one player visible.
5. Return to the chapter, play and pause midway, then refresh: saved offset/version/speed should restore without autoplay. Repeat after restarting the backend. Generate two adjacent sections with the same voice/model and test automatic continuation; test the message when the next audio is unavailable.
6. Close Voicebox, keeping frontend/backend running. Reload and play/seek saved audio. Generation should report Voicebox unavailable while reading and saved playback remain usable.
7. Rotate portrait/landscape, increase text size, and scroll to the final paragraph and buttons. Check that the player/safe area does not obscure content; its controls can scroll in landscape. Test keyboard focus on desktop and VoiceOver labels on the phone.
8. Background the browser, lock the screen, then return and unlock. Record your phone model, OS/browser version, whether sound continued, displayed play/pause state, and saved position. Interruptions may require pressing Play again. **Uninterrupted background or lock-screen playback is not promised.**

### Connection troubleshooting

- If the phone cannot open the page, confirm `npm run dev:lan` is running, use the current Wi-Fi IP and port 5173, and use `http://`, not HTTPS or `localhost`. Stop a conflicting dev server if Vite reports the port occupied.
- Check the page on the Mac using that same LAN URL. If it works there but not on the phone, check both devices’ Wi-Fi, guest-network/client isolation, and VPN routing. Permit incoming connections for the Node/Vite process in macOS firewall settings if prompted; keep the firewall enabled.
- If the page loads but says backend offline, verify terminal 1 and run `curl --fail http://127.0.0.1:8000/api/health` on the Mac, then `curl --fail http://127.0.0.1:5173/api/health`. Keep the backend on port 8000 to match the proxy.
- If Voicebox alone is offline, start it only on the laptop and refresh its status. Cached audio needs our backend, not Voicebox. If audio stops after laptop sleep, wake it and ensure the servers are still running.

Service workers, PWA installation, offline phone downloads, secure-origin PWA testing, cloud hosting, and authentication remain outside 5A. Secure-origin testing belongs to 5B.


## Milestone 5A.1 verification: chapter-only narration

No setup, dependencies, database migration, or startup commands changed. Run `npm test` and `npm run build` in `frontend/`, and `uv run pytest` in `backend/`.

Automated checks cover the eight shared-player scenarios plus four app-level cases: bookshelf/reader controls with 360px and 1280px window values, selectable text and stable block IDs, generation/queued status/cancel/retry requests, and one restored chapter player across navigation with Voicebox mocked offline. These jsdom tests do not render a visual layout or decode audio. The 58 backend tests cover generation, queue/cache reuse, cancellation/partial retry, assembly, restart recovery, audio ranges, and persisted progress with a simulated offline provider. No new live Voicebox generation or actual browser/phone playback was performed for 5A.1.

Manual checks on desktop and phone:

1. Browse the bookshelf, open a book, and expand **Chapter audio**. Confirm there are no paragraph narration buttons, paragraph status panels, or narration selection highlights. Select and copy text across paragraphs; wording and paragraph boundaries should be unchanged.
2. Choose a section, voice, and model; **Generate chapter**. Confirm queued/generating/assembling progress. Cancel remaining work and retry/resume, checking that completed chunks are retained. Navigate away and return while generating.
3. Load a saved chapter version and press Play. Seek, change speed, pause, navigate to the shelf and back, then refresh. Confirm one player, uninterrupted playback during in-app navigation, and restored position/speed after refresh without autoplay.
4. Load another saved chapter/version explicitly. Confirm the old audio stops. Test previous/next audio chapter and automatic continuation to the next ready section.
5. Close Voicebox while keeping the reader frontend/backend running. Reload, then play and seek an existing saved chapter. Confirm reading and cached audio remain usable while new generation reports the service unavailable.
6. At narrow phone and desktop widths, verify readable text and accessible chapter controls. Actual rotation, background, and screen-lock checks remain the separate 5A device checklist above.

PWA/offline downloads, hosting, and direct Kokoro integration remain outside this change. Voicebox stays the external speech provider.


## Milestone 5B: installable app and explicit device downloads

The production build includes a manifest, PNG icons, and a service worker that caches only its emitted app-shell assets. Development assets and API responses are not precached. Chapter text, book/section metadata, audio version and WAV are saved in IndexedDB only after **Download for offline**. A single storage transaction publishes the audio and Ready metadata together. Downloading/interrupted, failed, ready and removed states are visible; removal affects the device only. Previous server versions and all backend generation machinery remain intact.

Use **Device downloads** to read downloaded chapters and load their audio into the existing one-player controls. WAV Blob URLs support local seeking. Progress is written locally first and reconciled on reconnection/foreground entry and periodically while visible. Same-version conflicts use edit timestamps, not furthest position; independently changed versions require a choice. Updates wait until all reader windows close, so they never force a playback reload. Missing/evicted downloads require reconnecting and downloading again.

The production preview has a loopback API proxy and an opt-in private HTTPS mode. From `frontend/`, run `npm ci`, `npm run build`, then `npm run preview:https` after the certificate setup. The phone URL is **`https://<MAC_WIFI_IP>:4173`**. Keep the address stable; browser storage is per origin. Read the **[exact Mac certificate setup, phone trust/install steps, conflict rules and airplane-mode checklist](docs/pwa-testing.md)** before testing. Do not bypass certificate warnings. No CA or device trust settings were changed automatically.

New test-only dependencies are fake-indexeddb and Playwright. Runtime dependencies and SQLite schema are unchanged. `npm test` covers downloads and progress alongside the existing player/reader tests; `npm run test:e2e` tests the built application with Chromium and mocked API data. The 58 backend tests still cover generation, queue, cancellation/retry, server audio seeking, cache reuse and restart recovery. Browser tests use synthetic silent audio; they do not verify Voicebox generation or audible narration on a phone.


**5B verification completed on 2026-09-13:** 31 frontend unit/DOM tests, 5 Chromium production-browser tests, all 58 backend tests, and the production build passed. Browser checks covered explicit download/retry/deletion, offline text and local WAV decoding/seeking, saved speed/offset after refresh, reconnection sync, a full browser-process restart with networking disabled, and update waiting/activation with downloaded content retained. Overflow checks passed at 320, 390, 430 and 1280 CSS pixels; 320/1280 screenshots were reviewed. Browser audio was a synthetic silent WAV and server responses were mocked. Actual phone installation, trusted LAN HTTPS, iOS/Android eviction behavior, audible Voicebox narration and lock-screen playback remain manual checks in the linked guide. The backend suite retains two upstream test-client deprecation warnings.

### Download and player improvements

Downloads now show actual received bytes, percentage/total when known, and separate verification/saving states. Activity remains visible when navigating away. Wait for **Available offline** before disconnecting; interrupted or failed transfers can be retried from **Device downloads**.

The player displays the playing chapter first and its book separately. Tap the title to expand it. **Downloaded chapters** lists saved versions in reading order, with duration when known. Selection opens local text, preserves play/pause intent and restores that audio version's saved position. Previous/Next target the adjacent section, and explain gaps instead of skipping them. Previously, audio navigation did not change the reader route; this is now corrected. Existing server audio and chapter generation are retained.

Run `npm test`, `npm run build`, and `npm run test:e2e` from `frontend/`; run `uv run pytest` from `backend/`. Follow the additional phone checks in [the PWA guide](docs/pwa-testing.md#download-and-player-regression-checklist). Actual installed-phone airplane-mode and audible playback checks remain manual.

Follow-up verification: stream tests cover known/unknown totals, partial transfer failure and retry. The multi-chapter Chromium test covers adjacent chapters, gaps, exact local text, per-version position/speed, playing/paused selection, rejected playback, missing Blobs and long titles. These use synthetic audio and simulated offline conditions, not an installed phone in airplane mode.

## Milestone 5B.1: whole-book actions

Open a book, expand **Chapter audio**, then **Whole book audio**. Single-chapter generation/download controls and the player remain available.

- **Generate all chapters** uses the Voice and Model selected above and the existing fixed defaults. The backend snapshots settings once and queues eligible sections in stored reading order. Matching completed, queued, running, failed and cancelled jobs are retained; repeated requests reuse backend cache keys. The scheduler still permits only one outstanding chapter chunk globally. Later UI selection changes do not change submitted work.
- Counts show completed, queued, running (including assembly), failed, cancelled and missing chapters for the selected voice/model. Click an original chapter title to open its existing retry/cancel controls. Failed/cancelled jobs require explicit chapter retry; the batch never retries unknown provider outcomes or requests replacement. Use **Generate replacement** for deliberate chapter regeneration.
- Submission results identify sections that could not be queued. After fixing the problem or losing a response, retry **Generate all chapters** safely: matching committed jobs are reused. Voicebox must be available to validate a new snapshot; existing audio remains playable without it.
- **Download all available audio** appears while some chapters are unavailable; **Download audiobook** appears when every section has ready audio. It chooses the newest ready version per section, across voices, in reading order. The fixed list excludes chapters that finish generating later.
- Downloads run sequentially through the existing WAV downloader. Valid matching copies are skipped. Each chapter's audio/text/metadata becomes **Available offline** atomically. The summary above the reader shows completed/total chapters and errors; expand it for known remaining audio size, cancellation and continuation. HEAD requests obtain sizes without downloading audio. Quota checks are best effort; unknown sizes, metadata overhead and later storage failures can still prevent completion.
- **Cancel after current chapter** stops before the next operation after the current one finishes safely. Completed and older audio versions remain. Reopen or recover from a failure using **Continue download**, which validates saved copies and retries missing/failed files. Continue retains the original plan; a new book-level download action after completion, cancellation or partial failure snapshots currently available versions instead.
- Transfers require the app to remain open. They are not guaranteed while locked, backgrounded or closed. Web Locks coordinate one batch across tabs on supporting secure-origin browsers. Without Web Locks, the guard applies only within one page: use one reader tab. Individual chapter downloads remain independent.

No new dependencies, SQLite migration, infrastructure or TTS-provider changes are needed. Browser database version 3 adds a small `download_batches` store so the exact plan survives reopening; existing downloads, audio and positions are retained. Close old reader windows if a storage upgrade is blocked.

### Short manual checklist

1. Run the existing startup commands. For the installed PWA, build and use the trusted HTTPS preview in [the PWA guide](docs/pwa-testing.md), then close all reader windows to activate the update.
2. Choose a voice/model, **Generate all chapters**, and repeat from another tab. Check that matching jobs are reused and counts update. Change selection while queued: submitted jobs must retain their original settings. Exercise chapter cancellation/retry and play earlier audio with Voicebox closed.
3. Download one chapter individually, then start the book download. Check that its valid copy is skipped, progress is sequential and visible after navigation, and newly generated chapters wait for another batch action.
4. Cancel after a chapter or close the app mid-transfer. Reopen and **Continue download**. Completed copies should remain; failed/incomplete files should retry. Check low-storage errors if practical.
5. Once downloaded, fully close the installed app, enable airplane mode, reopen, select chapters, seek, change speed, pause and refresh. Confirm saved positions and one-player behavior; reconnect and check progress sync.

Baseline verification passed: 58 backend tests, 31 frontend tests, five Chromium tests and the production build. Two existing upstream backend test-client deprecation warnings remain. Batch tests use mocked Voicebox, fake IndexedDB/stream failures and synthetic browser audio. Live batch generation and actual phone/lock-screen checks have not been run.

Final 5B.1 verification: **62 backend tests, 39 frontend tests, six production Chromium tests and the production build passed**. Added coverage includes concurrent duplicate generation requests, fixed settings/cache matching, book order/global scheduling, partial eligibility, offline preservation, existing downloads, sequential transfer/cancellation, persisted continuation, per-file retry, quota failures and separate replacement versions. Browser checks cover book controls and fixed download snapshots across navigation, plus the existing offline startup, seeking, resume, missing-file, update and narrow-screen regressions. No baseline failures were found; live Voicebox batch generation and installed-phone testing remain manual.
