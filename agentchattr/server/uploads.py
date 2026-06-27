"""Shared image-upload helpers (NEW-MCP-1).

`save_upload` is the path-copy used by the MCP `chat_send` tool (job and channel
branches). The HTTP multipart upload in app.py is a different operation (it reads
request bytes), so it shares only `ALLOWED_UPLOAD_EXTS`, not `save_upload`. Kept
in its own module so neither mcp_bridge nor app.py has to import the other.
"""

import shutil
import uuid
from pathlib import Path

ALLOWED_UPLOAD_EXTS = {'.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'}


def _upload_dir(config) -> Path:
    raw = "./uploads"
    if config and "images" in config:
        raw = config["images"].get("upload_dir", raw)
    return Path(raw)


def save_upload(image_path, config):
    """Copy a local image into the configured upload dir.

    Returns ``(attachment, error)``: on success ``attachment`` is a
    ``{"name", "url"}`` dict and ``error`` is None; on failure ``attachment`` is
    None and ``error`` is a message string.
    """
    src = Path(image_path)
    if not src.exists():
        return None, f"Image not found: {image_path}"
    if src.suffix.lower() not in ALLOWED_UPLOAD_EXTS:
        return None, f"Unsupported image type: {src.suffix}"
    upload_dir = _upload_dir(config)
    upload_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{uuid.uuid4().hex[:8]}{src.suffix}"
    shutil.copy2(str(src), str(upload_dir / filename))
    return {"name": src.name, "url": f"/uploads/{filename}"}, None
