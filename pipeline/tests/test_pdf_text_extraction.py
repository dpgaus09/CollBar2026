#!/usr/bin/env python3
"""
Regression tests for PDF text extraction in 06_extract_contracts.py.

The OCR fallback (reading image-only / scanned PDFs) is a load-bearing path:
a dependency bump (tesseract, pypdfium2, Pillow, pdfplumber) or a refactor of
extract_pdf_text could silently break it and quietly drop coverage back to
"No text extracted" for hundreds of districts. These tests catch that fast.

Fixtures (committed under fixtures/, regenerate with make_ocr_fixture.py):
  - scanned_image_only.pdf : rasterized text, NO text layer  -> must OCR
  - text_layer.pdf         : real embedded text layer          -> must NOT OCR

Both are single-page and tiny so the OCR test runs in a few seconds.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

# Dynamically import 06_extract_contracts without triggering argparse main()
_SPEC = importlib.util.spec_from_file_location(
    "extract_contracts",
    Path(__file__).parent.parent / "06_extract_contracts.py",
)
_MOD = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(_MOD)

extract_pdf_text = _MOD.extract_pdf_text

FIXTURE_DIR = Path(__file__).parent / "fixtures"
SCANNED_PDF = FIXTURE_DIR / "scanned_image_only.pdf"
TEXT_LAYER_PDF = FIXTURE_DIR / "text_layer.pdf"

# Tokens rendered into both fixtures (see make_ocr_fixture.py LINES).
EXPECTED_TOKENS = ["COLLECTIVE", "BARGAINING", "AGREEMENT", "SALARY"]


def _ocr_available() -> bool:
    try:
        import pytesseract  # noqa: F401
        import pypdfium2  # noqa: F401
    except ImportError:
        return False
    try:
        import pytesseract
        pytesseract.get_tesseract_version()
        return True
    except Exception:
        return False


class TestOcrFallback(unittest.TestCase):
    """extract_pdf_text must OCR an image-only PDF and return its text."""

    @classmethod
    def setUpClass(cls):
        if not SCANNED_PDF.exists():
            raise unittest.SkipTest(f"Fixture missing: {SCANNED_PDF}")
        if not _ocr_available():
            raise unittest.SkipTest("OCR stack (pytesseract + tesseract) unavailable")
        # Keep the OCR fast and bounded regardless of module defaults.
        cls._orig = (_MOD.OCR_MAX_PAGES, _MOD.OCR_DPI)
        _MOD.OCR_MAX_PAGES = 2
        _MOD.OCR_DPI = 150
        cls.text, cls.used_ocr, cls.reason = extract_pdf_text(SCANNED_PDF)

    @classmethod
    def tearDownClass(cls):
        _MOD.OCR_MAX_PAGES, _MOD.OCR_DPI = cls._orig

    def test_used_ocr_true(self):
        self.assertTrue(self.used_ocr, "Image-only PDF should trigger the OCR fallback")

    def test_no_failure_reason(self):
        self.assertEqual(self.reason, "", f"OCR should succeed cleanly, got reason={self.reason!r}")

    def test_text_non_empty(self):
        self.assertGreaterEqual(
            len(self.text.strip()), _MOD.MIN_TEXT_CHARS,
            "OCR text should clear the MIN_TEXT_CHARS usability threshold",
        )

    def test_expected_tokens_recovered(self):
        upper = self.text.upper()
        for tok in EXPECTED_TOKENS:
            self.assertIn(tok, upper, f"OCR did not recover expected token {tok!r}")


class TestTextLayerPath(unittest.TestCase):
    """extract_pdf_text must read an embedded text layer without OCR."""

    @classmethod
    def setUpClass(cls):
        if not TEXT_LAYER_PDF.exists():
            raise unittest.SkipTest(f"Fixture missing: {TEXT_LAYER_PDF}")
        try:
            import pdfplumber  # noqa: F401
        except ImportError:
            raise unittest.SkipTest("pdfplumber not installed")
        cls.text, cls.used_ocr, cls.reason = extract_pdf_text(TEXT_LAYER_PDF)

    def test_used_ocr_false(self):
        self.assertFalse(self.used_ocr, "Text-layer PDF must not fall back to OCR")

    def test_no_failure_reason(self):
        self.assertEqual(self.reason, "")

    def test_text_non_empty(self):
        self.assertGreater(len(self.text.strip()), 0, "Text-layer PDF returned no text")

    def test_expected_tokens_present(self):
        upper = self.text.upper()
        for tok in EXPECTED_TOKENS:
            self.assertIn(tok, upper, f"Text layer missing expected token {tok!r}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
