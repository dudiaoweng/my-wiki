"""Shared utility functions used across route modules."""

import os
import platform
import shutil
from pathlib import Path


def find_ffmpeg() -> str | None:
    """Find ffmpeg executable. Returns path or None.

    Searches PATH first, then falls back to common install locations
    (e.g., Winget on Windows).
    """
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        return ffmpeg

    # Search Winget install location on Windows
    if platform.system() == "Windows":
        try:
            ffmpeg_base = (
                Path(os.environ.get("LOCALAPPDATA", ""))
                / "Microsoft"
                / "WinGet"
                / "Packages"
            )
            for p in ffmpeg_base.glob("Gyan.FFmpeg_*"):
                candidates = sorted(
                    p.glob("ffmpeg-*-full_build/bin/ffmpeg.exe"), reverse=True
                )
                if candidates:
                    return str(candidates[0])
        except Exception:
            pass
    return None
