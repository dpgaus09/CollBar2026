#!/usr/bin/env python3
"""
Phase 3b — ELRB final-offer extraction & diff.

For each final_offer_postings row, read the district and union offer PDFs,
extract each side's per-topic bargaining position with the LLM (prompt
``prompts/v1_il_offer.txt``), and persist them to ``final_offer_items``. Then
pair the two sides by topic and persist a board-vs-union ``final_offer_comparisons``
row per topic (aligned | diff | district_only | union_only) with a signed numeric
gap (union - district) when both sides are quantitative and share a unit.

PDF text extraction, OCR, the Anthropic client config, JSON repair, and the
extraction_runs logging are reused from ``06_extract_contracts.py`` so the two
extractors stay consistent.

Usage:
    python3 pipeline/19_extract_final_offers.py [--posting-id N] [--case CASE]
        [--max-postings N] [--recompute-only] [--force] [--dry-run]

    --posting-id N     only process this final_offer_postings.id
    --case CASE        only process this ELRB case number (e.g. 2026-IM-0007-C)
    --max-postings N   cap how many postings are processed this run
    --recompute-only   skip LLM extraction; only (re)build comparisons from
                       existing final_offer_items
    --force            re-extract a side even if it already has items / a
                       successful extraction_run
    --dry-run          parse + call LLM but write nothing to the DB
"""
import argparse
import importlib.util
import json
import logging
import os
import sys
from pathlib import Path
from typing import Optional

sys.path.insert(0, str(Path(__file__).parent))
import common

common.setup_logging()
log = logging.getLogger(__name__)

# Reuse the contract extractor's PDF/OCR/LLM/JSON/logging helpers. The module
# filename starts with a digit so it must be loaded by path, not `import`.
_spec = importlib.util.spec_from_file_location(
    "extract06", Path(__file__).parent / "06_extract_contracts.py"
)
extract06 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(extract06)

PROMPT_FILE = Path(__file__).parent / "prompts" / "v1_il_offer.txt"
PROMPT_VERSION = "v1_il_offer"
MODEL = extract06.MODEL
MAX_TOKENS = extract06.MAX_TOKENS
MAX_TEXT_CHARS = extract06.MAX_TEXT_CHARS

SIDES = ("district", "union")

# Closed topic vocabulary — MUST match prompts/v1_il_offer.txt. Items the LLM
# returns with an unknown topic are coerced to 'other'.
TOPICS = {
    "salary",
    "insurance",
    "retirement",
    "stipends",
    "leave",
    "workday",
    "work_year",
    "class_size",
    "evaluation",
    "grievance",
    "layoff_rif",
    "seniority",
    "term",
    "other",
}

NUMERIC_UNITS = {"percent", "usd", "years", "days", "ratio"}

# Per-unit tolerance below which two numeric positions count as "aligned"
# rather than a genuine difference. ELRB salary offers a few hundredths of a
# percent apart are effectively the same ask.
ALIGN_TOLERANCE = {
    "percent": 0.05,
    "usd": 1.0,
    "years": 0.0,
    "days": 0.0,
    "ratio": 0.01,
}

# ---------------------------------------------------------------------------
# Pydantic schema for the offer LLM response
# ---------------------------------------------------------------------------
try:
    from pydantic import BaseModel, Field, field_validator
    PYDANTIC_OK = True
except ImportError:  # pragma: no cover - pydantic ships in the repl
    log.warning("pydantic not installed — offer JSON validated loosely")
    PYDANTIC_OK = False

if PYDANTIC_OK:
    from typing import List, Optional as Opt

    class OfferItem(BaseModel):
        topic: str = "other"
        topic_label: Opt[str] = None
        summary: Opt[str] = None
        numeric_value: Opt[float] = None
        numeric_unit: Opt[str] = None
        raw_text: Opt[str] = None

        @field_validator("topic")
        @classmethod
        def known_topic(cls, v: str) -> str:
            v = (v or "").strip().lower().replace(" ", "_").replace("-", "_")
            return v if v in TOPICS else "other"

        @field_validator("numeric_unit")
        @classmethod
        def known_unit(cls, v):
            if v is None:
                return None
            v = v.strip().lower()
            return v if v in NUMERIC_UNITS else None

        @field_validator("summary", "raw_text")
        @classmethod
        def strip_blank(cls, v):
            if v is None:
                return None
            v = v.strip()
            return v or None

    class OfferResult(BaseModel):
        items: List[OfferItem] = []


