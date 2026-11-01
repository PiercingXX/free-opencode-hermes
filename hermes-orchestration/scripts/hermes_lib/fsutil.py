"""Filesystem helpers shared by the orchestrator and its launchers (stdlib only)."""

from __future__ import annotations

import os
import tempfile
from pathlib import Path


def atomic_write_text(path: Path, text: str) -> None:
    """Write text atomically so a concurrent reader never sees torn content.

    The data goes to a temp file in the same directory and is renamed over the
    target, so every reader sees either the previous file or the complete new
    one. On failure the temp file is removed and the target is untouched.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=path.name, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as tmp:
            tmp.write(text)
        os.replace(tmp_name, path)
    except BaseException:
        Path(tmp_name).unlink(missing_ok=True)
        raise
