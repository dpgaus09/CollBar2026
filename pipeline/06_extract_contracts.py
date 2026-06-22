#!/usr/bin/env python3
"""
Phase 3 — LLM Extraction Pipeline.

For each unprocessed cba_pdf in source_documents, extract structured contract
data using pdfplumber + Anthropic Claude (claude-haiku-4-5). Insert validated
results into contracts, contract_provisions, and extraction_runs. Derive
settlements for districts with consecutive contracts.

Usage:
    python3 pipeline/06_extract_contracts.py [--max-docs N] [--doc-id ID] [--dry-run]
"""
import argparse
import json
import logging
import math
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

PROMPT_FILE    = Path(__file__).parent / "prompts" / "v1.txt"
IL_PROMPT_FILE = Path(__file__).parent / "prompts" / "v1_il.txt"
CBA_PDF_DIR = common.DATA_DIR / "cba"
IL_CBA_PDF_DIR = common.DATA_DIR / "il_cba"
PROMPT_VERSION    = "v1"
IL_PROMPT_VERSION = "v1_il"
MODEL = "claude-haiku-4-5"
MAX_TEXT_CHARS = 80_000  # truncate context sent to LLM
MAX_TOKENS = 16000

# Minimum chars for a text layer to count as "usable" (below this we OCR).
MIN_TEXT_CHARS = 100

# Bound text-layer reads so a pathological PDF (e.g. a 3,000-page combined
# document) cannot exhaust memory. The LLM context is truncated to
# MAX_TEXT_CHARS anyway, so once we have a comfortable buffer past that we stop
# reading more pages. TEXT_LAYER_MAX_PAGES is a hard ceiling on pages scanned
# per engine regardless of how little text each page yields.
TEXT_LAYER_MAX_PAGES = 600
TEXT_LAYER_STOP_CHARS = MAX_TEXT_CHARS * 2  # early-stop buffer (160k chars)

# OCR configuration (scanned / image-only PDFs)
OCR_DPI = 150               # render resolution for rasterizing pages
OCR_MAX_PAGES = 60          # cap pages OCR'd per doc (most CBAs fit; bounds time)
OCR_DOC_TIMEOUT_SEC = 600   # wall-clock budget per document
OCR_PER_PAGE_TIMEOUT_SEC = 30  # hard timeout per page (tesseract)
OCR_TEXT_DIR = Path(__file__).parent / "state" / "ocr_text"  # cache OCR by file hash

# Mean tesseract word confidence (0-100) below which an OCR'd document is treated
# as low-trust and flagged for human review. Clean digital scans typically score
# 85-95; faint/skewed/handwritten copies fall well below this.
OCR_MIN_CONFIDENCE: float = 70.0

# Anthropic claude-3-5-haiku pricing (USD per 1M tokens) — update if rates change.
COST_PER_1M_INPUT_TOKENS: float = 0.80
COST_PER_1M_OUTPUT_TOKENS: float = 4.00

# Fraction of high-confidence provisions flagged per extraction run for human auditing.
AUDIT_SAMPLE_RATE: float = 0.0  # Audit sampling disabled: high-confidence provisions are trusted and never enter the review queue. Set > 0 to re-enable.

# Directory for saving raw LLM responses that failed JSON validation
FAILED_JSON_DIR = Path(__file__).parent / "state" / "failed_json"


# ---------------------------------------------------------------------------
# Pydantic schema for LLM response validation
# ---------------------------------------------------------------------------
try:
    from pydantic import BaseModel, Field, field_validator
    from pydantic import model_validator
    PYDANTIC_OK = True
except ImportError:
    log.warning("pydantic not installed — JSON will be validated loosely")
    PYDANTIC_OK = False


if PYDANTIC_OK:
    from typing import Literal, List

    class ProvisionItem(BaseModel):
        category: Literal[
            "compensation", "insurance", "retirement", "leave",
            "workday", "evaluation", "rif", "grievance", "other"
        ] = "other"
        provision_key: str
        value_numeric: Optional[float] = None
        value_text: Optional[str] = None
        unit: Optional[str] = None
        clause_excerpt: str
        page_ref: Optional[int] = None
        confidence: float = Field(default=0.5, ge=0.0, le=1.0)

        @field_validator("clause_excerpt")
        @classmethod
        def truncate_excerpt(cls, v: str) -> str:
            if not v or not v.strip():
                raise ValueError("clause_excerpt must not be empty — include verbatim text from the contract")
            words = v.split()
            return " ".join(words[:80]) if len(words) > 80 else v

        @field_validator("provision_key")
        @classmethod
        def snake_case(cls, v: str) -> str:
            return re.sub(r"\s+", "_", v.strip().lower())

    class ContractData(BaseModel):
        union_name: Optional[str] = None
        affiliation: Optional[str] = None
        unit_scope: Optional[str] = None
        bargaining_unit: Optional[str] = None
        effective_start: Optional[str] = None
        effective_end: Optional[str] = None
        term_years: Optional[float] = None
        has_reopener: Optional[bool] = None
        reopener_terms: Optional[str] = None
        provisions: List[ProvisionItem] = []

    class ExtractionResult(BaseModel):
        contracts: List[ContractData] = []


def validate_extraction(raw: str) -> Optional["ExtractionResult"]:
    """Parse and validate the LLM's JSON output. Returns None on failure.

    Lenient validation: individual provisions or contracts that fail schema
    validation are dropped rather than failing the whole document (a single bad
    provision, e.g. a null clause_excerpt, must not discard an otherwise valid
    CBA). Returns None only when the JSON is unparseable, is not an object, or
    has a ``contracts`` key that is present but not a list.
    """
    try:
        data = json.loads(raw)
    except Exception as e:
        log.debug("JSON parse error: %s", e)
        return None

    if not isinstance(data, dict):
        return None
    # Missing "contracts" defaults to empty; present-but-wrong-type is invalid.
    if "contracts" in data and not isinstance(data["contracts"], list):
        return None
    raw_contracts = data.get("contracts", []) or []

    if not PYDANTIC_OK:
        return data  # type: ignore[return-value]

    clean_contracts: "List[ContractData]" = []
    for c in raw_contracts:
        if not isinstance(c, dict):
            continue
        good_provisions: "List[ProvisionItem]" = []
        for p in (c.get("provisions") or []):
            if not isinstance(p, dict):
                continue
            try:
                good_provisions.append(ProvisionItem(**p))
            except Exception as e:
                log.debug("Dropping invalid provision: %s", e)
        fields = {k: v for k, v in c.items() if k != "provisions"}
        try:
            clean_contracts.append(ContractData(**fields, provisions=good_provisions))
        except Exception as e:
            log.debug("Dropping invalid contract: %s", e)
    return ExtractionResult(contracts=clean_contracts)


# ---------------------------------------------------------------------------
# PDF text extraction
# ---------------------------------------------------------------------------

def _text_layer(pdf_path: Path) -> tuple[str, bool]:
    """Read an embedded text layer using pdfplumber, then pypdfium2 as a second
    engine (PDFium sometimes recovers text pdfminer/pdfplumber misses).

    Returns (text, readable). readable=False means neither library could open
    the file (corrupt / not a real PDF).
    """
    best = ""
    readable = False
    try:
        import pdfplumber
        parts: list[str] = []
        acc = 0
        with pdfplumber.open(pdf_path) as pdf:
            readable = True
            for i, page in enumerate(pdf.pages):
                if i >= TEXT_LAYER_MAX_PAGES:
                    log.debug(
                        "pdfplumber stopped at %d pages for %s (cap)",
                        TEXT_LAYER_MAX_PAGES, pdf_path.name,
                    )
                    break
                txt = page.extract_text() or ""
                parts.append(txt)
                acc += len(txt)
                # pdfplumber caches per-page layout objects; flush so memory does
                # not grow unbounded on very large PDFs.
                page.flush_cache()
                if acc >= TEXT_LAYER_STOP_CHARS:
                    break
        best = "\n\n".join(parts).strip()
    except Exception as e:
        log.debug("pdfplumber failed for %s: %s", pdf_path.name, e)

    if len(best) >= MIN_TEXT_CHARS:
        return best, True

    try:
        import pypdfium2 as pdfium
        doc = pdfium.PdfDocument(str(pdf_path))
        readable = True
        parts = []
        acc = 0
        for i in range(min(len(doc), TEXT_LAYER_MAX_PAGES)):
            tp = doc[i].get_textpage()
            txt = tp.get_text_range() or ""
            tp.close()
            parts.append(txt)
            acc += len(txt)
            if acc >= TEXT_LAYER_STOP_CHARS:
                break
        doc.close()
        alt = "\n\n".join(parts).strip()
        if len(alt) > len(best):
            best = alt
    except Exception as e:
        log.debug("pypdfium2 text failed for %s: %s", pdf_path.name, e)

    return best, readable


