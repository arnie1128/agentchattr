#!/usr/bin/env python3
"""Build a clean release zip for agentchattr.

Packages only user-facing files — no .git, no dev files, no logs, no caches.
Output: agentchattr-{version}.zip in the repo root.
"""

import shutil
import tempfile
from pathlib import Path

ROOT = Path(__file__).parent
VERSION = (ROOT / "VERSION").read_text().strip()
OUT_NAME = f"agentchattr-{VERSION}"

# Files and dirs to include (relative to repo root).
# Library modules live under the agentchattr/ package (an INCLUDE_DIR); only the
# root entry scripts are listed here individually.
INCLUDE_FILES = [
    "run.py",
    "wrapper.py",
    "wrapper_api.py",
    "open_chat.html",
    "config.toml",
    "config.local.toml.example",
    "requirements.txt",
    "README.md",
    "LICENSE",
    "VERSION",
]

INCLUDE_DIRS = [
    "src",
    "static",
    "launchers",
    "session-presets",
    "project-template",
]


def build():
    with tempfile.TemporaryDirectory() as tmp:
        dest = Path(tmp) / OUT_NAME
        dest.mkdir()

        for f in INCLUDE_FILES:
            src = ROOT / f
            if src.exists():
                shutil.copy2(src, dest / f)

        for d in INCLUDE_DIRS:
            src = ROOT / d
            if src.exists():
                shutil.copytree(src, dest / d)

        out_path = ROOT / OUT_NAME
        shutil.make_archive(str(out_path), "zip", tmp, OUT_NAME)

    print(f"Built {out_path}.zip")
    return f"{out_path}.zip"


if __name__ == "__main__":
    build()
