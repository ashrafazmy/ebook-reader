# Verified Voicebox contract

Inspected on 2026-09-10: upstream source revision **`51f49dea198384b4eb6087b72c17057c6eb1c1cd`**, whose `backend/__init__.py` declares **0.5.0**. The configured local service at `http://127.0.0.1:17493` did not respond, including an unsandboxed OpenAPI request. No live schema, real voice, model inference, or browser playback was verified. Tests use handcrafted mock responses derived from the source contracts, plus synthetic WAV audio; they do not demonstrate speech quality.

**2026-09-12 update:** the local service is now running. Its live OpenAPI reports 0.5.0 and a 50,000-character generation limit; health reports healthy and `/models/status` reports Kokoro downloaded. The existing generation/history/audio contracts successfully generated two original chapter chunks with the configured preset profile. Assembly produced a valid 24 kHz mono PCM16 WAV (4.525 seconds). Cached audio/range serving and progress survived a reader restart with all Voicebox requests blocked. The installed binary's commit hash is not exposed, so its revision is not assumed identical to upstream. Browser playback and application-closed UI checks remain manual.

## Evidence

- [README API instructions](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/README.md)
- [Version declaration](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/__init__.py)
- [Request/response models](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/models.py)
- [Generation submission and SSE status](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/routes/generations.py)
- [Persistent history status](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/routes/history.py)
- [Audio retrieval](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/routes/audio.py)
- [Profiles](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/routes/profiles.py) and [profile compatibility](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/services/profiles.py)
- [Health](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/routes/health.py), [model readiness](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/routes/models.py), and [engine/model registry](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/backends/__init__.py)
- [Generation queue](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/services/task_queue.py), [generation execution](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/services/generation.py), and [provider text splitting](https://github.com/jamiepine/voicebox/blob/51f49dea198384b4eb6087b72c17057c6eb1c1cd/backend/utils/chunked_tts.py)

The repository's bundled `docs/openapi.json` is **stale**: it declares API 0.1.0 and a 5,000-character limit with fewer generation fields. Current source declares a 50,000-character request limit. The adapter therefore reads the running `/openapi.json` before offering generation, verifies the required routes and payload fields exist, and rejects older incompatible contracts instead of sending fields that might be ignored. This checks structural compatibility, not every possible future behavioral change.

## Endpoints used

| Voicebox route | Verified contract and reader use |
| --- | --- |
| `GET /health` | JSON `status="healthy"`, with backend/model diagnostics. Reader uses health and `backend_type`; the default-model flag alone cannot establish selected-model readiness. |
| `GET /openapi.json` | FastAPI schema with `info.version`, route definitions, and `GenerationRequest.properties.text.maxLength`. Used for compatibility, effective text limit, and cache identity. |
| `GET /profiles` | JSON array of profiles: `id`, `name`, `language`, `voice_type`, optional `preset_engine`/`preset_voice_id`/`default_engine`, `sample_count`, `updated_at`. The adapter uses these to offer compatible choices. |
| `GET /models/status` | Object containing `models[]`: `model_name`, `display_name`, optional `hf_repo_id`, `downloaded`, `downloading`, `loaded`. Only verified TTS model names are offered; no STT/LLM models. |
| `POST /generate` | Returns HTTP 200 and `GenerationResponse` immediately after persisting a history row and enqueueing generation. ID is `id`, not a separate `job_id`. Initial `status` is `generating`, even while waiting in the queue. |
| `GET /history/{generation_id}` | JSON with ID, profile, text, language, engine, model size, status, error, duration, and other history fields. Used for durable polling/reconciliation. Expected statuses: `loading_model`, `generating`, `completed`, `failed`. |
| `GET /audio/{generation_id}` | File response for the generated audio. The verified generation path produces WAV; the reader downloads it to its own bounded cache. Provider `audio_path` is never used as a local path or arbitrary URL. |

`GET /generate/{generation_id}/status` is a verified **SSE stream**, not a JSON polling route. The adapter deliberately polls the durable history route instead. `/speak`, streaming desktop playback, personality/LLM endpoints, and model-download endpoints are not called. Provider retry/regenerate endpoints are not used: explicit reader regeneration creates a fresh normal generation with all settings recorded again.

## Submitted settings and limits

The reader retrieves the stored paragraph text itself and sends it unchanged with `profile_id`, profile `language`, the selected `engine`/`model_size`, `personality=false`, `effects_chain=[]`, `normalize=true`, `seed=null`, and `instruct=null`. It also pins `max_chunk_chars=800` and `crossfade_ms=50`, the verified provider defaults. Explicitly empty effects prevent profile default effects from being inherited. There is no LLM rewrite or browser-speech fallback.

The provider accepts 1–50,000 characters. The paragraph endpoint defaults to a **5,000-character local cap**; the effective cap is the minimum of configuration, running schema limit, and 50,000. Over-limit paragraph requests are rejected. Chapter jobs now split stored blocks deterministically into bounded spans (800 characters by default) and use the same verified generation contract. Voicebox itself may internally split text over 800 characters.

Model name mappings are explicit and sourced from the registry:

| Model names | Engine | Model size |
| --- | --- | --- |
| `qwen-tts-0.6B`, `qwen-tts-1.7B` | `qwen` | `0.6B`, `1.7B` |
| `qwen-custom-voice-0.6B`, `qwen-custom-voice-1.7B` | `qwen_custom_voice` | `0.6B`, `1.7B` |
| `luxtts` | `luxtts` | null |
| `chatterbox-tts` | `chatterbox` | null |
| `chatterbox-turbo` | `chatterbox_turbo` | null |
| `tada-1b`, `tada-3b-ml` | `tada` | `1B`, `3B` |
| `kokoro` | `kokoro` | null |

Preset profiles must match their preset engine. Cloned profiles require reference samples and a cloning engine. Designed/import-only profiles have no supported choices in this milestone. Language comes from the profile; engine-specific language limitations may still cause a provider failure.

Generation is refused unless the selected model is reported downloaded and not currently downloading, checked again immediately before submission. The reader never installs models or requests a download. Upstream `/generate` can load/download absent assets, so configure and test the chosen voice in Voicebox first and do not remove its model files during submission. The upstream queue has no atomic `no_download` submission flag; readiness cannot prevent external changes between the check and execution.

## Verification boundary

Mock tests cover exact request fields, connection errors, stale schema rejection, limits, profiles/models, generation failures, ambiguous submissions, identity validation, cache hits, explicit regeneration, concurrent duplicate requests, audio failure/retrieval retry, restart recovery, and WAV range responses (206/416). Existing EPUB tests remain in the suite. Real speech output and browser decoding/seeking need the live manual verification in README; synthetic WAV and HTTP range tests do not replace that check.
