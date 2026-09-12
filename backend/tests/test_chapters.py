from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
import time
from uuid import uuid4
import wave

import httpx
import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.chapter_audio import assemble_wav, split_block
from app.main import create_app
from app.models import ChapterJob, Narration
from epub_fixtures import make_epub
from voicebox_fixtures import VoiceboxMock, wav_audio


@pytest.fixture
def chapter_client(configuration):
    configuration.voicebox_poll_seconds = .01
    mock = VoiceboxMock()
    with TestClient(create_app(configuration, voicebox_transport=httpx.MockTransport(mock.handle))) as client:
        yield client, mock


def book(client):
    return client.post('/api/books', files={'file': ('test.epub', make_epub())}).json()


def create(client, section, **kwargs):
    return client.post('/api/chapters', json={'section_id': section, 'profile_id': 'voice-one', 'model_name': 'kokoro', **kwargs})


def wait(client, job, state='ready'):
    deadline = time.monotonic() + 6
    while time.monotonic() < deadline:
        result = client.get(f'/api/chapters/{job["id"]}').json()
        if result['state'] == state:
            return result
        time.sleep(.02)
    raise AssertionError(result)


def test_chunk_spans_preserve_exact_words_and_ids():
    block_id = str(uuid4())
    text = 'A sentence ends here! “And another?” Next, a much longer sentence that needs a word boundary. '
    chunks = split_block(block_id, text, 30)
    assert ''.join(chunk['text'] for chunk in chunks) == text
    assert all(len(chunk['text']) <= 30 for chunk in chunks)
    assert chunks == split_block(block_id, text, 30)
    for chunk in chunks:
        assert text[chunk['start_offset']:chunk['end_offset']] == chunk['text']
    with pytest.raises(ValueError, match='word'):
        split_block(block_id, 'x' * 31, 30)


def test_chapter_order_paragraph_cache_duplicates_and_seek(chapter_client):
    client, mock = chapter_client
    uploaded = book(client)
    section_id = uploaded['sections'][0]['id']
    blocks = client.get(f'/api/books/{uploaded["id"]}/sections/{section_id}').json()['blocks']
    paragraph = client.post('/api/narrations', json={'paragraph_id': blocks[1]['id'], 'profile_id': 'voice-one', 'model_name': 'kokoro'}).json()
    from test_narration import wait_for
    wait_for(client, paragraph)
    with ThreadPoolExecutor(max_workers=4) as pool:
        jobs = list(pool.map(lambda _: create(client, section_id).json(), range(4)))
    assert len({job['id'] for job in jobs}) == 1
    result = wait(client, jobs[0])
    assert result['completed'] == result['total'] == 3
    assert [c['block_id'] for c in result['chunks']] == [b['id'] for b in blocks]
    assert [c['position'] for c in result['chunks']] == [0, 1, 2]
    assert len(mock.posts) == 3  # Existing paragraph reused; only heading and last paragraph submitted.
    assert create(client, section_id).json()['id'] == result['id']
    response = client.get(result['audio_url'])
    with wave.open(BytesIO(response.content), 'rb') as audio:
        assert audio.getnframes() == 3 * 2400
    assert client.get(result['audio_url'], headers={'Range': 'bytes=0-15'}).status_code == 206
    assert [c['start_seconds'] for c in result['chunks']] == pytest.approx([0, .1, .2])


def test_cancel_remaining_and_resume_retains_submitted(chapter_client):
    client, mock = chapter_client
    mock.history_state = 'generating'
    job = create(client, book(client)['sections'][0]['id']).json()
    wait(client, job, 'generating')
    deadline = time.monotonic() + 3
    while not mock.posts and time.monotonic() < deadline: time.sleep(.01)
    assert len(mock.posts) == 1
    assert client.post(f'/api/chapters/{job["id"]}/cancel').json()['state'] == 'cancelled'
    mock.history_state = 'completed'
    time.sleep(.15)
    assert len(mock.posts) == 1
    assert client.post(f'/api/chapters/{job["id"]}/retry', json={}).status_code == 200
    result = wait(client, job)
    assert result['completed'] == 3 and len(mock.posts) == 3


def test_partial_failure_retry_keeps_completed(chapter_client):
    client, mock = chapter_client
    original = mock.handle
    def handle(request):
        response = original(request)
        if request.url.path == '/history/generation-2':
            return httpx.Response(200, json={**response.json(), 'status': 'failed', 'error': 'synthetic failure'})
        return response
    client.app.state.voicebox.client._transport = httpx.MockTransport(handle)
    job = create(client, book(client)['sections'][0]['id']).json()
    failed = wait(client, job, 'failed')
    assert failed['completed'] == 1
    assert client.post(f'/api/chapters/{job["id"]}/retry', json={}).status_code == 200
    ready = wait(client, job)
    assert ready['completed'] == 3 and len(mock.posts) == 4
    assert ready['chunks'][0]['provider_job_id'] == failed['chunks'][0]['provider_job_id']


