from app.config import Settings
from app.config import ROOT_DIR


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


def test_paths_are_independent_of_working_directory(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    settings = Settings(_env_file=None, data_dir="backend/data")
    assert settings.books_dir == ROOT_DIR / "backend/data/books"
    assert settings.database_path == ROOT_DIR / "backend/data/reader.sqlite3"
