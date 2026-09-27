"""Shared durable storage paths used for uploads and generated artifacts."""
from pathlib import Path

from config import config


UPLOAD_ROOT = Path(config.Storage.UPLOADS).resolve()
GENERATED_ROOT = Path(config.Storage.GENERATED).resolve()


def ensure_storage_dirs() -> None:
    UPLOAD_ROOT.mkdir(parents=True, exist_ok=True)
    GENERATED_ROOT.mkdir(parents=True, exist_ok=True)
