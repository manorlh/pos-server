import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

_server_dir = Path(__file__).resolve().parent
load_dotenv(_server_dir / ".env")
load_dotenv(_server_dir / ".env.local", override=True)

from app.config import get_settings

if __name__ == "__main__":
    settings = get_settings()
    # VS Code debugpy cannot follow uvicorn's reload subprocess.
    # Set UVICORN_RELOAD=false in launch.json to disable it when debugging.
    reload = settings.debug and os.environ.get("UVICORN_RELOAD", "true") != "false"
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=settings.port,
        reload=reload,
    )
