"""Environment settings shared by backend components."""

from pathlib import Path

from pydantic import AnyHttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_DIR = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=ROOT_DIR / ".env", env_file_encoding="utf-8", extra="ignore"
    )

    # Configuration only until the verified Voicebox adapter is implemented.
    voicebox_base_url: AnyHttpUrl = "http://127.0.0.1:17493"


settings = Settings()
