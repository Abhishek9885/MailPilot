from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import psycopg
from psycopg import AsyncConnection

from mailpilot_ai.config import get_settings


def psycopg_connection_url(database_url: str) -> str:
    """Remove Prisma's schema option before passing the URL to libpq."""
    parts = urlsplit(database_url)
    query = urlencode([(key, value) for key, value in parse_qsl(parts.query) if key != "schema"])
    return urlunsplit((parts.scheme, parts.netloc, parts.path, query, parts.fragment))


async def check_database() -> None:
    settings = get_settings()
    async with await AsyncConnection.connect(
        psycopg_connection_url(str(settings.database_url)),
        connect_timeout=2,
    ) as connection, connection.cursor() as cursor:
        await cursor.execute("SELECT 1")
        row = await cursor.fetchone()
        if row != (1,):
            raise psycopg.DatabaseError("Database health query returned an unexpected result")
