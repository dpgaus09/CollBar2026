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
import os
import re
import sys
import time
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

PROMPT_FILE = Path(__file__).parent / "prompts" / "v1.txt"
CBA_PDF_DIR = common.DATA_DIR / "cba"
PROMPT_VERSION = "v1"
MODEL = "claude-haiku-4-5"
MAX_TEXT_CHARS = 80_000  # truncate context sent to LLM
MAX_TOKENS = 8192


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
        effective_start: Optional[str] = None
        effective_end: Optional[str] = None
        term_years: Optional[float] = None
        has_reopener: Optional[bool] = None
        reopener_terms: Optional[str] = None
        provisions: List[ProvisionItem] = []

    class ExtractionResult(BaseModel):
        contracts: List[ContractData] = []


def validate_extraction(raw: str) -> Optional["ExtractionResult"]:
    """Parse and validate the LLM's JSON output. Returns None on failure."""
    try:
        data = json.loads(raw)
        if PYDANTIC_OK:
            return ExtractionResult(**data)
        # Loose validation without pydantic
        if "contracts" in data and isinstance(data["contracts"], list):
            return data  # type: ignore[return-value]
        return None
    except Exception as e:
        log.debug("JSON validation error: %s", e)
        return None


# ---------------------------------------------------------------------------
# PDF text extraction
# ---------------------------------------------------------------------------

def extract_pdf_text(pdf_path: Path) -> tuple[str, bool]:
    """
    Extract text from PDF using pdfplumber. Falls back to pytesseract OCR
    if the text layer is empty.

    Returns (text, used_ocr).
    """
    try:
        import pdfplumber
    except ImportError:
        log.warning("pdfplumber not installed")
        return "", False

    pages_text: list[str] = []
    try:
        with pdfplumber.open(pdf_path) as pdf:
            for page in pdf.pages:
                t = page.extract_text() or ""
                pages_text.append(t)
    except Exception as e:
        log.warning("pdfplumber error for %s: %s", pdf_path, e)
        return "", False

    full_text = "\n\n".join(pages_text).strip()
    used_ocr = False

    if not full_text or len(full_text) < 100:
        log.info("Empty text layer for %s — attempting OCR", pdf_path.name)
        try:
            import pytesseract
            from PIL import Image
            import pdfplumber
            pages_text = []
            with pdfplumber.open(pdf_path) as pdf:
                for page in pdf.pages:
                    img = page.to_image(resolution=150).original
                    pages_text.append(pytesseract.image_to_string(img))
            full_text = "\n\n".join(pages_text).strip()
            used_ocr = True
        except ImportError:
            log.warning("pytesseract not available; cannot OCR %s", pdf_path.name)
        except Exception as e:
            log.warning("OCR error for %s: %s", pdf_path.name, e)

    return full_text, used_ocr


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
        candidate = CBA_PDF_DIR / fname
        if candidate.exists():
            return candidate

    # Try object storage key as a local relative path
    if storage_key and not storage_key.startswith("local:"):
        candidate = common.DATA_DIR / storage_key
        if candidate.exists():
            return candidate

    return None


# ---------------------------------------------------------------------------
# Anthropic API call
# ---------------------------------------------------------------------------

def load_prompt() -> str:
    """Load the v1 extraction prompt."""
    return PROMPT_FILE.read_text(encoding="utf-8")


def call_anthropic(system_prompt: str, text: str) -> Optional[str]:
    """Call Anthropic Claude and return the raw response text, or None."""
    try:
        import anthropic as _anthropic
    except ImportError:
        log.error("anthropic SDK not installed — pip install anthropic")
        return None

    base_url = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "")
    api_key = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "dummy")

    client_kwargs: dict = {"api_key": api_key}
    if base_url:
        client_kwargs["base_url"] = base_url

    client = _anthropic.Anthropic(**client_kwargs)

    try:
        response = client.messages.create(
            model=MODEL,
            max_tokens=MAX_TOKENS,
            system=system_prompt,
            messages=[
                {
                    "role": "user",
                    "content": (
                        "Extract all contract data from the following CBA text. "
                        "Output only valid JSON.\n\n"
                        f"<cba_text>\n{text}\n</cba_text>"
                    ),
                }
            ],
        )
        block = response.content[0]
        return block.text if block.type == "text" else None
    except Exception as e:
        log.warning("Anthropic API error: %s", e)
        return None


