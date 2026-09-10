"""SQLite setup. Each operation uses its own short-lived SQLAlchemy session."""

from uuid import UUID

from sqlalchemy import URL, create_engine, event, select
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session

from app.config import Settings
from app.models import Base, Book


def create_database(settings: Settings) -> Engine:
    settings.books_dir.mkdir(parents=True, exist_ok=True)
    engine = create_engine(
        URL.create("sqlite", database=str(settings.database_path)),
        connect_args={"check_same_thread": False, "timeout": 10},
    )

    @event.listens_for(engine, "connect")
    def enable_foreign_keys(connection, _record):
        connection.execute("PRAGMA foreign_keys=ON")

    Base.metadata.create_all(engine)
    # A process killed between file placement and commit may leave an orphan.
    # This local app runs one backend worker; only our generated names are owned.
    with Session(engine) as session:
        committed = set(session.scalars(select(Book.id)))
    for path in settings.books_dir.iterdir():
        if path.suffix not in {".upload", ".epub"} or not path.is_file():
            continue
        try:
            generated_name = str(UUID(path.stem)) == path.stem
        except ValueError:
            continue
        if generated_name and (path.suffix == ".upload" or path.stem not in committed):
            path.unlink()
    return engine
