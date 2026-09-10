import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


@pytest.fixture
def configuration(tmp_path):
    return Settings(_env_file=None, data_dir=tmp_path / "data")


@pytest.fixture
def client(configuration):
    with TestClient(create_app(configuration)) as test_client:
        yield test_client