def _ocr_page(pytesseract, pil) -> tuple[str, list[float]]:
    """OCR a single rasterized page, returning (text, word_confidences).

    Uses ``image_to_data`` (rather than ``image_to_string``) so we get both the
    recognized text and tesseract's per-word confidence in a single pass. Text
    is reconstructed from words grouped by (block, paragraph, line). Confidences
    are the per-word ``conf`` values for non-empty tokens (tesseract reports -1
    for layout boxes with no text, which we drop).
    """
    from pytesseract import Output
    data = pytesseract.image_to_data(
        pil, timeout=OCR_PER_PAGE_TIMEOUT_SEC, output_type=Output.DICT
    )
    words = data.get("text", [])
    confs = data.get("conf", [])
    blocks = data.get("block_num", [])
    pars = data.get("par_num", [])
    line_nums = data.get("line_num", [])

    lines: dict = {}
    order: list = []
    page_confs: list[float] = []
    for i, raw_word in enumerate(words):
        token = (raw_word or "").strip()
        if not token:
            continue
        try:
            conf = float(confs[i])
        except (ValueError, TypeError, IndexError):
            conf = -1.0
        if conf >= 0:
            page_confs.append(conf)
        key = (
            blocks[i] if i < len(blocks) else 0,
            pars[i] if i < len(pars) else 0,
            line_nums[i] if i < len(line_nums) else i,
        )
        if key not in lines:
            lines[key] = []
            order.append(key)
        lines[key].append(token)

    text = "\n".join(" ".join(lines[k]) for k in order)
    return text, page_confs


def _ocr_pdf(pdf_path: Path) -> tuple[str, str, Optional[float]]:
    """OCR a scanned PDF (pypdfium2 render + pytesseract). Caches the result by
    file hash under OCR_TEXT_DIR so retries don't redo the work.

    Returns (text, reason, confidence). reason is '' on success, otherwise a
    taxonomy code: SCANNED_PDF_OCR_UNAVAILABLE, PDF_CORRUPT_OR_UNREADABLE,
    OCR_FAILED_OR_TIMEOUT, or NO_TEXT_AFTER_OCR. confidence is the mean
    tesseract word confidence (0-100) over recognized words, or None when no
    words were recognized (or the result came from a legacy cache without a
    confidence sidecar).
    """
    cache_key: Optional[str] = None
    try:
        cache_key = common.sha256_bytes(pdf_path.read_bytes())
    except Exception as e:
        log.debug("Could not hash %s for OCR cache: %s", pdf_path.name, e)
    if cache_key:
        cache_file = OCR_TEXT_DIR / f"{cache_key}.txt"
        if cache_file.exists():
            cached = cache_file.read_text(encoding="utf-8")
            if len(cached.strip()) >= MIN_TEXT_CHARS:
                log.info("Using cached OCR text for %s", pdf_path.name)
                return cached, "", _read_cached_ocr_confidence(cache_key)

    try:
        import pytesseract
        import pypdfium2 as pdfium
    except ImportError as e:
        log.warning("OCR unavailable (%s) for %s", e, pdf_path.name)
        return "", "SCANNED_PDF_OCR_UNAVAILABLE", None
    try:
        pytesseract.get_tesseract_version()
    except Exception as e:
        log.warning("tesseract binary missing (%s)", e)
        return "", "SCANNED_PDF_OCR_UNAVAILABLE", None

    try:
        doc = pdfium.PdfDocument(str(pdf_path))
    except Exception as e:
        log.warning("pypdfium2 cannot open %s for OCR: %s", pdf_path.name, e)
        return "", "PDF_CORRUPT_OR_UNREADABLE", None

    n_pages = min(len(doc), OCR_MAX_PAGES)
    scale = OCR_DPI / 72.0
    parts: list[str] = []
    all_confs: list[float] = []
    started = time.time()
    timed_out = False
    for i in range(n_pages):
        if time.time() - started > OCR_DOC_TIMEOUT_SEC:
            log.warning("OCR doc-timeout after %d/%d pages for %s", i, n_pages, pdf_path.name)
            timed_out = True
            break
        try:
            pil = doc[i].render(scale=scale).to_pil().convert("L")
            page_text, page_confs = _ocr_page(pytesseract, pil)
            parts.append(page_text)
            all_confs.extend(page_confs)
        except Exception as e:
            log.debug("OCR page %d failed for %s: %s", i, pdf_path.name, e)
    doc.close()

    text = "\n\n".join(parts).strip()
    confidence = round(sum(all_confs) / len(all_confs), 2) if all_confs else None
    if len(text) < MIN_TEXT_CHARS:
        return text, ("OCR_FAILED_OR_TIMEOUT" if timed_out else "NO_TEXT_AFTER_OCR"), confidence

    if cache_key:
        try:
            OCR_TEXT_DIR.mkdir(parents=True, exist_ok=True)
            (OCR_TEXT_DIR / f"{cache_key}.txt").write_text(text, encoding="utf-8")
            _write_cached_ocr_confidence(cache_key, confidence, len(all_confs))
        except OSError as e:
            log.debug("Could not cache OCR text for %s: %s", pdf_path.name, e)
    return text, "", confidence


def _ocr_meta_path(cache_key: str) -> Path:
    return OCR_TEXT_DIR / f"{cache_key}.meta.json"


def _read_cached_ocr_confidence(cache_key: str) -> Optional[float]:
    """Read the cached mean OCR confidence sidecar, or None if absent/legacy."""
    meta_path = _ocr_meta_path(cache_key)
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        val = meta.get("ocr_confidence")
        return float(val) if val is not None else None
    except (OSError, ValueError, TypeError) as e:
        log.debug("Could not read OCR confidence sidecar %s: %s", meta_path.name, e)
        return None


def _write_cached_ocr_confidence(cache_key: str, confidence: Optional[float], word_count: int) -> None:
    """Persist OCR confidence next to the cached text so retries reuse it."""
    try:
        _ocr_meta_path(cache_key).write_text(
            json.dumps({"ocr_confidence": confidence, "ocr_word_count": word_count}),
            encoding="utf-8",
        )
    except OSError as e:
        log.debug("Could not write OCR confidence sidecar for %s: %s", cache_key, e)


def extract_pdf_text(pdf_path: Path) -> tuple[str, bool, str, Optional[float]]:
    """
    Extract text from a PDF. Tries the embedded text layer first (pdfplumber,
    then pypdfium2); if that is empty (scanned / image-only PDF), falls back to
    OCR (pypdfium2 render + pytesseract).

    Returns (text, used_ocr, reason, ocr_confidence). reason is '' on success,
    otherwise a failure-taxonomy code (PDF_CORRUPT_OR_UNREADABLE,
    SCANNED_PDF_OCR_UNAVAILABLE, OCR_FAILED_OR_TIMEOUT, NO_TEXT_AFTER_OCR).
    ocr_confidence is the mean tesseract word confidence (0-100) when OCR ran,
    or None when the text came from an embedded layer or no words were recognized.
    """
    text, readable = _text_layer(pdf_path)
    if len(text) >= MIN_TEXT_CHARS:
        return text, False, "", None
    if not readable:
        return "", False, "PDF_CORRUPT_OR_UNREADABLE", None

    log.info("Empty text layer for %s — attempting OCR", pdf_path.name)
    ocr_text, reason, confidence = _ocr_pdf(pdf_path)
    if len(ocr_text) >= MIN_TEXT_CHARS:
        return ocr_text, True, "", confidence
    return ocr_text, bool(ocr_text), reason or "NO_TEXT_AFTER_OCR", confidence


def chunk_by_articles(text: str) -> str:
    """
    Break CBA text into article-headed chunks and return a condensed
    version capped at MAX_TEXT_CHARS. Preserves article headers.
    """
    article_re = re.compile(
        r"(?m)^(?:ARTICLE|Article|SECTION|Section)\s+[IVXLC\d]+[.\s]", re.MULTILINE
    )
    # Simple approach: return full text, truncated to MAX_TEXT_CHARS
    if len(text) <= MAX_TEXT_CHARS:
        return text
    # Keep as much as possible — the most useful content is early in the doc
    return text[:MAX_TEXT_CHARS]


