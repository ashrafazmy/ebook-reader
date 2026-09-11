"""HTTP-only adapter for Voicebox 0.5.0, revision 51f49dea1983.

Contract provenance and compatibility checks: docs/voicebox-contract.md.
No model libraries or desktop playback endpoints are used here.
"""

import asyncio
from pathlib import Path
from urllib.parse import quote

import anyio
import httpx
from pydantic import BaseModel, ValidationError

from app.config import Settings

# Verified in Voicebox backend/backends/__init__.py, not inferred from names.
MODEL_SETTINGS = {
    "qwen-tts-1.7B": ("qwen", "1.7B"),
    "qwen-tts-0.6B": ("qwen", "0.6B"),
    "qwen-custom-voice-1.7B": ("qwen_custom_voice", "1.7B"),
    "qwen-custom-voice-0.6B": ("qwen_custom_voice", "0.6B"),
    "luxtts": ("luxtts", None),
    "chatterbox-tts": ("chatterbox", None),
    "chatterbox-turbo": ("chatterbox_turbo", None),
    "tada-1b": ("tada", "1B"),
    "tada-3b-ml": ("tada", "3B"),
    "kokoro": ("kokoro", None),
}
CLONING_ENGINES = {"qwen", "luxtts", "chatterbox", "chatterbox_turbo", "tada"}


class ProviderError(Exception):
    def __init__(self, message: str, kind: str = "provider", ambiguous: bool = False):
        super().__init__(message)
        self.kind = "ambiguous" if ambiguous else kind


class Profile(BaseModel):
    id: str
    name: str
    language: str
    voice_type: str = "cloned"
    preset_engine: str | None = None
    preset_voice_id: str | None = None
    default_engine: str | None = None
    sample_count: int = 0
    updated_at: str


class Model(BaseModel):
    model_name: str
    display_name: str
    hf_repo_id: str | None = None
    downloaded: bool
    downloading: bool = False
    loaded: bool = False


class Generation(BaseModel):
    id: str
    profile_id: str
    text: str
    language: str
    engine: str
    model_size: str | None = None
    status: str
    error: str | None = None


def compatible(profile: Profile, engine: str) -> bool:
    if profile.voice_type == "preset":
        return profile.preset_engine == engine and bool(profile.preset_voice_id)
    return profile.voice_type == "cloned" and profile.sample_count > 0 and engine in CLONING_ENGINES


