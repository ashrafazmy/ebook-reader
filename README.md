# Local EPUB Reader

A single-user web application being built for reading unencrypted EPUBs and listening to AI narration locally.

**Implemented: milestones 1–4 and 5A.** EPUB upload and reading, paragraph narration, saved chapter audiobooks, and persistent listening position, responsive controls, and opt-in home Wi-Fi access. Production code uses real HTTP calls; mocks are used only in tests.

Voicebox/Kokoro chapter generation was **verified live on 2026-09-12**, alongside mock-based tests. Browser playback and automatic continuation remain manual checks. Books, text, jobs, cached chunks, chapter files, and listening position persist across restarts. Saved audio and reading remain available without Voicebox.

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
5. Click **Narrate this paragraph** beside one paragraph. It becomes highlighted, and its text appears in the narration panel above the section. Choose a voice/profile and a downloaded compatible model.
6. Click **Generate narration**. The status progresses from pending to queued/generating, then completed. Click **Load paragraph in player**, then press **Play** in the shared bottom player. Playback requires this user action; it never starts automatically. Use the native pause and seek controls.
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

The inspected provider accepts up to 50,000 characters and performs its own internal splitting above 800 characters. Paragraph generation remains available alongside chapter generation. Effects and personality rewriting are explicitly disabled. Language comes from the selected Voicebox profile.

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

Voicebox was unavailable during the initial milestone 3 implementation. Milestone 4 subsequently verified real chapter generation; browser automation is still unavailable. To complete browser checks:

1. Follow the first-narration steps with a short paragraph and verify audible playback, pause, and seeking.
2. Repeat Generate and confirm cached reuse; explicitly Regenerate and confirm a new recording appears.
3. Start a generation, select another paragraph, and confirm the old result is not displayed as that paragraph's narration. Return to the original and refresh saved narrations.
4. Restart our backend while Voicebox is generating, then return to the paragraph; confirm the saved provider ID is reconciled.
5. Stop Voicebox, verify EPUB navigation still works and already-cached audio plays, then restart Voicebox and refresh its status.

No automatic next-paragraph generation, audiobook export UI, word highlighting, browser-speech fallback, or voice-cloning UI is included.

## Generate and listen to a saved chapter

1. Keep Voicebox running with your profile and compatible model downloaded. Start the backend and frontend using the commands in **Run** above, then open a book.
2. Select the section you want to narrate. Expand **Chapter audio**, then in **Chapter audiobook** choose a voice and model, then click **Generate chapter**. The initial chapter mapping is one existing section (one text-bearing EPUB spine item), which may be part of a chapter or contain several chapters.
3. Watch queued/generating/assembling/ready status and the completed-chunk count. There are no time estimates. You may navigate away or close the browser; the backend keeps working while it remains running.
4. When ready, select a **Saved audio version**, click **Load chapter in player**, then press the bottom player's native **Play** button. Use its pause/seek controls and the playback-speed selector. Position is saved every five seconds during playback, on pause/seek/speed changes, and best-effort during page exit/navigation.
5. Refresh or reopen the book: the saved chapter/audio version, offset, and speed are restored, **without autoplay**. Periodic saves limit loss on an abrupt browser crash to roughly five seconds; exit saves cannot be guaranteed after a force quit.
6. After user-started playback reaches the end, the player continues to the next section's ready audio with the same profile/model, if available. Otherwise it explains the missing audio. Browser autoplay restrictions may require another Play click. The bottom player’s Previous/Next chapter buttons select adjacent ready audio. Reading navigation is independent and never replaces the active audio.
7. Close Voicebox after the chapter is ready and continue listening. Keep our FastAPI backend running, and keep Vite running when using this development setup; this is not a PWA or a phone download feature.

**Saved audio version** lets you choose earlier ready recordings; press **Load chapter in player** to explicitly switch audio. Generation uses a snapshot of profile, engine/model, language, and all generation settings. Changing the selectors does not mutate a running job. If the exposed profile/model identity changes mid-generation, remaining submissions fail clearly instead of mixing voices. Use **Generate replacement** for an intentionally changed profile; older ready versions remain playable until and after the replacement succeeds. The player does not switch away from a selected old version mid-playback.

Ordinary Generate clicks reuse a matching chapter job and compatible cached chunks, including whole-paragraph audio generated in milestone 3. Generate replacement explicitly creates fresh chunk recordings (already in-flight matching work can still be shared). Repeated clicks while a matching job runs do not enqueue duplicates.

### Cancel, retry, and restart