# ---------------------------------------------------------------------------
# Resolve PDF path from source_documents row
# ---------------------------------------------------------------------------

def resolve_pdf_path(source_url: str, storage_key: str) -> Optional[Path]:
    """Resolve the local file path for a source document."""
    # Local path from storage_key
    if storage_key and storage_key.startswith("local:"):
        p = Path(storage_key[6:])
        if p.exists():
            return p

    # Reconstruct from source_url
    fname = source_url.split("/")[-1] if source_url else None
    if fname:
        for cba_dir in (CBA_PDF_DIR, IL_CBA_PDF_DIR):
            candidate = cba_dir / fname
            if candidate.exists():
                return candidate

    # Try object storage key as a local relative path
    if storage_key and not storage_key.startswith("local:"):
        candidate = common.DATA_DIR / storage_key
        if candidate.exists():
            return candidate

    return None


def resolve_text_path(source_url: str, storage_key: str) -> Optional[Path]:
    """Resolve the local file path for an html_contract text document.

    html_contract source_documents store the page's extracted text as a .txt
    file (under il/cba/<hash>.txt), uploaded to object storage and mirrored
    locally by the crawler. Mirrors resolve_pdf_path but for the text payload,
    and fetches from object storage when the local mirror is absent (e.g. after
    a clean checkout or when extraction runs on a different machine).
    """
    if storage_key and storage_key.startswith("local:"):
        p = Path(storage_key[6:])
        if p.exists():
            return p

    fname = source_url.split("/")[-1] if source_url else None
    if fname and fname.endswith(".txt"):
        for cba_dir in (CBA_PDF_DIR, IL_CBA_PDF_DIR):
            candidate = cba_dir / fname
            if candidate.exists():
                return candidate

    if storage_key and not storage_key.startswith("local:"):
        candidate = common.DATA_DIR / storage_key
        if candidate.exists():
            return candidate
        # Object-storage keys mirror locally under il_cba/<hash>.txt.
        local_mirror = IL_CBA_PDF_DIR / Path(storage_key).name
        if local_mirror.exists():
            return local_mirror

    return None


# ---------------------------------------------------------------------------
# Anthropic API call
# ---------------------------------------------------------------------------

def load_prompt() -> str:
    """Load the v1 extraction prompt."""
    return PROMPT_FILE.read_text(encoding="utf-8")


def call_anthropic(
    system_prompt: str,
    text: str,
    *,
    short_form: bool = False,
) -> tuple[Optional[str], int, int, Optional[str]]:
    """
    Call Anthropic Claude and return (response_text, input_tokens, output_tokens, stop_reason).
    Returns (None, 0, 0, None) on failure.

    short_form=True sends a reduced prompt asking for only the 30 highest-confidence
    provisions — used when a prior call was cut off at max_tokens.
    """
    try:
        import anthropic as _anthropic
    except ImportError:
        log.error("anthropic SDK not installed — pip install anthropic")
        return None, 0, 0, None

    base_url = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "")
    api_key = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "dummy")

    client_kwargs: dict = {"api_key": api_key}
    if base_url:
        client_kwargs["base_url"] = base_url

    client = _anthropic.Anthropic(**client_kwargs)

    if short_form:
        user_content = (
            "The previous response was truncated. "
            "Re-extract contract data from the CBA text below, but return ONLY the "
            "30 highest-confidence provisions. Output only valid JSON.\n\n"
            f"<cba_text>\n{text}\n</cba_text>"
        )
    else:
        user_content = (
            "Extract all contract data from the following CBA text. "
            "Output only valid JSON.\n\n"
            f"<cba_text>\n{text}\n</cba_text>"
        )

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=system_prompt,
            messages=[{"role": "user", "content": user_content}],
        )
        block = response.content[0]
        text_out = block.text if block.type == "text" else None
        usage = response.usage
        return text_out, usage.input_tokens, usage.output_tokens, response.stop_reason
    except Exception as e:
        log.warning("Anthropic API error: %s", e)
        return None, 0, 0, None


def extract_json_from_response(raw: str) -> str:
    """Extract the JSON object/array from a model response.

    Scans for the first ``{`` or ``[`` and returns the substring up to its
    matching close bracket using a string-aware balanced scan. This ignores
    leading ```json fences, trailing ``` fences, and any prose the model emits
    before or after the JSON (a common cause of spurious json.loads failures).
    Falls back to the substring from the first bracket if no balanced match is
    found (likely a truncated response).
    """
    raw = raw.strip()
    start = next((i for i, c in enumerate(raw) if c in "{["), -1)
    if start == -1:
        return raw

    open_ch = raw[start]
    close_ch = "}" if open_ch == "{" else "]"
    depth = 0
    in_str = False
    esc = False
    for i in range(start, len(raw)):
        ch = raw[i]
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return raw[start:i + 1]
    # No balanced close found — return remainder (caller treats as truncated).
    return raw[start:]


def _looks_truncated(s: str) -> bool:
    """Heuristic: are brackets/quotes unbalanced (string-aware)? True suggests
    the JSON was cut off (e.g. the model hit max_tokens mid-output)."""
    depth = 0
    in_str = False
    esc = False
    for ch in s:
        if in_str:
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "{[":
            depth += 1
        elif ch in "}]":
            depth -= 1
    return depth != 0 or in_str


def _classify_json_failure(cleaned: str, stop_reason: Optional[str]) -> str:
    """Map a failed JSON parse/validation to a taxonomy code."""
    try:
        json.loads(cleaned)
        # Parses fine but validate_extraction rejected it (e.g. contracts not a list).
        return "LLM_SCHEMA_INVALID"
    except Exception:
        if stop_reason == "max_tokens" or _looks_truncated(cleaned):
            return "LLM_TRUNCATED_JSON"
        return "LLM_SCHEMA_INVALID"


# ---------------------------------------------------------------------------
# DB operations
# ---------------------------------------------------------------------------

def get_failed_docs(conn):
    """
    Return source_document rows that are *currently failing*: their most recent
    extraction run has status='failed'.  Used by --retry-failed.

    This matches the admin Extraction Failures view, which buckets each doc by
    its LATEST run status. A doc that succeeded once but whose latest run failed
    is therefore included here (it is "currently failing"), and a doc that failed
    earlier but later succeeded is excluded.

    Returns tuples: (id, source_url, storage_key, district_id, school_year, district_state, bargaining_unit)
    """
    cur = conn.cursor()
    cur.execute(
        """
        WITH latest AS (
            SELECT DISTINCT ON (source_doc_id) source_doc_id, status
            FROM extraction_runs
            WHERE source_doc_id IS NOT NULL
            ORDER BY source_doc_id, run_at DESC, id DESC
        )
        SELECT sd.id, sd.source_url, sd.storage_key, sd.district_id, sd.school_year,
               COALESCE(d.state, 'OH') AS district_state, sd.bargaining_unit, sd.source_type
        FROM source_documents sd
        JOIN latest l ON l.source_doc_id = sd.id
        LEFT JOIN districts d ON d.id = sd.district_id
        WHERE sd.doc_type = 'cba_pdf'
          AND l.status = 'failed'
        ORDER BY sd.id
        """
    )
    rows = cur.fetchall()
    cur.close()
    return rows


