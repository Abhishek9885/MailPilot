from mailpilot_ai.database import psycopg_connection_url


def test_psycopg_connection_url_removes_prisma_schema_option() -> None:
    database_url = (
        "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot"
        "?schema=public&sslmode=disable"
    )

    assert psycopg_connection_url(database_url) == (
        "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot?sslmode=disable"
    )


def test_psycopg_connection_url_preserves_other_query_options() -> None:
    database_url = "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot?connect_timeout=2"

    assert psycopg_connection_url(database_url) == database_url
