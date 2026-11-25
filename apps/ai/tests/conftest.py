import asyncio
import os
import sys

if sys.platform == "win32":
    # Psycopg's async API requires a selector-based event loop on Windows.
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot?schema=public",
)
os.environ.setdefault("AI_PORT", "8000")
os.environ.setdefault("AI_LOG_LEVEL", "critical")
