#!/usr/bin/env python3
"""
Regenerate the PDF fixtures used by the OCR regression test
(``test_pdf_text_extraction.py``).

Produces two single-page fixtures:

* ``scanned_image_only.pdf`` — a rasterized image of known text with NO
  embedded text layer, so ``extract_pdf_text()`` must fall back to OCR.
* ``text_layer.pdf`` — a hand-built PDF with a real embedded text layer, so
  ``extract_pdf_text()`` reads it directly (``used_ocr=False``).

Both are kept tiny (one page, modest resolution) so the test stays fast.

Run:  python3 pipeline/tests/fixtures/make_ocr_fixture.py
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OCR_PDF_PATH = Path(__file__).parent / "scanned_image_only.pdf"
TEXT_PDF_PATH = Path(__file__).parent / "text_layer.pdf"

# Lines rendered into the image. Kept short, large, and high-contrast so
# tesseract reads them reliably. The test asserts on these tokens.
LINES = [
    "COLLECTIVE BARGAINING AGREEMENT",
    "OCR REGRESSION FIXTURE DOCUMENT",
    "BASE SALARY INCREASE 2.5 PERCENT",
    "EFFECTIVE AUGUST 1 2023 THROUGH 2026",
]


def _load_font(size: int) -> ImageFont.ImageFont:
    for candidate in (
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    return ImageFont.load_default(size=size)


def build_image_only_pdf() -> None:
    """Rasterize LINES into a one-page image-only PDF (no text layer)."""
    width, height = 1000, 720
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    font = _load_font(40)

    y = 120
    for line in LINES:
        draw.text((80, y), line, fill="black", font=font)
        y += 120

    # Saving an RGB image as PDF yields an image-only PDF (no text layer).
    img.save(OCR_PDF_PATH, "PDF", resolution=150.0)
    print(f"Wrote {OCR_PDF_PATH} ({OCR_PDF_PATH.stat().st_size} bytes)")


def build_text_layer_pdf() -> None:
    """Hand-build a minimal one-page PDF with a real embedded text layer.

    Avoids extra dependencies (no reportlab/fpdf) by emitting raw PDF objects
    with a correct cross-reference table so pdfplumber/pdfminer can read it.
    """
    content_lines = "\n".join(
        f"BT /F1 18 Tf 72 {720 - 40 * i} Td ({line}) Tj ET"
        for i, line in enumerate(LINES, start=1)
    )
    stream = content_lines.encode("latin-1")

    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ]

    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for i, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % i + body + b"\nendobj\n"

    xref_pos = len(out)
    n = len(objects) + 1
    out += b"xref\n0 %d\n" % n
    out += b"0000000000 65535 f \n"
    for off in offsets:
        out += b"%010d 00000 n \n" % off
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\n" % n
    out += b"startxref\n%d\n%%%%EOF\n" % xref_pos

    TEXT_PDF_PATH.write_bytes(out)
    print(f"Wrote {TEXT_PDF_PATH} ({TEXT_PDF_PATH.stat().st_size} bytes)")


def build() -> None:
    build_image_only_pdf()
    build_text_layer_pdf()


if __name__ == "__main__":
    build()