- **Cancel remaining work** stops further chunk scheduling. One already scheduled/shared chunk may still complete in Voicebox; its recording is retained. Cancellation does not kill Voicebox or invalidate another consumer's cached recording.
- **Retry / resume remaining work** keeps completed chunks. It resumes cancelled work, retries definitively failed generations, and rechecks known provider IDs for retrieval/configuration errors. Failed assembly can retry using only cached chunks, with Voicebox offline.
- Unknown submission outcomes are never silently resubmitted. Check Voicebox history first; the explicit checkbox authorizes creating a new submission for unresolved chunks. Without that acknowledgement, Retry returns a clear error.
- Backend restarts reconcile saved provider IDs through history. A submission-started marker without a provider ID becomes ambiguous. Interrupted assembly can safely restart because it only reads cached chunks.
- Assembly accepts only matching mono/stereo PCM WAV chunks (same sample rate and sample width). Unsupported, mismatched, truncated, or oversized audio fails without publishing a ready file. Completed chunks and old chapter versions remain. Fix storage/format issues and retry, or request a replacement if new recordings are required.

### Chapter storage and limits

- Chunk WAVs remain under `DATA_DIR/audio`; final chapter WAVs are under `DATA_DIR/chapters/<audio-uuid>.wav`. Never move or rename these files independently of SQLite.
- `CHAPTER_CHUNK_CHARS=800` sets the default deterministic split limit, additionally bounded by the configured paragraph cap and live provider schema. Blocks/headings remain in section order. Long blocks prefer sentence boundaries; a sentence longer than the limit falls back to whitespace between words. An individual over-limit word is rejected rather than modified. Every source character, punctuation mark, and offset is preserved within stored chunk spans.
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

The native section selector replaces the need for a sidebar or modal drawer. Chapter generation and paragraph narration use keyboard-accessible disclosure controls; chapter generation counts remain in the chapter disclosure heading when closed. Selecting **Narrate this paragraph** opens its panel and focuses its heading. There are no modal dialogs or custom focus traps.

One shared player stays mounted when you open/close these controls, choose reading sections, visit the bookshelf, or open another book. Only loading different audio or choosing an adjacent audio chapter changes the source. Paragraph and chapter recordings share this player, preventing overlap within one tab. Separate browser tabs/devices remain independent; avoid starting several at once.

The bottom player uses native play/pause and seeking, plus speed and chapter controls. Its measured height reserves reading space, including the phone safe area; in short landscape viewports its controls can scroll. Book text wraps and retains adjustable size. Loading/restoring audio does not autoplay; automatic next-chapter playback remains subject to browser permission and displays a message if rejected. The native player reflects actual browser playback state rather than an optimistic “playing” label.

Chapter progress saves to SQLite every five seconds during playback, on pause/seek/speed change, and best-effort on hiding/leaving the page. A local-storage book ID is only a resume hint; the backend is the source of the saved version/position/speed. Opening a book restores its saved position without replacing audio already loaded. Paragraph progress is not persisted. Refreshing reloads the media; it cannot preserve uninterrupted sound. Force quits and OS suspension can prevent the final save. A phone and laptop share the latest saved position per book; simultaneous playback can overwrite it.

### Verification and manual phone checks

Automated checks for 5A: `cd frontend && npm test` runs eight jsdom tests with mocked media/network APIs (navigation continuity, single-player replacement, passive restoration, versioned saves, ordered continuation/rejected play, and missing next audio, stale continuation responses, and failed-save retry). `npm run build` checks TypeScript and builds Vite. `cd backend && uv run pytest` runs the 58 existing tests. These are not browser audio or layout tests.

A temporary opt-in Vite server on port 5174 served the page and proxied `/api/health` through the Mac’s LAN address, returning `{"status":"ok"}`. This was a request from the Mac itself, not a phone. No browser automation was available: desktop/mobile emulation, horizontal-overflow measurements, audible playback, and actual phone/background/lock-screen behavior have **not** been verified for 5A. The milestone 4 live generation evidence remains separate above.

On your phone, check:

1. Open the LAN URL. Confirm **Backend connected**, browse books, upload your unencrypted EPUB using the file picker, and check upload loading/error states.
2. Open a book. Use the section selector, previous/next buttons, and font-size slider. At narrow widths (320, 375, 390, and 430 CSS pixels in desktop developer tools), also check long titles and that the page does not scroll sideways. Check desktop width (1280 pixels) separately. Emulation does not replace phone testing.
3. Expand **Chapter audio**. Generate a short section or load a saved version. Close the disclosure while generation runs and confirm its chunk count updates. Leave and return; completed audio should remain available.
4. Load chapter audio and press Play. Seek forward/back, pause, and change speed. While it plays, open menus, navigate reading sections, visit the bookshelf, and open another book: the same recording should continue. Load a paragraph explicitly and confirm the chapter stops with only one player visible.
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
