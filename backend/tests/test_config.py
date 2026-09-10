from app.config import Settings


def test_voicebox_default(monkeypatch):
    monkeypatch.delenv("VOICEBOX_BASE_URL", raising=False)
    assert str(Settings(_env_file=None).voicebox_base_url).rstrip("/") == (
        "http://127.0.0.1:17493"
    )


def test_environment_overrides_dotenv(tmp_path, monkeypatch):
    env_file = tmp_path / ".env"
    env_file.write_text("VOICEBOX_BASE_URL=http://localhost:18000\n")
    monkeypatch.setenv("VOICEBOX_BASE_URL", "http://localhost:19000")
    assert str(Settings(_env_file=env_file).voicebox_base_url).rstrip("/") == (
        "http://localhost:19000"
    )