class VoiceboxProvider:
    def __init__(self, settings: Settings, client: httpx.AsyncClient):
        self.settings = settings
        self.client = client
        self.base_url = str(settings.voicebox_base_url).rstrip("/")

    async def request(self, method: str, path: str, **kwargs) -> dict | list:
        submission = method == "POST"
        try:
            response = await self.client.request(method, self.base_url + path, **kwargs)
        except httpx.RequestError as exc:
            # Even a timeout may follow a committed provider enqueue. Never replay POST.
            raise ProviderError(
                "Voicebox submission outcome is unknown. Check Voicebox history before explicitly regenerating."
                if submission else "Voicebox is unavailable or timed out. Start it and retry.",
                "unavailable", ambiguous=submission,
            ) from exc
        if not response.is_success:
            try:
                detail = response.json().get("detail", response.reason_phrase)
            except (ValueError, AttributeError):
                detail = response.reason_phrase
            raise ProviderError(
                f"Voicebox returned {response.status_code}: {str(detail)[:500]}",
                "not_found" if response.status_code == 404 else "provider",
                ambiguous=submission and response.status_code >= 500,
            )
        try:
            return response.json()
        except ValueError as exc:
            raise ProviderError("Voicebox returned invalid JSON.", "contract", ambiguous=submission) from exc

    async def discovery(self) -> dict:
        health, schema, profiles, models = await asyncio.gather(
            self.request("GET", "/health"), self.request("GET", "/openapi.json"),
            self.request("GET", "/profiles"), self.request("GET", "/models/status"),
        )
        try:
            if health["status"] != "healthy":
                raise ValueError("unhealthy")
            paths = schema["paths"]
            for path, method in [("/generate", "post"), ("/history/{generation_id}", "get"), ("/audio/{generation_id}", "get")]:
                if method not in paths[path]:
                    raise ValueError("missing route")
            properties = schema["components"]["schemas"]["GenerationRequest"]["properties"]
            required = {"profile_id", "text", "language", "engine", "model_size", "personality", "effects_chain", "normalize", "seed", "instruct", "max_chunk_chars", "crossfade_ms"}
            if not required.issubset(properties):
                raise ValueError("older generation contract")
            limit = properties["text"]["maxLength"]
            if not isinstance(limit, int) or limit <= 0:
                raise ValueError("missing text limit")
            return {
                "version": schema["info"]["version"],
                "backend_type": health.get("backend_type"),
                "text_limit": min(limit, 50000, self.settings.max_narration_chars),
                "provider_text_limit": limit,
                "profiles": [Profile.model_validate(profile) for profile in profiles],
                "models": [Model.model_validate(model) for model in models["models"] if model["model_name"] in MODEL_SETTINGS],
            }
        except (KeyError, TypeError, ValueError, ValidationError) as exc:
            raise ProviderError("Voicebox API is incompatible with the verified v0.5.0 generation contract. Update Voicebox and refresh.", "contract") from exc

    async def prepare(self, profile_id: str, model_name: str, text: str) -> tuple[dict, dict, Profile]:
        info = await self.discovery()
        profile = next((p for p in info["profiles"] if p.id == profile_id), None)
        model = next((m for m in info["models"] if m.model_name == model_name), None)
        if profile is None:
            raise ProviderError("Voice profile no longer exists. Refresh the voices.", "profile")
        if model is None or not model.downloaded or model.downloading:
            raise ProviderError("Download and configure this model in Voicebox first. The reader will not download models.", "model")
        engine, size = MODEL_SETTINGS[model_name]
        if not compatible(profile, engine):
            raise ProviderError("This profile cannot use the selected model, or has no reference samples. Configure it in Voicebox.", "profile")
        if not text.strip() or len(text) > info["text_limit"]:
            raise ProviderError(f"Selected paragraph has {len(text)} characters; this reader allows {info['text_limit']} per paragraph (Voicebox advertises {info['provider_text_limit']}). Paragraph splitting is deferred to milestone 4.", "length")
        payload = {
            "profile_id": profile.id, "text": text, "language": profile.language,
            "engine": engine, "model_size": size, "personality": False,
            "seed": None, "instruct": None, "normalize": True, "effects_chain": [],
            "max_chunk_chars": 800, "crossfade_ms": 50,
        }
        identity = {
            "provider": "voicebox", "base_url": self.base_url, "version": info["version"],
            "backend_type": info["backend_type"], "model_name": model_name,
            "hf_repo_id": model.hf_repo_id, "profile": profile.model_dump(),
        }
        return payload, identity, profile

    async def submit(self, payload: dict) -> Generation:
        value = await self.request("POST", "/generate", json=payload)
        try:
            return Generation.model_validate(value)
        except ValidationError as exc:
            raise ProviderError("Voicebox may have accepted the request but returned an incompatible generation response. Check its history before regenerating.", "contract", ambiguous=True) from exc

    async def status(self, job_id: str) -> Generation:
        value = await self.request("GET", "/history/" + quote(job_id, safe=""))
        try:
            return Generation.model_validate(value)
        except ValidationError as exc:
            raise ProviderError("Voicebox returned an incompatible history response.", "contract") from exc

    async def download(self, job_id: str, destination: Path) -> None:
        temporary = destination.with_suffix(".part")
        try:
            async with self.client.stream("GET", self.base_url + "/audio/" + quote(job_id, safe="")) as response:
                if response.status_code != 200:
                    raise ProviderError(f"Audio download failed (Voicebox HTTP {response.status_code}). Retry audio retrieval.", "audio")
                size = 0
                prefix = bytearray()
                async with await anyio.open_file(temporary, "wb") as output:
                    async for chunk in response.aiter_bytes():
                        size += len(chunk)
                        if size > self.settings.max_audio_bytes:
                            raise ProviderError("Generated audio exceeds the configured audio cache limit.", "audio")
                        if len(prefix) < 12:
                            prefix.extend(chunk[:12 - len(prefix)])
                        await output.write(chunk)
                # /generate writes WAV; reject HTML errors and other unexpected formats.
                if size <= 44 or prefix[:4] != b"RIFF" or prefix[8:12] != b"WAVE":
                    raise ProviderError("Voicebox returned invalid or unsupported WAV audio.", "audio")
                await anyio.to_thread.run_sync(temporary.replace, destination)
        except (httpx.RequestError, OSError) as exc:
            raise ProviderError("Could not retrieve or save Voicebox audio. Retry audio retrieval.", "audio") from exc
        finally:
            temporary.unlink(missing_ok=True)