def get_unprocessed_docs(conn, doc_id: Optional[int] = None, priority: bool = False,
                         state: Optional[str] = None):
    """
    Return source_document rows for cba_pdf docs with no successful extraction_run.
    If doc_id is given, return only that row.
    When priority=True, contracts with school_year >= '2023-24' (likely expiring
    2026-2027) are processed first.
    When state is given (e.g. 'IL'), only return docs for districts in that state.

    Returns tuples: (id, source_url, storage_key, district_id, school_year, district_state, bargaining_unit)
    """
    cur = conn.cursor()
    state_filter = "AND d.state = %s" if state else ""
    state_params: tuple = (state,) if state else ()

    if doc_id:
        cur.execute(
            """
            SELECT sd.id, sd.source_url, sd.storage_key, sd.district_id, sd.school_year,
                   COALESCE(d.state, 'OH') AS district_state, sd.bargaining_unit, sd.source_type
            FROM source_documents sd
            LEFT JOIN districts d ON d.id = sd.district_id
            WHERE sd.id = %s AND sd.doc_type = 'cba_pdf'
            """,
            (doc_id,),
        )
    else:
        order_clause = (
            "ORDER BY CASE WHEN sd.school_year >= '2023-24' THEN 0 ELSE 1 END ASC,"
            " sd.school_year DESC NULLS LAST, sd.id"
            if priority
            else "ORDER BY sd.id"
        )
        cur.execute(
            f"""
            SELECT sd.id, sd.source_url, sd.storage_key, sd.district_id, sd.school_year,
                   COALESCE(d.state, 'OH') AS district_state, sd.bargaining_unit, sd.source_type
            FROM source_documents sd
            LEFT JOIN districts d ON d.id = sd.district_id
            WHERE sd.doc_type = 'cba_pdf'
              AND sd.id NOT IN (
                  SELECT er.source_doc_id
                  FROM extraction_runs er
                  WHERE er.status = 'success'
                    AND er.source_doc_id IS NOT NULL
              )
              {state_filter}
            {order_clause}
            """,
            state_params,
        )
    rows = cur.fetchall()
    cur.close()
    return rows


def insert_extraction_run(cur, source_doc_id: int, status: str, error: Optional[str] = None,
                          prompt_version: str = PROMPT_VERSION, *,
                          used_ocr: bool = False, ocr_confidence: Optional[float] = None,
                          ocr_low_quality: bool = False) -> int:
    cur.execute(
        """
        INSERT INTO extraction_runs
            (source_doc_id, model, prompt_version, status, error,
             used_ocr, ocr_confidence, ocr_low_quality)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
        RETURNING id
        """,
        (source_doc_id, MODEL, prompt_version, status, error,
         used_ocr, ocr_confidence, ocr_low_quality),
    )
    row = cur.fetchone()
    return row[0] if row else -1


def update_extraction_run(cur, run_id: int, status: str, error: Optional[str] = None):
    cur.execute(
        "UPDATE extraction_runs SET status = %s, error = %s WHERE id = %s",
        (status, error, run_id),
    )


def resolve_bargaining_unit(c: "ContractData", default_unit: str = "teachers") -> str:
    """Resolve a contract's canonical bargaining_unit from the LLM result.

    Precedence: an explicit canonical LLM ``bargaining_unit`` value →
    classifier over the text signals (bargaining_unit text, unit_scope, union
    name, affiliation) → the source document's unit hint (``default_unit``).
    """
    llm = _s(c, "bargaining_unit")
    if llm and llm.strip().lower() in common.BARGAINING_UNITS:
        return llm.strip().lower()
    guess = common.classify_bargaining_unit(
        llm,
        _s(c, "unit_scope"),
        _s(c, "union_name"),
        _s(c, "affiliation"),
        default="other",
    )
    if guess != "other":
        return guess
    return default_unit or "teachers"


def upsert_contract(
    cur, district_id, c: "ContractData", source_doc_id: int,
    default_unit: str = "teachers",
) -> Optional[int]:
    """Insert a contract row. Returns the contract id."""
    bargaining_unit = resolve_bargaining_unit(c, default_unit)
    try:
        cur.execute(
            """
            INSERT INTO contracts
                (district_id, union_name, affiliation, unit_scope, bargaining_unit,
                 effective_start, effective_end, term_years,
                 has_reopener, reopener_terms, source_doc_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (district_id, bargaining_unit, unit_scope, effective_start) DO UPDATE SET
                union_name        = COALESCE(EXCLUDED.union_name, contracts.union_name),
                affiliation       = COALESCE(EXCLUDED.affiliation, contracts.affiliation),
                effective_end     = COALESCE(EXCLUDED.effective_end, contracts.effective_end),
                term_years        = COALESCE(EXCLUDED.term_years, contracts.term_years),
                has_reopener      = COALESCE(EXCLUDED.has_reopener, contracts.has_reopener),
                reopener_terms    = COALESCE(EXCLUDED.reopener_terms, contracts.reopener_terms)
            RETURNING id
            """,
            (
                district_id,
                _s(c, "union_name"),
                _s(c, "affiliation"),
                _s(c, "unit_scope") or "certificated",
                bargaining_unit,
                _s(c, "effective_start"),
                _s(c, "effective_end"),
                _n(c, "term_years"),
                _b(c, "has_reopener"),
                _s(c, "reopener_terms"),
                source_doc_id,
            ),
        )
        row = cur.fetchone()
        return row[0] if row else None
    except Exception as e:
        log.warning("Contract upsert failed: %s", e)
        return None


def insert_provisions(cur, contract_id: int, provisions) -> int:
    inserted = 0
    for p in provisions:
        page_ref = _n(p, "page_ref")
        pkey = _s(p, "provision_key") or "?"
        raw_conf = _n(p, "confidence", default=0.5)

        if page_ref is None:
            # No page reference — cap confidence so the provision lands in the
            # review queue (threshold is 0.8) and a human can verify or fill in
            # the page number before it is trusted.
            conf = min(raw_conf, 0.6)
            log.debug(
                "provision '%s' for contract %d has no page_ref — "
                "capping confidence %.2f→%.2f to route to review queue",
                pkey, contract_id, raw_conf, conf,
            )
        else:
            conf = raw_conf

        try:
            cur.execute(
                """
                INSERT INTO contract_provisions
                    (contract_id, category, provision_key, value_numeric,
                     value_text, unit, clause_excerpt, page_ref, confidence)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
                """,
                (
                    contract_id,
                    _s(p, "category") or "other",
                    pkey,
                    _n(p, "value_numeric"),
                    _s(p, "value_text"),
                    _s(p, "unit"),
                    _s(p, "clause_excerpt"),
                    page_ref,
                    conf,
                ),
            )
            inserted += 1
        except Exception as e:
            log.debug("Provision insert error: %s", e)
    return inserted


def mark_audit_samples(cur, contract_id: int, sample_rate: float = AUDIT_SAMPLE_RATE) -> int:
    """
    Mark a random fraction of high-confidence provisions (confidence >= 0.8) as
    audit samples for human spot-checking. Returns the number of provisions flagged.

    Disabled by default (AUDIT_SAMPLE_RATE = 0.0): high-confidence extractions are
    trusted and never flagged, so they do not enter the admin review queue. Set
    AUDIT_SAMPLE_RATE > 0 to re-enable spot-check sampling.
    """
    cur.execute(
        """
        SELECT id FROM contract_provisions
        WHERE contract_id = %s AND confidence >= 0.8 AND NOT is_audit_sample
        """,
        (contract_id,),
    )
    high_conf_ids = [row[0] for row in cur.fetchall()]
    if not high_conf_ids:
        return 0
    n_sample = math.ceil(len(high_conf_ids) * sample_rate)
    if n_sample <= 0:
        return 0
    sample_ids = random.sample(high_conf_ids, min(n_sample, len(high_conf_ids)))
    for sid in sample_ids:
        cur.execute(
            "UPDATE contract_provisions SET is_audit_sample = true WHERE id = %s",
            (sid,),
        )
    return len(sample_ids)


# Attribute access helpers that work for both Pydantic models and plain dicts
def _s(obj, key: str) -> Optional[str]:
    val = obj[key] if isinstance(obj, dict) else getattr(obj, key, None)
    return str(val)[:2000] if val is not None else None


def _n(obj, key: str, default=None):
    val = obj[key] if isinstance(obj, dict) else getattr(obj, key, None)
    if val is None:
        return default
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def _b(obj, key: str) -> Optional[bool]:
    val = obj[key] if isinstance(obj, dict) else getattr(obj, key, None)
    if val is None:
        return None
    if isinstance(val, bool):
        return val
    return str(val).lower() in ("true", "yes", "1")


# ---------------------------------------------------------------------------
# Settlement derivation — helpers
# ---------------------------------------------------------------------------


def _get_contract_provisions(cur, contract_id: int) -> dict:
    """Return compensation provisions for a contract keyed by provision_key."""
    cur.execute(
        """
        SELECT provision_key,
               value_numeric::float AS val,
               confidence::float    AS conf
        FROM contract_provisions
        WHERE contract_id = %s
          AND category = 'compensation'
          AND provision_key IN (
            'base_salary_increase_yr1','base_salary_increase_yr2',
            'base_salary_increase_yr3','ba_min_salary','off_schedule_bonus_yr1'
          )
          AND value_numeric IS NOT NULL
        """,
        (contract_id,),
    )
    return {row[0]: {"val": row[1], "conf": row[2]} for row in cur.fetchall()}