def test_unknown_submission_needs_explicit_confirmation(chapter_client):
    client, mock = chapter_client
    mock.submit_timeout = True
    job = create(client, book(client)['sections'][0]['id']).json()
    wait(client, job, 'failed')
    assert client.post(f'/api/chapters/{job["id"]}/retry', json={}).status_code == 409
    assert len(mock.posts) == 1
    mock.submit_timeout = False
    assert client.post(f'/api/chapters/{job["id"]}/retry', json={'confirm_unknown': True}).status_code == 200
    wait(client, job)


def test_assembly_failure_retry_and_previous_version(chapter_client, monkeypatch):
    client, mock = chapter_client
    section = book(client)['sections'][0]['id']
    ready = wait(client, create(client, section).json())
    import app.chapters as module
    real_assemble = module.assemble_wav
    def fail(*args): raise ValueError('synthetic assembly failure')
    monkeypatch.setattr(module, 'assemble_wav', fail)
    replacement = create(client, section, replace=True).json()
    failed = wait(client, replacement, 'failed')
    assert failed['completed'] == failed['total'] == 3
    assert client.get(ready['audio_url']).status_code == 200
    submissions = len(mock.posts)
    monkeypatch.setattr(module, 'assemble_wav', real_assemble)
    mock.offline = True
    client.post(f'/api/chapters/{replacement["id"]}/retry', json={})
    new = wait(client, replacement)
    assert new['audio_url'] != ready['audio_url']
    assert len(mock.posts) == submissions
    assert client.get(new['audio_url']).status_code == 200
    assert client.get(ready['audio_url']).status_code == 200


def test_assembly_reads_frames_and_rejects_mismatch(tmp_path):
    paths = []
    for i in [1, 2]:
        path = tmp_path / f'{i}.wav'
        with wave.open(str(path), 'wb') as audio:
            audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(24000)
            audio.writeframes(bytes([i, 0]) * 100)
        paths.append(path)
    target = tmp_path / 'chapter.wav'
    assemble_wav(paths, target, 10000)
    with wave.open(str(target), 'rb') as audio:
        assert audio.readframes(200) == bytes([1, 0]) * 100 + bytes([2, 0]) * 100
    old = target.read_bytes()
    with wave.open(str(paths[1]), 'wb') as audio:
        audio.setnchannels(1); audio.setsampwidth(2); audio.setframerate(48000); audio.writeframes(b'\0\0' * 100)
    with pytest.raises(ValueError, match='formats differ'): assemble_wav(paths, target, 10000)
    assert target.read_bytes() == old
    assert not target.with_suffix('.part').exists()


def test_restart_and_progress_with_voicebox_offline(configuration):
    configuration.voicebox_poll_seconds = .01
    mock = VoiceboxMock()
    mock.history_state = 'generating'
    def app(): return create_app(configuration, voicebox_transport=httpx.MockTransport(mock.handle))
    with TestClient(app()) as client:
        uploaded = book(client)
        job = create(client, uploaded['sections'][0]['id']).json()
        wait(client, job, 'generating')
        deadline = time.monotonic() + 3
        while not mock.posts and time.monotonic() < deadline: time.sleep(.01)
        time.sleep(.03)
    mock.history_state = 'completed'
    with TestClient(app()) as client:
        ready = wait(client, job)
        assert len(mock.posts) == 3
        path = f'/api/books/{uploaded["id"]}/listening-progress'
        data = {'version_id': ready['id'], 'offset': .15, 'speed': 1.5, 'updated_at_ms': 20}
        assert client.put(path, json=data).status_code == 200
        client.put(path, json={**data, 'offset': 0, 'updated_at_ms': 10})
        assert client.get(path).json()['offset'] == .15
        assert client.put(f'/api/books/{uuid4()}/listening-progress', json=data).status_code == 400
    mock.offline = True
    with TestClient(app()) as client:
        assert client.get(ready['audio_url']).status_code == 200
        assert client.get(path).json()['version_id'] == ready['id']
        assert client.get(path).json()['speed'] == 1.5


def test_profile_changes_do_not_mix_voices_within_job(chapter_client):
    client, mock = chapter_client
    mock.history_state = 'generating'
    job = create(client, book(client)['sections'][0]['id']).json()
    deadline = time.monotonic() + 3
    while not mock.posts and time.monotonic() < deadline: time.sleep(.01)
    mock.profiles[0]['updated_at'] = '2026-09-12T01:00:00Z'
    mock.history_state = 'completed'
    failed = wait(client, job, 'failed')
    assert failed['completed'] == 1
    assert len(mock.posts) == 1