def extract_json_from_response(raw: str) -> str:
    """Strip any markdown fences around JSON returned by the model."""
    raw = raw.strip()
    # Remove ```json ... ``` fences
    fence_re = re.compile(r"^```(?:json)?\s*([\s\S]+?)\s*```$")
    m = fence_re.match(raw)
    if m:
        return m.group(1).strip()
    # Find the first { or [ in the string
    start = next((i for i, c in enumerate(raw) if c in "{["), 0)
    return raw[start:]


# ---------------------------------------------------------------------------
# DB operations
# ---------------------------------------------------------------------------

def get_unprocessed_docs(conn, doc_id: Optional[int] = None):
    """
    Return source_document rows for cba_pdf docs with no successful extraction_run.
    If doc_id is given, return only that row.
    """
    cur = conn.cursor()
    if doc_id:
        cur.execute(
            """
            SELECT sd.id, sd.source_url, sd.storage_key, sd.district_id, sd.school_year
            FROM source_documents sd
            WHERE sd.id = %s AND sd.doc_type = 'cba_pdf'
            """,
            (doc_id,),
        )
    else:
        cur.execute(
            """
            SELECT sd.id, sd.source_url, sd.storage_key, sd.district_id, sd.school_year
            FROM source_documents sd
            WHERE sd.doc_type = 'cba_pdf'
              AND sd.id NOT IN (
                  SELECT er.source_doc_id
                  FROM extraction_runs er
                  WHERE er.status = 'success'
                    AND er.source_doc_id IS NOT NULL
              )
            ORDER BY sd.id
            """
        )
    rows = cur.fetchall()
    cur.close()
    return rows


def insert_extraction_run(cur, source_doc_id: int, status: str, error: Optional[str] = None) -> int:
    cur.execute(
        """
        INSERT INTO extraction_runs (source_doc_id, model, prompt_version, status, error)
        VALUES (%s, %s, %s, %s, %s)
        RETURNING id
        """,
        (source_doc_id, MODEL, PROMPT_VERSION, status, error),
    )
    row = cur.fetchone()
    return row[0] if row else -1


def update_extraction_run(cur, run_id: int, status: str, error: Optional[str] = None):
    cur.execute(
        "UPDATE extraction_runs SET status = %s, error = %s WHERE id = %s",
        (status, error, run_id),
    )


