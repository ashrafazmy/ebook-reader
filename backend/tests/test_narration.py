import asyncio
from concurrent.futures import ThreadPoolExecutor
import time

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.main import create_app
from app.models import Narration
from app.voicebox import ProviderError, VoiceboxProvider
from epub_fixtures import make_epub
from voicebox_fixtures import VoiceboxMock


def paragraph(client):
    book = client.post("/api/books", files={"file": ("test.epub", make_epub())}).json()
    section = client.get(f'/api/books/{book["id"]}/sections/{book["sections"][0]["id"]}').json()
    return section["blocks"][1]


def submit(client, block, **kwargs):
    return client.post("/api/narrations", json={"paragraph_id": block["id"], "profile_id": "voice-one", "model_name": "kokoro", **kwargs})


def wait_for(client, job, state="completed"):
    end = time.monotonic() + 4
    while time.monotonic() < end:
        result = client.get(f'/api/narrations/{job["id"]}').json()
        if result["state"] == state:
            return result
        time.sleep(.02)
    raise AssertionError(result)


@pytest.fixture
def narration_client(configuration):
    configuration.voicebox_poll_seconds = .02
    mock = VoiceboxMock()
    with TestClient(create_app(configuration, voicebox_transport=httpx.MockTransport(mock.handle))) as client:
        yield client, mock


def test_contract_submission_cache_audio_and_seek(narration_client):
    client, mock = narration_client
    assert client.get("/api/voicebox/status").json()["connected"]
    voices = client.get("/api/voicebox/profiles").json()
    assert voices["profiles"][0]["models"][0]["id"] == "kokoro"
    block = paragraph(client)
    response = submit(client, block)
    assert response.status_code == 202
    finished = wait_for(client, response.json())
    assert finished["paragraph_id"] == block["id"]
    assert finished["profile_id"] == "voice-one"
    assert mock.posts == [{
        "profile_id": "voice-one", "text": block["text"], "language": "en", "engine": "kokoro", "model_size": None,
        "seed": None, "instruct": None, "personality": False, "normalize": True, "effects_chain": [],
        "max_chunk_chars": 800, "crossfade_ms": 50,
    }]
    cached = submit(client, block).json()
    assert cached["id"] == finished["id"] and cached["reused"]
    assert len(mock.posts) == 1
    audio = client.get(finished["audio_url"])
    assert audio.content == mock.audio
    assert audio.headers["content-type"] == "audio/wav"
    partial = client.get(finished["audio_url"], headers={"Range": "bytes=0-15"})
    assert partial.status_code == 206
    assert partial.content == mock.audio[:16]
    assert partial.headers["content-range"].startswith("bytes 0-15/")
    assert client.get(finished["audio_url"], headers={"Range": "bytes=999999-"}).status_code == 416
    regenerated = wait_for(client, submit(client, block, regenerate=True).json())
    assert regenerated["id"] != finished["id"]
    assert regenerated["audio_url"] != finished["audio_url"]
    assert len(mock.posts) == 2


def test_simultaneous_duplicate_requests(narration_client):
    client, mock = narration_client
    mock.history_state = "generating"
    block = paragraph(client)
    with ThreadPoolExecutor(max_workers=4) as pool:
        results = list(pool.map(lambda _: submit(client, block).json(), range(4)))
    assert len({result["id"] for result in results}) == 1
    wait_for(client, results[0], "running")
    assert len(mock.posts) == 1
    assert submit(client, block, regenerate=True).json()["id"] == results[0]["id"]
    assert client.get("/api/health").json() == {"status": "ok"}


def test_unavailable_does_not_block_reading(narration_client):
    client, mock = narration_client
    mock.offline = True
    assert not client.get("/api/voicebox/status").json()["connected"]
    assert client.get("/api/voicebox/profiles").status_code == 503
    block = paragraph(client)
    assert submit(client, block).status_code == 503
    assert client.get("/api/books").status_code == 200
    assert mock.posts == []


@pytest.mark.parametrize("fault", ["missing_model", "missing_profile", "too_long", "old_schema", "wrong_engine"])
def test_preflight_errors(narration_client, fault):
    client, mock = narration_client
    block = paragraph(client)
    kwargs = {}
    if fault == "missing_model": mock.models[0]["downloaded"] = False
    if fault == "missing_profile": mock.profiles = []
    if fault == "too_long": mock.schema["components"]["schemas"]["GenerationRequest"]["properties"]["text"]["maxLength"] = 10
    if fault == "old_schema": del mock.schema["components"]["schemas"]["GenerationRequest"]["properties"]["personality"]
    if fault == "wrong_engine": kwargs["model_name"] = "qwen-tts-0.6B"
    response = submit(client, block, **kwargs)
    assert response.status_code in {400, 503}
    assert mock.posts == []


def test_generation_failure_requires_explicit_regenerate(narration_client):
    client, mock = narration_client
    mock.history_state = "failed"
    block = paragraph(client)
    failed = wait_for(client, submit(client, block).json(), "failed")
    assert failed["error_kind"] == "generation"
    assert "mock inference failure" in failed["error"]
    assert submit(client, block).json()["id"] == failed["id"]
    assert len(mock.posts) == 1


@pytest.mark.parametrize("failure", ["timeout", "server_error"])
def test_ambiguous_submission_is_not_retried(narration_client, failure):
    client, mock = narration_client
    mock.submit_timeout = failure == "timeout"
    mock.submit_code = 500 if failure == "server_error" else 200
    block = paragraph(client)
    failed = wait_for(client, submit(client, block).json(), "failed")
    assert failed["error_kind"] == "ambiguous"
    assert submit(client, block).json()["id"] == failed["id"]
    time.sleep(.08)
    assert len(mock.posts) == 1


