"""Shared utility functions used across route modules."""

import os
import platform
import shutil
from pathlib import Path

from fastapi import HTTPException


MAX_UPLOAD_BYTES = 500 * 1024 * 1024  # 500MB


async def read_upload_limited(file, max_bytes: int) -> bytes:
    """Read an UploadFile in chunks, raising 413 once ``max_bytes`` is exceeded.

    Streams in 1MB chunks so an oversized upload is rejected *before* it is
    fully buffered into memory (unlike ``await file.read()`` followed by a
    post-hoc length check).
    """
    chunks: list[bytes] = []
    total = 0
    while True:
        chunk = await file.read(1024 * 1024)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"File too large (max {max_bytes // (1024 * 1024)}MB)",
            )
        chunks.append(chunk)
    return b"".join(chunks)


def delete_uploaded_files(names) -> None:
    """Delete uploaded files (and their video thumbnails) from the upload dir.

    ``names`` is an iterable of stored filenames (sanitized ``safe_name``
    values).  Each is resolved and verified to sit inside the upload directory
    before deletion.
    """
    upload_dir = Path(os.getenv("UPLOAD_DIR", "./uploads"))
    root = upload_dir.resolve()
    for name in names:
        if not name:
            continue
        path = (upload_dir / name).resolve()
        if not path.is_relative_to(root):
            continue
        for candidate in (path, path.with_name(path.name + ".thumb.jpg")):
            try:
                if candidate.is_file():
                    candidate.unlink()
            except Exception:
                pass


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
