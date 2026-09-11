"""Minimal mock responses derived from Voicebox v0.5.0 source, not live captures."""

import io
import json
import wave

import httpx


def wav_audio() -> bytes:
    result = io.BytesIO()
    with wave.open(result, "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(24000)
        output.writeframes(b"\0\0" * 2400)
    return result.getvalue()


def current_schema() -> dict:
    return {
        "info": {"title": "Voicebox API", "version": "0.5.0"},
        "paths": {"/generate": {"post": {}}, "/history/{generation_id}": {"get": {}}, "/audio/{generation_id}": {"get": {}}},
        "components": {"schemas": {"GenerationRequest": {"properties": {
            "profile_id": {"type": "string"}, "text": {"type": "string", "minLength": 1, "maxLength": 50000},
            "language": {"type": "string"}, "engine": {}, "model_size": {}, "seed": {}, "instruct": {},
            "personality": {"type": "boolean", "default": False}, "effects_chain": {}, "normalize": {},
            "max_chunk_chars": {}, "crossfade_ms": {},
        }}}},
    }


class VoiceboxMock:
    def __init__(self):
        self.schema = current_schema()
        self.profiles = [
            {"id": "voice-one", "name": "Test reader", "language": "en", "voice_type": "preset",
             "preset_engine": "kokoro", "preset_voice_id": "af_heart", "sample_count": 0,
             "updated_at": "2026-07-27T00:00:00Z"},
            {"id": "voice-two", "name": "Second reader", "language": "en", "voice_type": "cloned",
             "sample_count": 1, "updated_at": "2026-07-27T00:00:00Z"},
        ]
        self.models = [
            {"model_name": "kokoro", "display_name": "Kokoro 82M", "hf_repo_id": "hexgrad/Kokoro-82M", "downloaded": True, "loaded": True},
            {"model_name": "qwen-tts-0.6B", "display_name": "Qwen TTS 0.6B", "hf_repo_id": "Qwen/Qwen3-TTS-12Hz-0.6B-Base", "downloaded": True},
        ]
        self.posts: list[dict] = []
        self.generations: dict[str, dict] = {}
        self.offline = False
        self.submit_timeout = False
        self.submit_code = 200
        self.history_state = "completed"
        self.audio_code = 200
        self.audio = wav_audio()
        self.mismatch = False

    def handle(self, request: httpx.Request) -> httpx.Response:
        if self.offline:
            raise httpx.ConnectError("mock offline", request=request)
        path = request.url.path
        if path == "/health":
            return httpx.Response(200, json={"status": "healthy", "backend_type": "pytorch"})
        if path == "/openapi.json":
            return httpx.Response(200, json=self.schema)
        if path == "/profiles":
            return httpx.Response(200, json=self.profiles)
        if path == "/models/status":
            return httpx.Response(200, json={"models": self.models})
        if path == "/generate":
            assert request.method == "POST"
            payload = json.loads(request.content)
            self.posts.append(payload)
            job_id = f"generation-{len(self.posts)}"
            result = {**payload, "id": job_id, "status": "generating", "audio_path": "", "created_at": "2026-07-27T00:00:00Z"}
            self.generations[job_id] = result
            if self.submit_timeout:
                raise httpx.ReadTimeout("mock timeout after acceptance", request=request)
            if self.submit_code != 200:
                return httpx.Response(self.submit_code, json={"detail": "mock submission failure"})
            return httpx.Response(200, json=result)
        if path.startswith("/history/"):
            result = self.generations.get(path.rsplit("/", 1)[1])
            if not result:
                return httpx.Response(404, json={"detail": "Generation not found"})
            return httpx.Response(200, json={**result, "status": self.history_state,
                "profile_id": "wrong-voice" if self.mismatch else result["profile_id"],
                "error": "mock inference failure" if self.history_state == "failed" else None})
        if path.startswith("/audio/"):
            return httpx.Response(self.audio_code, content=self.audio, headers={"content-type": "audio/wav"})
        raise AssertionError(f"Unverified Voicebox endpoint used: {request.method} {path}")