def test_audio_failure_retries_download_only(narration_client):
    client, mock = narration_client
    mock.audio_code = 500
    block = paragraph(client)
    failed = wait_for(client, submit(client, block).json(), "failed")
    assert failed["error_kind"] == "audio"
    mock.audio_code = 200
    response = client.post(f'/api/narrations/{failed["id"]}/retry-audio')
    assert response.status_code == 200
    wait_for(client, response.json())
    assert len(mock.posts) == 1


def test_wrong_voice_never_attaches_audio(narration_client):
    client, mock = narration_client
    mock.mismatch = True
    failed = wait_for(client, submit(client, paragraph(client)).json(), "failed")
    assert failed["error_kind"] == "contract"
    assert failed["audio_url"] is None


def test_voice_and_profile_change_invalidate_cache(narration_client):
    client, mock = narration_client
    block = paragraph(client)
    first = wait_for(client, submit(client, block).json())
    second = wait_for(client, submit(client, block, profile_id="voice-two", model_name="qwen-tts-0.6B").json())
    assert first["id"] != second["id"]
    assert second["profile_id"] == "voice-two"
    mock.profiles[0]["updated_at"] = "2026-09-10T00:00:00Z"
    changed = wait_for(client, submit(client, block).json())
    assert changed["id"] not in {first["id"], second["id"]}
    assert len(mock.posts) == 3


def test_restart_reconciles_provider_job_and_cached_audio(configuration):
    configuration.voicebox_poll_seconds = .02
    mock = VoiceboxMock()
    mock.history_state = "generating"
    def app():
        return create_app(configuration, voicebox_transport=httpx.MockTransport(mock.handle))
    with TestClient(app()) as client:
        block = paragraph(client)
        job = wait_for(client, submit(client, block).json(), "running")
        assert job["provider_job_id"]
    mock.history_state = "completed"
    with TestClient(app()) as client:
        finished = wait_for(client, job)
        assert len(mock.posts) == 1
    mock.offline = True
    with TestClient(app()) as client:
        assert client.get(finished["audio_url"]).content == mock.audio
        assert client.get(f'/api/narrations?paragraph_id={block["id"]}').json()[0]["id"] == job["id"]


def test_restart_with_unrecorded_provider_id_never_resubmits(configuration):
    configuration.voicebox_poll_seconds = .02
    mock = VoiceboxMock()
    mock.history_state = "generating"
    def app():
        return create_app(configuration, voicebox_transport=httpx.MockTransport(mock.handle))
    with TestClient(app()) as client:
        block = paragraph(client)
        job = wait_for(client, submit(client, block).json(), "running")
    with Session(client.app.state.engine) as session, session.begin():
        row = session.get(Narration, job["id"])
        row.provider_job_id = None
    with TestClient(app()) as client:
        failed = wait_for(client, job, "failed")
        assert failed["error_kind"] == "ambiguous"
        assert submit(client, block).json()["id"] == job["id"]
        assert len(mock.posts) == 1


def test_audio_validation_and_limit(configuration, tmp_path):
    async def run():
        mock = VoiceboxMock()
        async with httpx.AsyncClient(transport=httpx.MockTransport(mock.handle)) as client:
            provider = VoiceboxProvider(configuration, client)
            target = tmp_path / "audio.wav"
            mock.audio = b"not audio" * 30
            with pytest.raises(ProviderError): await provider.download("generation-1", target)
            assert not target.exists() and not target.with_suffix(".part").exists()
            configuration.max_audio_bytes = 10
            with pytest.raises(ProviderError): await provider.download("generation-1", target)
            assert not target.exists() and not target.with_suffix(".part").exists()
    asyncio.run(run())


def test_reconcile_known_failed_job_never_submits_again(narration_client):
    client, mock = narration_client
    mock.history_state = "failed"
    block = paragraph(client)
    failed = wait_for(client, submit(client, block).json(), "failed")
    mock.history_state = "completed"
    response = client.post(f'/api/narrations/{failed["id"]}/reconcile')
    assert response.status_code == 200
    wait_for(client, response.json())
    assert len(mock.posts) == 1


def test_two_paragraphs_keep_distinct_associations(narration_client):
    client, mock = narration_client
    first_block = paragraph(client)
    second_block = paragraph(client)
    first = wait_for(client, submit(client, first_block).json())
    second = wait_for(client, submit(client, second_block).json())
    assert first["paragraph_id"] != second["paragraph_id"]
    assert first["audio_url"] != second["audio_url"]
    history = client.get(f'/api/narrations?paragraph_id={second_block["id"]}').json()
    assert [item["id"] for item in history] == [second["id"]]
    # Browser-supplied replacement text is forbidden; only stored text is used.
    assert submit(client, first_block, text="rewritten text").status_code == 422


def test_polling_recovers_after_voicebox_outage(narration_client):
    client, mock = narration_client
    mock.history_state = "generating"
    block = paragraph(client)
    job = wait_for(client, submit(client, block).json(), "running")
    mock.offline = True
    end = time.monotonic() + 3
    while time.monotonic() < end:
        result = client.get(f'/api/narrations/{job["id"]}').json()
        if result["error_kind"] == "unavailable": break
        time.sleep(.02)
    assert result["state"] == "running" and result["error_kind"] == "unavailable"
    assert submit(client, block).json()["id"] == job["id"]
    mock.offline = False
    mock.history_state = "completed"
    wait_for(client, job)
    assert len(mock.posts) == 1