def load_prompt() -> str:
    return PROMPT_FILE.read_text(encoding="utf-8")


def call_offer_llm(system_prompt: str, text: str):
    """Call Claude for one side's offer. Returns (raw, in_tok, out_tok, stop)."""
    try:
        import anthropic as _anthropic
    except ImportError:
        log.error("anthropic SDK not installed")
        return None, 0, 0, None

    base_url = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_BASE_URL", "")
    api_key = os.environ.get("AI_INTEGRATIONS_ANTHROPIC_API_KEY", "dummy")
    client_kwargs: dict = {"api_key": api_key}
    if base_url:
        client_kwargs["base_url"] = base_url
    client = _anthropic.Anthropic(**client_kwargs)

    user_content = (
        "Extract this party's bargaining positions from the final offer below. "
        "Output only valid JSON.\n\n"
        f"<final_offer>\n{text}\n</final_offer>"
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
    except Exception as e:  # noqa: BLE001
        log.warning("Anthropic API error: %s", e)
        return None, 0, 0, None


def validate_offer(raw: str):
    """Parse + validate the LLM JSON. Returns OfferResult or None."""
    cleaned = extract06.extract_json_from_response(raw)
    try:
        data = json.loads(cleaned)
    except Exception:
        return None
    # Tolerate a bare list as well as {"items": [...]}.
    if isinstance(data, list):
        data = {"items": data}
    if not isinstance(data, dict):
        return None
    if PYDANTIC_OK:
        try:
            return OfferResult(**data)
        except Exception as e:  # noqa: BLE001
            log.warning("Offer schema validation failed: %s", e)
            return None
    # Loose fallback
    items = data.get("items") if isinstance(data.get("items"), list) else []
    return type("LooseResult", (), {"items": items})()


# ---------------------------------------------------------------------------
# DB helpers
# ---------------------------------------------------------------------------

def get_postings(conn, *, posting_id=None, case=None, limit=None):
    """Return (id, case_number, district_source_doc_id, union_source_doc_id)."""
    cur = conn.cursor()
    where = []
    params: list = []
    if posting_id:
        where.append("id = %s")
        params.append(posting_id)
    if case:
        where.append("case_number = %s")
        params.append(case)
    where_sql = ("WHERE " + " AND ".join(where)) if where else ""
    limit_sql = f"LIMIT {int(limit)}" if limit else ""
    cur.execute(
        f"""
        SELECT id, case_number, district_source_doc_id, union_source_doc_id
        FROM final_offer_postings
        {where_sql}
        ORDER BY id
        {limit_sql}
        """,
        tuple(params),
    )
    rows = cur.fetchall()
    cur.close()
    return rows


def get_source_doc(conn, doc_id):
    """Return (source_url, storage_key) for a source_documents row, or None."""
    if doc_id is None:
        return None
    cur = conn.cursor()
    cur.execute(
        "SELECT source_url, storage_key FROM source_documents WHERE id = %s",
        (doc_id,),
    )
    row = cur.fetchone()
    cur.close()
    return row


def side_has_items(conn, posting_id, side) -> bool:
    cur = conn.cursor()
    cur.execute(
        "SELECT 1 FROM final_offer_items WHERE posting_id = %s AND side = %s LIMIT 1",
        (posting_id, side),
    )
    found = cur.fetchone() is not None
    cur.close()
    return found


def replace_items(cur, posting_id, side, source_doc_id, items) -> int:
    """Delete this side's existing items for the posting, then insert fresh.

    Returns the number of rows inserted. De-dupes on topic (the table has a
    unique(posting_id, side, topic) constraint).
    """
    cur.execute(
        "DELETE FROM final_offer_items WHERE posting_id = %s AND side = %s",
        (posting_id, side),
    )
    seen = set()
    inserted = 0
    for it in items:
        topic = getattr(it, "topic", None) or (it.get("topic") if isinstance(it, dict) else None) or "other"
        if topic in seen:
            continue
        seen.add(topic)

        def g(name):
            return getattr(it, name, None) if not isinstance(it, dict) else it.get(name)

        cur.execute(
            """
            INSERT INTO final_offer_items
                (posting_id, side, topic, topic_label, summary,
                 numeric_value, numeric_unit, raw_text, source_doc_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                posting_id, side, topic, g("topic_label"), g("summary"),
                g("numeric_value"), g("numeric_unit"), g("raw_text"), source_doc_id,
            ),
        )
        inserted += 1
    return inserted


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def extract_side(conn, posting_id, case_number, side, source_doc_id, *,
                 system_prompt, force=False, dry_run=False) -> Optional[int]:
    """Extract one side's offer. Returns #items written, or None on failure/skip."""
    if source_doc_id is None:
        log.warning("  [%s] %s: no source_doc_id — skipping", case_number, side)
        return None

    if not force and side_has_items(conn, posting_id, side):
        log.info("  [%s] %s: already has items — skipping (use --force)", case_number, side)
        return 0

    doc = get_source_doc(conn, source_doc_id)
    if not doc:
        log.warning("  [%s] %s: source_documents %s missing", case_number, side, source_doc_id)
        return None
    source_url, storage_key = doc
    pdf_path = extract06.resolve_pdf_path(source_url or "", storage_key or "")
    if not pdf_path:
        log.warning("  [%s] %s: PDF not found (url=%s key=%s)", case_number, side, source_url, storage_key)
        if not dry_run:
            cur = conn.cursor()
            extract06.insert_extraction_run(
                cur, source_doc_id, "failure",
                error="PDF_NOT_FOUND", prompt_version=PROMPT_VERSION,
            )
            conn.commit()
            cur.close()
        return None

    text, used_ocr, reason, ocr_conf = extract06.extract_pdf_text(pdf_path)
    if reason or len(text) < extract06.MIN_TEXT_CHARS:
        log.warning("  [%s] %s: text extraction failed (%s)", case_number, side, reason or "TOO_SHORT")
        if not dry_run:
            cur = conn.cursor()
            extract06.insert_extraction_run(
                cur, source_doc_id, "failure",
                error=reason or "NO_TEXT", prompt_version=PROMPT_VERSION,
                used_ocr=used_ocr, ocr_confidence=ocr_conf,
            )
            conn.commit()
            cur.close()
        return None

    text = text[:MAX_TEXT_CHARS]
    ocr_low = bool(used_ocr and ocr_conf is not None and ocr_conf < extract06.OCR_MIN_CONFIDENCE)

    raw, in_tok, out_tok, stop = call_offer_llm(system_prompt, text)
    if not raw:
        log.warning("  [%s] %s: LLM returned nothing", case_number, side)
        if not dry_run:
            cur = conn.cursor()
            extract06.insert_extraction_run(
                cur, source_doc_id, "failure", error="LLM_NO_RESPONSE",
                prompt_version=PROMPT_VERSION, used_ocr=used_ocr,
                ocr_confidence=ocr_conf, ocr_low_quality=ocr_low,
            )
            conn.commit()
            cur.close()
        return None

    result = validate_offer(raw)
    if result is None:
        log.warning("  [%s] %s: JSON validation failed", case_number, side)
        if not dry_run:
            cur = conn.cursor()
            extract06.insert_extraction_run(
                cur, source_doc_id, "failure", error="LLM_SCHEMA_INVALID",
                prompt_version=PROMPT_VERSION, used_ocr=used_ocr,
                ocr_confidence=ocr_conf, ocr_low_quality=ocr_low,
            )
            conn.commit()
            cur.close()
        return None

    items = result.items
    log.info(
        "  [%s] %s: %d item(s) [ocr=%s conf=%s tok=%d/%d]",
        case_number, side, len(items), used_ocr,
        f"{ocr_conf:.0f}" if ocr_conf is not None else "-", in_tok, out_tok,
    )
    if dry_run:
        for it in items:
            log.info("      - %s: %s", getattr(it, "topic", "?"), getattr(it, "summary", ""))
        return len(items)

    cur = conn.cursor()
    n = replace_items(cur, posting_id, side, source_doc_id, items)
    extract06.insert_extraction_run(
        cur, source_doc_id, "success", prompt_version=PROMPT_VERSION,
        used_ocr=used_ocr, ocr_confidence=ocr_conf, ocr_low_quality=ocr_low,
    )
    conn.commit()
    cur.close()
    return n


# ---------------------------------------------------------------------------
# Diff / alignment
# ---------------------------------------------------------------------------

def _num(v):
    if v is None:
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# Minimum normalized length before a fuzzy ratio is trusted, and the ratio at or
# above which two qualitative positions count as the same (agreed) language.
_TEXT_ALIGN_MIN_LEN = 16
_TEXT_ALIGN_RATIO = 0.90


def _normalize_text(s) -> str:
    """Lowercase, keep words/numbers/%/$/./-, and collapse whitespace.

    Side framing words ("board"/"union"/"district"/"proposes"/...) are dropped so
    that two offers that reproduce the same agreed clause compare as equal even
    though each PDF frames it from its own side.
    """
    import re
    if not s:
        return ""
    s = s.lower()
    s = re.sub(r"[^a-z0-9%$./\- ]+", " ", s)
    tokens = [t for t in s.split() if t not in _SIDE_FRAMING_WORDS]
    return " ".join(tokens)


def _digits(s: str):
    """Ordered list of the numbers embedded in a normalized string."""
    import re
    return re.findall(r"\d+(?:\.\d+)?", s or "")


_SIDE_FRAMING_WORDS = {
    "board", "boards", "union", "unions", "district", "districts",
    "employer", "association", "proposes", "proposal", "proposed",
    "offer", "offers", "position", "shall", "will",
}


def _text_aligned(a, b) -> bool:
    """True when two qualitative positions express materially the same term.

    Conservative on purpose: differing embedded numbers (e.g. "3 days" vs
    "5 days") never align, very short strings are not fuzzily matched, and the
    fuzzy threshold is high so genuinely different positions stay "diff".
    """
    from difflib import SequenceMatcher
    na, nb = _normalize_text(a), _normalize_text(b)
    if not na or not nb:
        return False
    if _digits(na) != _digits(nb):
        return False
    if na == nb:
        return True
    if len(na) < _TEXT_ALIGN_MIN_LEN or len(nb) < _TEXT_ALIGN_MIN_LEN:
        return False
    return SequenceMatcher(None, na, nb).ratio() >= _TEXT_ALIGN_RATIO


def classify_pair(d: dict, u: dict):
    """Classify a district vs union position pair for one topic.

    Returns ``(status, gap, gap_unit)`` where status is "aligned" or "diff".

    - When both sides give a number in the same unit, alignment is numeric:
      within the per-unit tolerance is "aligned", otherwise a genuine "diff"
      (a real numeric gap is never overridden by language similarity).
    - Otherwise (no comparable numbers — a qualitative topic) the verbatim
      offer language, then the summary, decide alignment.
    """
    dv, uv = d.get("value"), u.get("value")
    du = (d.get("unit") or "").strip().lower() or None
    uu = (u.get("unit") or "").strip().lower() or None
    if dv is not None and uv is not None and du and du == uu:
        gap = uv - dv
        tol = ALIGN_TOLERANCE.get(du, 0.0)
        return ("aligned" if abs(gap) <= tol else "diff"), gap, du
    if _text_aligned(d.get("raw_text"), u.get("raw_text")) or \
            _text_aligned(d.get("summary"), u.get("summary")):
        return "aligned", None, None
    return "diff", None, None


def compute_comparisons(conn, posting_id, case_number, *, dry_run=False) -> int:
    """Pair district vs union items by topic; rebuild final_offer_comparisons.

    Returns the number of comparison rows written.
    """
    cur = conn.cursor()
    cur.execute(
        """
        SELECT id, side, topic, topic_label, summary, numeric_value, numeric_unit, raw_text
        FROM final_offer_items
        WHERE posting_id = %s
        """,
        (posting_id,),
    )
    rows = cur.fetchall()
    by_topic: dict = {}
    for (item_id, side, topic, topic_label, summary, numeric_value, numeric_unit, raw_text) in rows:
        slot = by_topic.setdefault(topic, {"label": topic_label})
        slot[side] = {
            "id": item_id,
            "label": topic_label,
            "summary": summary,
            "raw_text": raw_text,
            "value": _num(numeric_value),
            "unit": (numeric_unit or "").strip().lower() or None,
        }
        if topic_label and not slot.get("label"):
            slot["label"] = topic_label

    comparisons = []
    for topic, slot in by_topic.items():
        d = slot.get("district")
        u = slot.get("union")
        label = slot.get("label") or (d or u or {}).get("label") if (d or u) else slot.get("label")
        if d and u:
            status, gap, gap_unit = classify_pair(d, u)
            comparisons.append((
                topic, label, status, d["id"], u["id"],
                d["summary"], u["summary"], gap, gap_unit,
            ))
        elif d:
            comparisons.append((
                topic, label, "district_only", d["id"], None,
                d["summary"], None, None, None,
            ))
        elif u:
            comparisons.append((
                topic, label, "union_only", None, u["id"],
                None, u["summary"], None, None,
            ))

    if dry_run:
        for c in comparisons:
            log.info("      cmp %-12s %-13s gap=%s%s", c[0], c[2],
                     c[7] if c[7] is not None else "-", f" {c[8]}" if c[8] else "")
        cur.close()
        return len(comparisons)

    cur.execute("DELETE FROM final_offer_comparisons WHERE posting_id = %s", (posting_id,))
    for (topic, label, status, d_id, u_id, d_sum, u_sum, gap, gap_unit) in comparisons:
        cur.execute(
            """
            INSERT INTO final_offer_comparisons
                (posting_id, topic, topic_label, status, district_item_id,
                 union_item_id, district_summary, union_summary, numeric_gap, gap_unit)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (posting_id, topic, label, status, d_id, u_id, d_sum, u_sum, gap, gap_unit),
        )
    conn.commit()
    cur.close()
    log.info("  [%s] comparisons: %d row(s)", case_number, len(comparisons))
    return len(comparisons)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser(description="Extract & diff ELRB final offers.")
    ap.add_argument("--posting-id", type=int, default=None)
    ap.add_argument("--case", type=str, default=None)
    ap.add_argument("--max-postings", type=int, default=None)
    ap.add_argument("--recompute-only", action="store_true",
                    help="skip LLM extraction; only rebuild comparisons")
    ap.add_argument("--force", action="store_true",
                    help="re-extract sides that already have items")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    conn = common.get_db_conn()
    postings = get_postings(conn, posting_id=args.posting_id, case=args.case,
                            limit=args.max_postings)
    if not postings:
        log.info("No matching final_offer_postings.")
        conn.close()
        return

    system_prompt = load_prompt()
    log.info("Processing %d posting(s)%s", len(postings),
             " [dry-run]" if args.dry_run else "")

    totals = {"items": 0, "comparisons": 0, "sides_ok": 0, "sides_failed": 0}
    for (posting_id, case_number, d_doc, u_doc) in postings:
        log.info("Posting id=%s case=%s", posting_id, case_number)
        if not args.recompute_only:
            for side, doc_id in (("district", d_doc), ("union", u_doc)):
                n = extract_side(
                    conn, posting_id, case_number, side, doc_id,
                    system_prompt=system_prompt, force=args.force,
                    dry_run=args.dry_run,
                )
                if n is None:
                    totals["sides_failed"] += 1
                else:
                    totals["sides_ok"] += 1
                    totals["items"] += n
        totals["comparisons"] += compute_comparisons(
            conn, posting_id, case_number, dry_run=args.dry_run
        )

    conn.close()
    log.info("Done. %s", json.dumps(totals))


if __name__ == "__main__":
    main()