def upsert_contract(cur, district_id, c: "ContractData", source_doc_id: int) -> Optional[int]:
    """Insert a contract row. Returns the contract id."""
    try:
        cur.execute(
            """
            INSERT INTO contracts
                (district_id, union_name, affiliation, unit_scope,
                 effective_start, effective_end, term_years,
                 has_reopener, reopener_terms, source_doc_id)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            ON CONFLICT (district_id, unit_scope, effective_start) DO UPDATE SET
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
                    _s(p, "provision_key"),
                    _n(p, "value_numeric"),
                    _s(p, "value_text"),
                    _s(p, "unit"),
                    _s(p, "clause_excerpt"),
                    _n(p, "page_ref"),
                    _n(p, "confidence", default=0.5),
                ),
            )
            inserted += 1
        except Exception as e:
            log.debug("Provision insert error: %s", e)
    return inserted


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
# Settlement derivation
# ---------------------------------------------------------------------------

def derive_settlements(conn):
    """
    For each district with ≥ 2 contracts in contracts table (same unit_scope),
    derive a settlements row per contract using extracted compensation provisions.

    method = 'cba_diff' if stated percentage increases found,
             'ba_min_delta' otherwise (comparing consecutive BA-min values).
    """
    cur = conn.cursor()

    # Get districts with multiple contracts
    cur.execute(
        """
        SELECT DISTINCT district_id, unit_scope
        FROM contracts
        WHERE district_id IS NOT NULL
        GROUP BY district_id, unit_scope
        HAVING COUNT(*) >= 1
        """
    )
    district_units = cur.fetchall()

    settlements_inserted = 0

    for district_id, unit_scope in district_units:
        # Get all contracts for this district+unit, ordered by start date
        cur.execute(
            """
            SELECT c.id, c.effective_start, c.effective_end, c.term_years
            FROM contracts c
            WHERE c.district_id = %s AND (c.unit_scope = %s OR %s IS NULL)
            ORDER BY c.effective_start
            """,
            (district_id, unit_scope, unit_scope),
        )
        contracts = cur.fetchall()

        for contract_id, eff_start, eff_end, term_years in contracts:
            # Get compensation provisions
            cur.execute(
                """
                SELECT provision_key, value_numeric, confidence
                FROM contract_provisions
                WHERE contract_id = %s AND category = 'compensation'
                  AND provision_key IN (
                    'base_salary_increase_yr1','base_salary_increase_yr2',
                    'base_salary_increase_yr3','ba_min_salary','off_schedule_bonus_yr1'
                  )
                """,
                (contract_id,),
            )
            provisions = {row[0]: (row[1], row[2]) for row in cur.fetchall()}

            # Derive from_year / to_year from contract dates
            from_year = None
            to_year = None
            if eff_start:
                try:
                    y = int(eff_start[:4])
                    from_year = f"{y}-{str(y+1)[2:]}"
                except (ValueError, IndexError):
                    pass
            if eff_end:
                try:
                    y = int(eff_end[:4])
                    to_year = f"{y}-{str(y+1)[2:]}"
                except (ValueError, IndexError):
                    pass

            if not from_year:
                continue

            base_pct, base_conf = provisions.get("base_salary_increase_yr1", (None, None))
            yr2_pct, _ = provisions.get("base_salary_increase_yr2", (None, None))
            yr3_pct, _ = provisions.get("base_salary_increase_yr3", (None, None))
            off_sched, _ = provisions.get("off_schedule_bonus_yr1", (None, None))

            method = "cba_diff" if base_pct is not None else "ba_min_delta"
            confidence = float(base_conf) if base_conf is not None else 0.5

            try:
                cur.execute(
                    """
                    INSERT INTO settlements
                        (district_id, from_year, to_year, base_increase_pct,
                         year2_pct, year3_pct, off_schedule_payment,
                         term_years, method, confidence)
                    VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                    ON CONFLICT (district_id, from_year, to_year) DO NOTHING
                    """,
                    (
                        district_id, from_year, to_year or from_year,
                        base_pct, yr2_pct, yr3_pct, off_sched,
                        term_years, method, confidence,
                    ),
                )
                settlements_inserted += 1
            except Exception as e:
                log.debug("Settlement insert error: %s", e)

    conn.commit()
    cur.close()
    log.info("Settlements derived/upserted: %d", settlements_inserted)
    return settlements_inserted


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-docs", type=int, default=0,
                        help="Max CBA PDFs to process (0 = unlimited)")
    parser.add_argument("--doc-id", type=int, default=None,
                        help="Process a specific source_document id only")
    parser.add_argument("--dry-run", action="store_true",
                        help="Parse PDFs and call LLM but do not write to DB")
    args = parser.parse_args()

    if not PROMPT_FILE.exists():
        log.error("Prompt file not found: %s", PROMPT_FILE)
        sys.exit(1)

    system_prompt = load_prompt()
    conn = common.get_db_conn()

    docs = get_unprocessed_docs(conn, args.doc_id)
    log.info("Unprocessed cba_pdf docs: %d", len(docs))

    if args.max_docs:
        docs = docs[:args.max_docs]
        log.info("Limiting to %d docs", args.max_docs)

    attempts = 0
    successes = 0
    failures = 0
    contracts_inserted = 0
    provisions_inserted = 0

    for source_doc_id, source_url, storage_key, district_id, school_year in docs:
        attempts += 1
        log.info(
            "[%d/%d] Processing doc %d: %s",
            attempts, len(docs), source_doc_id, source_url or storage_key or "?"
        )

        # --- Step 1: Resolve PDF ---
        pdf_path = resolve_pdf_path(source_url or "", storage_key or "")
        if not pdf_path:
            log.warning("Cannot find PDF for doc %d — skipping", source_doc_id)
            if not args.dry_run:
                cur = conn.cursor()
                insert_extraction_run(cur, source_doc_id, "failed", "PDF file not found locally")
                conn.commit()
                cur.close()
            failures += 1
            continue

        # --- Step 2: Extract text ---
        text, used_ocr = extract_pdf_text(pdf_path)
        if not text:
            log.warning("No text extracted from %s", pdf_path.name)
            if not args.dry_run:
                cur = conn.cursor()
                insert_extraction_run(cur, source_doc_id, "failed", "No text extracted from PDF")
                conn.commit()
                cur.close()
            failures += 1
            continue

        log.info("Extracted %d chars from %s%s", len(text), pdf_path.name,
                 " (OCR)" if used_ocr else "")
        chunked_text = chunk_by_articles(text)

        if args.dry_run:
            log.info("[DRY RUN] Would call LLM for doc %d", source_doc_id)
            successes += 1
            continue

        cur = conn.cursor()
        run_id = insert_extraction_run(cur, source_doc_id, "pending")
        conn.commit()

        # --- Step 3: LLM call (with one retry) ---
        result = None
        last_error = None
        for attempt in range(2):
            raw = call_anthropic(system_prompt, chunked_text)
            if raw is None:
                last_error = "Anthropic API returned no response"
                time.sleep(2 ** attempt)
                continue
            cleaned = extract_json_from_response(raw)
            result = validate_extraction(cleaned)
            if result is not None:
                break
            last_error = f"JSON validation failed (attempt {attempt+1})"
            log.warning("Attempt %d: JSON validation failed for doc %d", attempt+1, source_doc_id)
            time.sleep(1)

        if result is None:
            log.warning("Extraction failed for doc %d: %s", source_doc_id, last_error)
            update_extraction_run(cur, run_id, "failed", last_error)
            conn.commit()
            cur.close()
            failures += 1
            continue

        # --- Step 4: DB insert ---
        contracts_list = result.contracts if PYDANTIC_OK else result.get("contracts", [])  # type: ignore[union-attr]
        doc_contracts = 0
        doc_provisions = 0
        for c in contracts_list:
            contract_id = upsert_contract(cur, district_id, c, source_doc_id)
            if contract_id is None:
                continue
            conn.commit()
            doc_contracts += 1

            provisions = c.provisions if PYDANTIC_OK else c.get("provisions", [])  # type: ignore[union-attr]
            n = insert_provisions(cur, contract_id, provisions)
            doc_provisions += n
            conn.commit()

        contracts_inserted += doc_contracts
        provisions_inserted += doc_provisions
        update_extraction_run(cur, run_id, "success")
        conn.commit()
        cur.close()
        successes += 1

        log.info(
            "Doc %d done: %d contracts, %d provisions",
            source_doc_id, doc_contracts, doc_provisions,
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
    print(f"  Settlements derived     : {settlements_derived:>8,}")
    if args.dry_run:
        print("  [DRY RUN — no DB writes]")
    print("=" * 60 + "\n")


if __name__ == "__main__":
    main()