def _school_year(date_str, *, is_end: bool = False) -> Optional[str]:
    """
    Convert a date (YYYY-MM-DD string or datetime.date) to 'YYYY-YY' school year.
    Ohio school year starts in July: Aug 2022 start → 2022-23; Jun 2025 end → 2024-25.
    """
    if not date_str:
        return None
    try:
        import datetime as _dt
        if isinstance(date_str, (_dt.date, _dt.datetime)):
            y, m = date_str.year, date_str.month
        else:
            s = str(date_str)
            y = int(s[:4])
            m = int(s[5:7]) if len(s) >= 7 else 7
        if is_end and m <= 6:
            y -= 1
        return f"{y}-{str(y + 1)[2:]}"
    except (ValueError, IndexError, AttributeError):
        return None


def backfill_contract_units(conn) -> int:
    """Re-derive each contract's bargaining_unit from its unit_scope / union /
    affiliation using the shared classifier.

    Corrects migration 0008's blanket 'teachers' default for non-teacher
    contracts. Idempotent and conservative: only overrides when the classifier
    finds a real signal (i.e. a non-'other' result that differs from the
    current value), so it never clobbers a more specific value with 'other'.
    """
    import psycopg2  # driver is always available where this runs

    cur = conn.cursor()
    cur.execute(
        "SELECT id, unit_scope, union_name, affiliation, bargaining_unit FROM contracts"
    )
    rows = cur.fetchall()
    updated = 0
    skipped_conflict = 0
    for cid, scope, uname, affil, current in rows:
        guess = common.classify_bargaining_unit(scope, uname, affil, default="other")
        if guess == "other" or guess == current:
            continue
        # Reclassifying can collide with the
        # (district_id, bargaining_unit, unit_scope, effective_start) unique
        # constraint when a duplicate contract already holds the corrected unit
        # (e.g. one doc tagged 'teachers' by migration 0008 and a sibling doc
        # already tagged 'support_staff' for the same scope/term). Use a per-row
        # savepoint so one such conflict cannot abort the whole pass.
        cur.execute("SAVEPOINT bf_unit")
        try:
            cur.execute(
                "UPDATE contracts SET bargaining_unit = %s WHERE id = %s", (guess, cid)
            )
        except psycopg2.errors.UniqueViolation:
            cur.execute("ROLLBACK TO SAVEPOINT bf_unit")
            cur.execute("RELEASE SAVEPOINT bf_unit")
            skipped_conflict += 1
        else:
            cur.execute("RELEASE SAVEPOINT bf_unit")
            updated += 1
    conn.commit()
    cur.close()
    if skipped_conflict:
        log.warning(
            "backfill_contract_units: left %d contract(s) unchanged — reclassified "
            "unit would duplicate an existing (district, unit, scope, start) row",
            skipped_conflict,
        )
    return updated


# An LLM occasionally misreads a dollar figure as a percentage (e.g. a $4,500
# base salary read as a 4500% raise). Any |base increase| beyond this bound is
# implausible for a K-12 salary settlement, so derive_settlements flags it for
# human review instead of inserting bad data or letting a numeric(5,2) overflow
# silently drop the whole row.
MAX_PLAUSIBLE_BASE_PCT = 50.0


