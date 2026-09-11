"""Environment settings shared by backend components."""

from pathlib import Path

from pydantic import AnyHttpUrl, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    voicebox_base_url: AnyHttpUrl = "http://127.0.0.1:17493"
    voicebox_timeout_seconds: float = Field(default=10, gt=0, le=120)
    voicebox_poll_seconds: float = Field(default=2, gt=0, le=60)
    max_narration_chars: int = Field(default=5000, gt=0, le=50000)
    max_audio_bytes: int = Field(default=100 * 1024 * 1024, gt=0)
    data_dir: Path = ROOT_DIR / "backend" / "data"
    max_upload_bytes: int = Field(default=20 * 1024 * 1024, gt=0)
    max_archive_bytes: int = Field(default=100 * 1024 * 1024, gt=0)
    max_archive_entry_bytes: int = Field(default=10 * 1024 * 1024, gt=0)
    max_archive_entries: int = Field(default=2000, gt=0)

    @field_validator("data_dir", mode="after")
    @classmethod
    def resolve_data_dir(cls, value: Path) -> Path:
        # Relative configuration is relative to the repository, never the shell.
        return (ROOT_DIR / value.expanduser()).resolve()

    @property
    def books_dir(self) -> Path:
        return self.data_dir / "books"

    @property
    def database_path(self) -> Path:
        return self.data_dir / "reader.sqlite3"

    @property
    def audio_dir(self) -> Path:
        return self.data_dir / "audio"


settings = Settings()
