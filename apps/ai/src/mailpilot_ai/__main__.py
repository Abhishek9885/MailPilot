import asyncio
import sys

import uvicorn

from mailpilot_ai.config import get_settings

if __name__ == "__main__":
    if sys.platform == "win32":
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    settings = get_settings()
    uvicorn.run(
        "mailpilot_ai.main:app",
        host=settings.ai_host,
        port=settings.ai_port,
        reload=False,
    )
