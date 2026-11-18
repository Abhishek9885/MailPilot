import asyncio
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path

import psycopg
from psycopg import AsyncConnection

from mailpilot_ai.config import get_settings
from mailpilot_ai.database import psycopg_connection_url
from mailpilot_ai.vector_store.errors import VectorStoreError

_MIGRATION_DIRECTORY = Path(__file__).parent / "migrations"
_MIGRATION_FILENAME = re.compile(r"^[0-9]{4}_[a-z0-9_]+\.sql$")
_MIGRATION_LOCK_KEY = 4_628_032_056_861_080_641


@dataclass(frozen=True)
class AppliedMigration:
    migration_id: str
    checksum: str


async def apply_ai_migrations(
    database_url: str,
    *,
    migrations_directory: Path = _MIGRATION_DIRECTORY,
) -> tuple[AppliedMigration, ...]:
    """Apply immutable AI-schema SQL migrations transactionally and verify checksums."""
    files = sorted(
        path
        for path in migrations_directory.glob("*.sql")
        if _MIGRATION_FILENAME.fullmatch(path.name)
    )
    if not files:
        raise VectorStoreError("AI_MIGRATION_FILES_MISSING", "No AI schema migrations were found")

    try:
        async with (
            await AsyncConnection.connect(
                psycopg_connection_url(database_url), connect_timeout=5
            ) as connection,
            connection.transaction(),
            connection.cursor() as cursor,
        ):
            await cursor.execute("SET LOCAL search_path = public, pg_catalog")
            await cursor.execute("CREATE SCHEMA IF NOT EXISTS ai")
            await cursor.execute("SELECT pg_advisory_xact_lock(%s)", (_MIGRATION_LOCK_KEY,))
            await cursor.execute(
                """
                        CREATE TABLE IF NOT EXISTS ai.schema_migrations (
                            migration_id VARCHAR(128) PRIMARY KEY,
                            checksum CHAR(64) NOT NULL,
                            applied_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
                        )
                        """
            )
            await cursor.execute(
                "SELECT migration_id, checksum FROM ai.schema_migrations ORDER BY migration_id"
            )
            existing_rows = await cursor.fetchall()
            applied = {str(row[0]): str(row[1]).strip() for row in existing_rows}

            migration_ids = {path.stem for path in files}
            missing_files = set(applied) - migration_ids
            if missing_files:
                raise VectorStoreError(
                    "AI_MIGRATION_FILE_MISSING",
                    "An applied AI schema migration file is missing",
                )

            for path in files:
                migration_id = path.stem
                migration_sql = path.read_text(encoding="utf-8")
                checksum = hashlib.sha256(migration_sql.encode("utf-8")).hexdigest()
                stored_checksum = applied.get(migration_id)
                if stored_checksum is not None:
                    if stored_checksum != checksum:
                        raise VectorStoreError(
                            "AI_MIGRATION_CHECKSUM_MISMATCH",
                            "An applied AI schema migration was modified",
                        )
                    continue

                await cursor.execute(migration_sql, prepare=False)
                await cursor.execute(
                    "INSERT INTO ai.schema_migrations (migration_id, checksum) VALUES (%s, %s)",
                    (migration_id, checksum),
                )
                applied[migration_id] = checksum

            return tuple(
                AppliedMigration(migration_id=name, checksum=checksum)
                for name, checksum in sorted(applied.items())
            )
    except VectorStoreError:
        raise
    except psycopg.Error:
        raise VectorStoreError(
            "AI_MIGRATION_FAILED",
            "The AI schema migration could not be applied",
        ) from None


async def _main() -> None:
    settings = get_settings()
    migrations = await apply_ai_migrations(str(settings.database_url))
    print(f"AI schema is current ({len(migrations)} migrations)")


if __name__ == "__main__":
    asyncio.run(_main())