def derive_settlements(conn):
    """
    Derives settlements via two independent paths:

    1. 'stated'       — any contract with a base_salary_increase_yr1 provision
                        emits a row directly.  No consecutive pair required.
    2. 'ba_min_delta' — consecutive contract pairs (same district + normalized
                        unit_scope, ≤ 730-day gap) where no stated % exists but
                        BA-min values allow computing the implied increase.

    For every contract evaluated, a skip reason is recorded when no settlement
    is emitted.  A summary table is printed at the end.
    """
    from collections import defaultdict
    from datetime import date as _date

    # Ensure every contract carries a canonical bargaining_unit before grouping.
    n_unit = backfill_contract_units(conn)
    if n_unit:
        log.info("Backfilled bargaining_unit on %d contract(s) from unit_scope", n_unit)

    cur = conn.cursor()

    # 'stated' and 'ba_min_delta' settlements are fully re-derivable from
    # contracts. Delete and re-derive so unit re-classification cannot leave
    # stale, mis-tagged rows. 'tss_diff' settlements (loaded separately) are
    # never touched.
    cur.execute("DELETE FROM settlements WHERE method IN ('stated','ba_min_delta')")
    if cur.rowcount:
        log.info("Cleared %d derivable settlement(s) for re-derivation", cur.rowcount)
    conn.commit()

    # skip_reasons[reason] = count — accumulated across both passes
    skip_reasons: dict[str, int] = {}
    stated_emitted: set[int] = set()   # contract IDs that already produced a row
    settlements_inserted = 0
    contracts_evaluated = 0
    # Contracts whose stated/derived base % is implausibly large — collected so a
    # short list can be surfaced for re-extraction / human review at the end.
    flagged_for_review: list[tuple] = []  # (method, district_id, contract_id, source_doc_id, base_pct)

    def _skip(reason: str) -> None:
        skip_reasons[reason] = skip_reasons.get(reason, 0) + 1

    def _flag_out_of_range(method: str, district_id, contract_id, source_doc_id,
                           base_pct: float) -> None:
        """Record an implausible base % for review instead of inserting it."""
        flagged_for_review.append((method, district_id, contract_id, source_doc_id, base_pct))
        _skip(f"{method}:base_pct_out_of_range")
        log.warning(
            "Contract %s (district=%s) [%s]: base_increase_pct=%.2f%% exceeds "
            "+/-%.0f%% plausible range — flagged for review, not inserted",
            contract_id, district_id, method, base_pct, MAX_PLAUSIBLE_BASE_PCT,
        )

    # -------------------------------------------------------------------------
    # PASS 1 — 'stated' path
    # Any contract with base_salary_increase_yr1 emits a settlement directly.
    # Consecutive contracts are NOT required.
    # -------------------------------------------------------------------------
    cur.execute(
        """
        SELECT id, district_id, unit_scope, effective_start, effective_end, term_years,
               bargaining_unit, source_doc_id
        FROM contracts
        ORDER BY district_id NULLS LAST, effective_start NULLS LAST, id
        """
    )
    all_contracts = cur.fetchall()
    contracts_evaluated = len(all_contracts)

    for (contract_id, district_id, unit_scope, eff_start, eff_end, term_years,
         bargaining_unit, source_doc_id) in all_contracts:
        if district_id is None:
            log.debug("Contract %d skipped [stated]: no district_id", contract_id)
            _skip("no_district_id")
            continue

        prov = _get_contract_provisions(cur, contract_id)
        yr1 = prov.get("base_salary_increase_yr1", {})

        if not yr1:
            log.debug(
                "Contract %d (district=%d) skipped [stated]: no base_salary_increase_yr1",
                contract_id, district_id,
            )
            _skip("stated:no_yr1_provision")
            continue

        if not eff_start:
            log.debug(
                "Contract %d (district=%d) skipped [stated]: missing effective_start",
                contract_id, district_id,
            )
            _skip("stated:no_effective_start")
            continue

        from_year = _school_year(eff_start)
        if not from_year:
            log.debug(
                "Contract %d (district=%d) skipped [stated]: cannot parse effective_start=%r",
                contract_id, district_id, eff_start,
            )
            _skip("stated:unparseable_date")
            continue

        base_pct    = yr1["val"]
        confidence  = yr1["conf"]
        to_year     = _school_year(eff_end, is_end=True) if eff_end else None
        yr2_val     = prov.get("base_salary_increase_yr2", {}).get("val")
        yr3_val     = prov.get("base_salary_increase_yr3", {}).get("val")
        off_sched   = prov.get("off_schedule_bonus_yr1", {}).get("val")

        # Sanity guard: flag implausible base % (likely an LLM dollar→percent
        # misread) for review rather than inserting bad data or relying on a DB
        # numeric overflow to drop it.
        if isinstance(base_pct, (int, float)) and abs(base_pct) > MAX_PLAUSIBLE_BASE_PCT:
            _flag_out_of_range("stated", district_id, contract_id, source_doc_id, float(base_pct))
            continue

        try:
            # Per-row SAVEPOINT: a single bad value (e.g. an LLM-misread
            # base_increase_pct that overflows numeric(5,2)) must not abort the
            # whole derive transaction and roll back every other settlement.
            cur.execute("SAVEPOINT sp_settlement")
            cur.execute(
                """
                INSERT INTO settlements
                    (district_id, bargaining_unit, from_year, to_year, base_increase_pct,
                     year2_pct, year3_pct, off_schedule_payment,
                     term_years, method, confidence, contract_id, source_doc_id)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (district_id, bargaining_unit, from_year, to_year) DO NOTHING
                """,
                (
                    district_id,
                    bargaining_unit,
                    from_year,
                    to_year or from_year,
                    base_pct,
                    yr2_val,
                    yr3_val,
                    off_sched,
                    term_years,
                    "stated",
                    confidence,
                    contract_id,
                    source_doc_id,
                ),
            )
            inserted = cur.rowcount > 0
            cur.execute("RELEASE SAVEPOINT sp_settlement")
            if inserted:
                settlements_inserted += 1
                stated_emitted.add(contract_id)
                log.info(
                    "Settlement [stated] district=%d contract=%d %s→%s "
                    "base=%.2f%% yr2=%s yr3=%s conf=%.2f",
                    district_id, contract_id, from_year, to_year or from_year,
                    base_pct,
                    f"{yr2_val:.2f}%" if yr2_val is not None else "—",
                    f"{yr3_val:.2f}%" if yr3_val is not None else "—",
                    confidence,
                )
            else:
                log.debug(
                    "Contract %d (district=%d) [stated]: conflict — %s→%s already exists",
                    contract_id, district_id, from_year, to_year or from_year,
                )
                stated_emitted.add(contract_id)  # still counts as handled
                _skip("stated:conflict_already_exists")
        except Exception as e:
            try:
                cur.execute("ROLLBACK TO SAVEPOINT sp_settlement")
                cur.execute("RELEASE SAVEPOINT sp_settlement")
            except Exception:
                pass
            log.warning("Settlement insert error for contract %d: %s", contract_id, e)
            _skip("stated:insert_error")

    conn.commit()

    # -------------------------------------------------------------------------
    # PASS 2 — 'ba_min_delta' path
    # Consecutive pairs (same district + canonical unit_scope, ≤ 730-day gap)
    # where no stated % exists but BA-min values are present.
    # Contracts are grouped by canonical bargaining_unit (set at extraction time
    # and backfilled above) so that e.g. "certificated teaching staff" and
    # "teachers" share a group while a custodial unit stays separate.
    # -------------------------------------------------------------------------

    # Build the set of (district_id, bargaining_unit) groups present.
    canon_groups: dict[tuple, bool] = {}
    for row_c in all_contracts:
        c_district_id = row_c[1]
        c_unit = row_c[6]
        if c_district_id is None:
            continue
        canon_groups[(c_district_id, c_unit)] = True

    for (district_id, bargaining_unit) in canon_groups:
        # Fetch all contracts in this district + bargaining unit, in time order.
        cur.execute(
            """
            SELECT id, effective_start, effective_end, term_years, unit_scope, source_doc_id
            FROM contracts
            WHERE district_id = %s AND bargaining_unit = %s
            ORDER BY effective_start NULLS LAST, id
            """,
            (district_id, bargaining_unit),
        )
        group_contracts = cur.fetchall()

        prev_ba_min: Optional[float] = None
        prev_ba_conf: float = 0.5
        prev_eff_end: Optional[str] = None

        for i, (contract_id, eff_start, eff_end, term_years, unit_scope, source_doc_id) in enumerate(group_contracts):
            prov = _get_contract_provisions(cur, contract_id)
            ba_min   = prov.get("ba_min_salary", {}).get("val")
            yr1      = prov.get("base_salary_increase_yr1", {})

            # Update running state (used by the NEXT iteration)
            next_ba_min  = ba_min
            next_ba_conf = prov.get("ba_min_salary", {}).get("conf", 0.6) if ba_min is not None else 0.5
            next_eff_end = eff_end or eff_start

            if contract_id in stated_emitted:
                # Already handled by stated path — still update state for adjacency tracking
                prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end
                continue

            if yr1:
                # Has stated yr1 but wasn't emitted via stated (e.g. no district_id was
                # later resolved) — skip; don't double-count.
                prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end
                continue

            # Need to be the second+ contract in an adjacent pair
            if i == 0:
                log.debug(
                    "Contract %d (district=%d scope=%r) skipped [ba_min_delta]: first in group",
                    contract_id, district_id, unit_scope,
                )
                _skip("ba_min_delta:first_in_group")
                prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end
                continue

            # Check adjacency (≤ 730-day gap between prev end and this start)
            is_adjacent = False
            if eff_start and prev_eff_end:
                try:
                    def _to_date(v):
                        import datetime as _dt2
                        if isinstance(v, (_dt2.date, _dt2.datetime)):
                            return v if isinstance(v, _dt2.date) else v.date()
                        return _date.fromisoformat(str(v))
                    gap_days = (_to_date(eff_start) - _to_date(prev_eff_end)).days
                    is_adjacent = abs(gap_days) <= 730
                    if not is_adjacent:
                        log.debug(
                            "Contract %d (district=%d scope=%r) skipped [ba_min_delta]: "
                            "gap %d days > 730",
                            contract_id, district_id, unit_scope, gap_days,
                        )
                        _skip("ba_min_delta:gap_too_large")
                except (ValueError, TypeError):
                    _skip("ba_min_delta:date_parse_error")
            else:
                log.debug(
                    "Contract %d (district=%d scope=%r) skipped [ba_min_delta]: "
                    "missing date for adjacency check",
                    contract_id, district_id, unit_scope,
                )
                _skip("ba_min_delta:missing_date")

            if not is_adjacent:
                prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end
                continue

            if prev_ba_min is None:
                log.debug(
                    "Contract %d (district=%d scope=%r) skipped [ba_min_delta]: "
                    "no ba_min on prior contract",
                    contract_id, district_id, unit_scope,
                )
                _skip("ba_min_delta:no_prev_ba_min")
                prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end
                continue

            if ba_min is None:
                log.debug(
                    "Contract %d (district=%d scope=%r) skipped [ba_min_delta]: "
                    "no ba_min on this contract",
                    contract_id, district_id, unit_scope,
                )
                _skip("ba_min_delta:no_current_ba_min")
                prev_ba_min = None  # reset chain — can't use stale value
                prev_ba_conf, prev_eff_end = next_ba_conf, next_eff_end
                continue

            if prev_ba_min <= 0:
                _skip("ba_min_delta:prev_ba_min_nonpositive")
                prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end
                continue

            if not eff_start:
                log.debug(
                    "Contract %d (district=%d scope=%r) skipped [ba_min_delta]: "
                    "no effective_start",
                    contract_id, district_id, unit_scope,
                )
                _skip("ba_min_delta:no_effective_start")
                prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end
                continue

            from_year = _school_year(eff_start)
            if not from_year:
                _skip("ba_min_delta:unparseable_date")
                prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end
                continue

            base_pct   = round((ba_min - prev_ba_min) / prev_ba_min * 100, 2)
            confidence = round((next_ba_conf + prev_ba_conf) / 2, 2)
            to_year    = _school_year(eff_end, is_end=True) if eff_end else None
            yr2_val    = prov.get("base_salary_increase_yr2", {}).get("val")
            yr3_val    = prov.get("base_salary_increase_yr3", {}).get("val")
            off_sched  = prov.get("off_schedule_bonus_yr1", {}).get("val")

            # Sanity guard: a bad BA-min delta (e.g. a misread salary figure) can
            # produce a wildly implausible implied increase. Flag for review
            # rather than inserting it or relying on a DB numeric overflow.
            if abs(base_pct) > MAX_PLAUSIBLE_BASE_PCT:
                _flag_out_of_range("ba_min_delta", district_id, contract_id, source_doc_id, base_pct)
                prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end
                continue

            try:
                # Per-row SAVEPOINT (see PASS 1) so one overflow/bad value cannot
                # abort the whole derive transaction.
                cur.execute("SAVEPOINT sp_settlement")
                cur.execute(
                    """
                    INSERT INTO settlements
                        (district_id, bargaining_unit, from_year, to_year, base_increase_pct,
                         year2_pct, year3_pct, off_schedule_payment,
                         term_years, method, confidence, contract_id, source_doc_id)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (district_id, bargaining_unit, from_year, to_year) DO NOTHING
                    """,
                    (
                        district_id,
                        bargaining_unit,
                        from_year,
                        to_year or from_year,
                        base_pct,
                        yr2_val,
                        yr3_val,
                        off_sched,
                        term_years,
                        "ba_min_delta",
                        confidence,
                        contract_id,
                        source_doc_id,
                    ),
                )
                inserted = cur.rowcount > 0
                cur.execute("RELEASE SAVEPOINT sp_settlement")
                if inserted:
                    settlements_inserted += 1
                    log.info(
                        "Settlement [ba_min_delta] district=%d contract=%d %s→%s "
                        "base=%.2f%% (ba_min %.0f→%.0f) conf=%.2f",
                        district_id, contract_id, from_year, to_year or from_year,
                        base_pct, prev_ba_min, ba_min, confidence,
                    )
                else:
                    _skip("ba_min_delta:conflict_already_exists")
            except Exception as e:
                try:
                    cur.execute("ROLLBACK TO SAVEPOINT sp_settlement")
                    cur.execute("RELEASE SAVEPOINT sp_settlement")
                except Exception:
                    pass
                log.warning("Settlement insert error for contract %d: %s", contract_id, e)
                _skip("ba_min_delta:insert_error")

            prev_ba_min, prev_ba_conf, prev_eff_end = next_ba_min, next_ba_conf, next_eff_end

    conn.commit()
    cur.close()

    # -------------------------------------------------------------------------
    # Skip-reason summary table
    # -------------------------------------------------------------------------
    total_skips = sum(skip_reasons.values())
    print()
    print("  Settlement derivation — skip-reason summary")
    print(f"  {'Reason':<48} {'Count':>6}")
    print(f"  {'-'*48} {'-'*6}")
    if skip_reasons:
        for reason, count in sorted(skip_reasons.items(), key=lambda x: -x[1]):
            print(f"  {reason:<48} {count:>6,}")
    else:
        print("  (no skips)")
    print(f"  {'-'*48} {'-'*6}")
    print(f"  {'Contracts evaluated':<48} {contracts_evaluated:>6,}")
    print(f"  {'Total skip events':<48} {total_skips:>6,}")
    print(f"  {'Settlements inserted':<48} {settlements_inserted:>6,}")
    print()

    # -------------------------------------------------------------------------
    # Flagged-for-review table — implausible base % values (likely LLM misreads
    # of a dollar amount as a percent). These are NOT inserted; the source docs
    # should be re-extracted or reviewed by a human.
    # -------------------------------------------------------------------------
    if flagged_for_review:
        print(f"  Flagged for review — implausible base increase (|%| > {MAX_PLAUSIBLE_BASE_PCT:.0f}%)")
        print(f"  {'method':<14}{'district':>9}{'contract':>10}{'source_doc':>12}{'base_pct':>12}")
        print(f"  {'-'*57}")
        SHOW = 25
        for method, d_id, c_id, sd_id, bp in flagged_for_review[:SHOW]:
            print(f"  {method:<14}{str(d_id):>9}{str(c_id):>10}{str(sd_id):>12}{bp:>10.2f}%")
        if len(flagged_for_review) > SHOW:
            print(f"  ... and {len(flagged_for_review) - SHOW:,} more")
        print(f"  {'Total flagged for review':<48} {len(flagged_for_review):>6,}")
        print()
        log.warning(
            "%d contract(s) had an implausible base_increase_pct and were flagged "
            "for review instead of inserted", len(flagged_for_review),
        )

    log.info(
        "Settlements derived: %d (evaluated %d contracts, %d skip events)",
        settlements_inserted, contracts_evaluated, total_skips,
    )
    return settlements_inserted


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Phase 3 LLM extraction pipeline")
    parser.add_argument("--max-docs", type=int, default=0,
                        help="Max CBA PDFs to process (0 = unlimited)")
    parser.add_argument("--batch", type=int, default=0, dest="batch",
                        help="Alias for --max-docs: process at most N docs this run")
    parser.add_argument("--doc-id", type=int, default=None,
                        help="Process a specific source_document id only")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse PDFs and call LLM but do not write to DB")
    parser.add_argument("--cost-cap", type=float, default=0.0, metavar="USD",
                        help="Hard-stop when accumulated LLM cost exceeds USD (0 = no cap)")
    parser.add_argument("--priority", action="store_true",
                        help="Process contracts expiring 2026-2027 first (school_year >= 2023-24)")
    parser.add_argument("--derive-only", action="store_true",
                        help="Skip PDF extraction and LLM — re-run settlement derivation only")
    parser.add_argument("--retry-failed", action="store_true",
                        help="Requeue docs whose latest extraction run failed (no success run exists)")
    parser.add_argument("--state", type=str, default=None, metavar="STATE",
                        help="Restrict to districts in this state, e.g. IL or OH. "
                             "IL districts automatically use the IL-specific prompt (v1_il.txt).")
    args = parser.parse_args()

    conn = common.get_db_conn()

    # --derive-only: skip PDF extraction and LLM, jump straight to derivation
    if args.derive_only:
        log.info("--derive-only: skipping extraction, re-running settlement derivation")
        settlements_derived = derive_settlements(conn)
        conn.close()
        print("\n" + "=" * 60)
        print("  Derive-only run")
        print("=" * 60)
        print(f"  Settlements derived     : {settlements_derived:>8,}")
        print("=" * 60 + "\n")
        return

    if not PROMPT_FILE.exists():
        log.error("Prompt file not found: %s", PROMPT_FILE)
        sys.exit(1)

    # Load both OH and IL prompts so each doc can use the right one.
    oh_prompt = load_prompt()
    il_prompt: Optional[str] = None
    if IL_PROMPT_FILE.exists():
        il_prompt = IL_PROMPT_FILE.read_text(encoding="utf-8")
        log.info("IL prompt loaded from %s", IL_PROMPT_FILE)
    else:
        log.warning("IL prompt file not found (%s) — IL docs will fall back to OH prompt", IL_PROMPT_FILE)

    if args.retry_failed:
        docs = get_failed_docs(conn)
        log.info("--retry-failed: %d docs with no success run and at least one failed run", len(docs))
    else:
        docs = get_unprocessed_docs(conn, args.doc_id, priority=args.priority,
                                     state=args.state.upper() if args.state else None)
        state_label = f" (state={args.state.upper()})" if args.state else ""
        log.info("Unprocessed cba_pdf docs: %d%s%s", len(docs), state_label,
                 " (priority order: 2026-2027 expiries first)" if args.priority else "")

    max_docs = args.batch or args.max_docs
    if max_docs:
        docs = docs[:max_docs]
        log.info("Limiting to %d docs", max_docs)

    if args.cost_cap:
        log.info("Cost cap: $%.2f USD", args.cost_cap)

    attempts = 0
    successes = 0
    failures = 0
    contracts_inserted = 0
    provisions_inserted = 0
    audit_samples_marked = 0
    total_input_tokens = 0
    total_output_tokens = 0
    total_cost_usd = 0.0
    cost_cap_hit = False

    for row in docs:
        # Rows now carry a 6th column: district_state.  Tolerate old 5-col rows.
        source_doc_id, source_url, storage_key, district_id, school_year = row[:5]
        district_state: str = row[5] if len(row) > 5 else "OH"
        doc_unit: str = row[6] if len(row) > 6 else "teachers"
        doc_source_type: str = row[7] if len(row) > 7 else "pdf"

        # Pick the state-appropriate system prompt.
        is_il = district_state == "IL"
        system_prompt = (il_prompt if is_il and il_prompt else oh_prompt)
        prompt_ver    = (IL_PROMPT_VERSION if is_il and il_prompt else PROMPT_VERSION)

        # --- Cost cap check (before LLM call) ---
        if args.cost_cap and total_cost_usd >= args.cost_cap:
            log.warning(
                "Cost cap $%.2f reached (spent $%.4f) — stopping after %d docs",
                args.cost_cap, total_cost_usd, attempts,
            )
            cost_cap_hit = True
            break

        attempts += 1
        log.info(
            "[%d/%d] Processing doc %d (%s): %s",
            attempts, len(docs), source_doc_id, district_state,
            source_url or storage_key or "?"
        )

        is_html = doc_source_type == "html_contract"

        # --- Step 1 + 2: Resolve source file and extract text ---
        if is_html:
            # HTML-contract docs store the page's already-extracted text as a
            # .txt file — no PDF parsing or OCR needed.
            text_path = resolve_text_path(source_url or "", storage_key or "")
            if not text_path:
                log.warning("Cannot find HTML-contract text for doc %d — skipping",
                            source_doc_id)
                if not args.dry_run:
                    cur = conn.cursor()
                    insert_extraction_run(cur, source_doc_id, "failed", "HTML_NOT_FOUND")
                    conn.commit()
                    cur.close()
                failures += 1
                continue
            label = text_path.name
            try:
                text = text_path.read_text(encoding="utf-8", errors="ignore")
            except Exception as e:
                log.warning("Could not read HTML-contract text %s: %s", label, e)
                text = ""
            used_ocr = False
            ocr_confidence = None
            extract_reason = "" if text.strip() else "HTML_EMPTY"
        else:
            pdf_path = resolve_pdf_path(source_url or "", storage_key or "")
            if not pdf_path:
                log.warning("Cannot find PDF for doc %d — skipping", source_doc_id)
                if not args.dry_run:
                    cur = conn.cursor()
                    insert_extraction_run(cur, source_doc_id, "failed", "PDF_NOT_FOUND")
                    conn.commit()
                    cur.close()
                failures += 1
                continue
            label = pdf_path.name
            text, used_ocr, extract_reason, ocr_confidence = extract_pdf_text(pdf_path)

        # An OCR'd doc is low-quality (flag for human review) when its mean
        # tesseract word confidence falls below the trust threshold.
        ocr_low_quality = (
            used_ocr and ocr_confidence is not None and ocr_confidence < OCR_MIN_CONFIDENCE
        )
        if extract_reason or len(text) < MIN_TEXT_CHARS:
            reason = extract_reason or ("HTML_EMPTY" if is_html else "NO_TEXT_AFTER_OCR")
            log.warning("No usable text from %s (%s)", label, reason)
            if not args.dry_run:
                cur = conn.cursor()
                insert_extraction_run(
                    cur, source_doc_id, "failed", reason,
                    used_ocr=used_ocr, ocr_confidence=ocr_confidence,
                    ocr_low_quality=ocr_low_quality,
                )
                conn.commit()
                cur.close()
            failures += 1
            continue

        log.info("Extracted %d chars from %s%s", len(text), label,
                 " (OCR)" if used_ocr else (" (HTML)" if is_html else ""))
        if used_ocr:
            conf_str = f"{ocr_confidence:.1f}" if ocr_confidence is not None else "n/a"
            log.info(
                "OCR quality for %s: mean confidence=%s%s",
                label, conf_str,
                " — LOW QUALITY, flagged for review" if ocr_low_quality else "",
            )
        chunked_text = chunk_by_articles(text)

        if args.dry_run:
            log.info("[DRY RUN] Would call LLM for doc %d", source_doc_id)
            successes += 1
            continue

        cur = conn.cursor()
        run_id = insert_extraction_run(
            cur, source_doc_id, "pending", prompt_version=prompt_ver,
            used_ocr=used_ocr, ocr_confidence=ocr_confidence,
            ocr_low_quality=ocr_low_quality,
        )
        conn.commit()

        # --- Step 3: LLM call (with one retry) ---
        result = None
        last_error = None
        last_raw: Optional[str] = None
        doc_input_tokens = 0
        doc_output_tokens = 0
        for attempt in range(2):
            raw, in_tok, out_tok, stop_reason = call_anthropic(system_prompt, chunked_text)
            doc_input_tokens += in_tok
            doc_output_tokens += out_tok
            if raw is None:
                last_error = "LLM_API_ERROR"
                time.sleep(2 ** attempt)
                continue
            last_raw = raw

            # On the first attempt, if the model ran out of tokens, retry with a
            # short-form prompt asking for only the 30 highest-confidence provisions.
            if stop_reason == "max_tokens" and attempt == 0:
                log.warning(
                    "Doc %d hit max_tokens on attempt 1 — retrying with short-form prompt",
                    source_doc_id,
                )
                raw2, in_tok2, out_tok2, stop2 = call_anthropic(
                    system_prompt, chunked_text, short_form=True
                )
                doc_input_tokens += in_tok2
                doc_output_tokens += out_tok2
                if raw2:
                    last_raw = raw2
                    raw = raw2
                    stop_reason = stop2

            cleaned = extract_json_from_response(raw)
            result = validate_extraction(cleaned)
            if result is not None:
                break
            last_error = _classify_json_failure(cleaned, stop_reason)
            log.warning("Attempt %d: %s for doc %d", attempt + 1, last_error, source_doc_id)
            time.sleep(1)

        # Accumulate cost for this doc
        doc_cost = (
            doc_input_tokens * COST_PER_1M_INPUT_TOKENS
            + doc_output_tokens * COST_PER_1M_OUTPUT_TOKENS
        ) / 1_000_000
        total_input_tokens += doc_input_tokens
        total_output_tokens += doc_output_tokens
        total_cost_usd += doc_cost
        log.info(
            "Doc %d LLM usage: %d in + %d out tokens, $%.4f (running total: $%.4f)",
            source_doc_id, doc_input_tokens, doc_output_tokens, doc_cost, total_cost_usd,
        )

        if result is None:
            log.warning("Extraction failed for doc %d: %s", source_doc_id, last_error)
            # Persist the raw LLM output so it can be inspected offline
            if last_raw is not None:
                try:
                    FAILED_JSON_DIR.mkdir(parents=True, exist_ok=True)
                    out_path = FAILED_JSON_DIR / f"{source_doc_id}.txt"
                    out_path.write_text(last_raw, encoding="utf-8")
                    log.info("Raw LLM response saved to %s", out_path)
                except OSError as e:
                    log.warning("Could not write failed JSON log: %s", e)
            update_extraction_run(cur, run_id, "failed", last_error)
            conn.commit()
            cur.close()
            failures += 1
            continue

        # --- Step 4: DB insert + audit sampling ---
        contracts_list = result.contracts if PYDANTIC_OK else result.get("contracts", [])  # type: ignore[union-attr]
        doc_contracts = 0
        doc_provisions = 0
        doc_audit_samples = 0
        for c in contracts_list:
            contract_id = upsert_contract(cur, district_id, c, source_doc_id, doc_unit)
            if contract_id is None:
                continue
            conn.commit()
            doc_contracts += 1

            provisions = c.provisions if PYDANTIC_OK else c.get("provisions", [])  # type: ignore[union-attr]
            n = insert_provisions(cur, contract_id, provisions)
            doc_provisions += n
            conn.commit()

            # Flag a random 5% of high-confidence provisions for human audit
            n_audit = mark_audit_samples(cur, contract_id)
            doc_audit_samples += n_audit
            conn.commit()

        contracts_inserted += doc_contracts
        provisions_inserted += doc_provisions
        audit_samples_marked += doc_audit_samples
        update_extraction_run(cur, run_id, "success")
        conn.commit()
        cur.close()
        successes += 1

        log.info(
            "Doc %d done: %d contracts, %d provisions (%d audit samples)",
            source_doc_id, doc_contracts, doc_provisions, doc_audit_samples,
        )
        # Be polite to the API
        time.sleep(0.5)

    # --- Step 5: Derive settlements ---
    settlements_derived = 0
    if not args.dry_run and successes > 0:
        log.info("Deriving settlements…")
        settlements_derived = derive_settlements(conn)

    conn.close()

    # Summary
    print("\n" + "=" * 60)
    print("  Phase 3 Extraction Summary")
    print("=" * 60)
    print(f"  Docs attempted          : {attempts:>8,}")
    print(f"  Successes               : {successes:>8,}")
    print(f"  Failures                : {failures:>8,}")
    print(f"  Contracts inserted      : {contracts_inserted:>8,}")
    print(f"  Provisions inserted     : {provisions_inserted:>8,}")
    print(f"  Audit samples flagged   : {audit_samples_marked:>8,}")
    print(f"  Settlements derived     : {settlements_derived:>8,}")
    print(f"  LLM input tokens        : {total_input_tokens:>8,}")
    print(f"  LLM output tokens       : {total_output_tokens:>8,}")
    print(f"  Estimated LLM cost      :  ${total_cost_usd:>8.4f} USD")
    if cost_cap_hit:
        print(f"  [STOPPED: cost cap ${args.cost_cap:.2f} reached]")
    if args.dry_run:
        print("  [DRY RUN — no DB writes]")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
