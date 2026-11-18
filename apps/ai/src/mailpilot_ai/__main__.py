import uvicorn

from mailpilot_ai.config import get_settings

if __name__ == "__main__":
    settings = get_settings()
    uvicorn.run(
        "mailpilot_ai.main:app",
        host="127.0.0.1",
        port=settings.ai_port,
        reload=False,
    )
