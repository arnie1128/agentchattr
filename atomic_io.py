"""Atomic JSON file writes.

A bare ``path.write_text(json.dumps(...))`` truncates the target before
writing, so a crash mid-write leaves a partial or empty file — corrupting
the whole store. Writing to a temp sibling, fsyncing it, then
``os.replace()``-ing it over the target means a reader only ever sees the
old file or the fully-written new one, never a partial write.
"""

import json
import os
from pathlib import Path


def write_json_atomic(path, data, *, indent: int = 2,
                      ensure_ascii: bool = False,
                      trailing_newline: bool = True) -> None:
    """Serialize ``data`` to JSON and write it to ``path`` atomically.

    Serialization happens before any file is touched, so a serialization
    error leaves the target untouched. The temp file is removed on any
    failure so stale ``.tmp`` siblings never accumulate.
    """
    path = Path(path)
    text = json.dumps(data, indent=indent, ensure_ascii=ensure_ascii)
    if trailing_newline:
        text += "\n"

    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    try:
        with open(tmp, "w", encoding="utf-8", newline="\n") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        try:
            tmp.unlink()
        except OSError:
            pass
        raise
