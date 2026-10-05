"""Optional high-fidelity slide rendering for Preview/QA; never blocks PPTX output."""

from __future__ import annotations

import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol


@dataclass(frozen=True)
class RenderedSlide:
    index: int
    image_bytes: bytes
    mime_type: str = "image/png"


class PresentationRenderProvider(Protocol):
    name: str

    def render(self, pptx_bytes: bytes) -> list[RenderedSlide]: ...


class LibreOfficeRenderProvider:
    """Convert PPTX → PDF with LibreOffice, then PDF pages → PNG with Poppler."""

    name = "libreoffice-poppler"

    def __init__(self, soffice: str | None = None, pdftoppm: str | None = None):
        self.soffice = soffice or shutil.which("soffice") or shutil.which("libreoffice")
        self.pdftoppm = pdftoppm or shutil.which("pdftoppm")
        if not self.soffice:
            raise RuntimeError("LibreOffice is not installed.")
        if not self.pdftoppm:
            raise RuntimeError("Poppler pdftoppm is not installed.")

    def render(self, pptx_bytes: bytes) -> list[RenderedSlide]:
        with tempfile.TemporaryDirectory(prefix="gor-ppt-render-") as temporary:
            work = Path(temporary)
            source = work / "presentation.pptx"
            source.write_bytes(pptx_bytes)
            profile = (work / "lo-profile").as_uri()
            converted = subprocess.run(
                [self.soffice, "--headless", f"-env:UserInstallation={profile}", "--convert-to", "pdf", "--outdir", str(work), str(source)],
                capture_output=True, text=True, timeout=90, check=False,
            )
            pdf_path = work / "presentation.pdf"
            if converted.returncode != 0 or not pdf_path.is_file():
                detail = (converted.stderr or converted.stdout or "LibreOffice PDF conversion failed.")[-600:]
                raise RuntimeError(detail)
            prefix = work / "page"
            rendered = subprocess.run(
                [self.pdftoppm, "-png", "-scale-to", "1800", str(pdf_path), str(prefix)],
                capture_output=True, text=True, timeout=90, check=False,
            )
            if rendered.returncode != 0:
                detail = (rendered.stderr or rendered.stdout or "PDF page rasterization failed.")[-600:]
                raise RuntimeError(detail)
            pages = sorted(work.glob("page-*.png"), key=lambda path: int(path.stem.rsplit("-", 1)[-1]))
            if not pages:
                raise RuntimeError("The rendered presentation did not contain slide images.")
            return [RenderedSlide(index=index, image_bytes=path.read_bytes()) for index, path in enumerate(pages)]


def create_render_provider() -> PresentationRenderProvider | None:
    """Return a working-provider candidate, or None for schema-preview fallback."""
    if not (shutil.which("soffice") or shutil.which("libreoffice")):
        return None
    if not shutil.which("pdftoppm"):
        return None
    try:
        return LibreOfficeRenderProvider()
    except (OSError, RuntimeError):
        return None
