import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql://mailpilot:local_dev_only@localhost:55432/mailpilot?schema=public",
)
os.environ.setdefault("AI_PORT", "8000")
os.environ.setdefault("AI_LOG_LEVEL", "critical")
