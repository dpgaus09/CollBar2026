#!/usr/bin/env python3
"""Export vetted CBA / reference tables from the DEV database into a promotion
bundle (JSON) that the production app's /admin/promote endpoint can import.

The bundle denormalises each child row's parent NATURAL KEY so the importer can
remap foreign keys against the production DB without ever copying dev serial ids.

Run:  python3 20_export_promotion_bundle.py [--out data/promotion_bundle.json]

Allowlist + ordering + natural keys are kept in lockstep with the TypeScript
engine in artifacts/api-server/src/lib/promote.ts — change both together.
"""
import argparse
import gzip
import json
import sys
from datetime import date, datetime
from decimal import Decimal
from pathlib import Path

import common

# table, own (non-id/non-fk) cols, fks, natural_key (db cols), is_parent
SPEC = [
    {
        "table": "districts",
        "own": ["state", "state_district_id", "name", "county", "district_type",
                "enrollment", "valuation", "avg_teacher_salary", "website_url",
                "updated_at", "slug"],
        "fks": [],
        "natural_key": ["state", "state_district_id"],
        "is_parent": True,
    },
    {
        "table": "il_min_teacher_salary",
        "own": ["school_year", "prior_year", "prior_year_rate", "percentage_increase",
                "new_year_rate", "certified_date", "source_url", "file_hash",
                "created_at", "updated_at"],
        "fks": [],
        "natural_key": ["school_year"],
        "is_parent": False,
    },
    {
        "table": "source_documents",
        "own": ["doc_type", "source_url", "file_hash", "storage_key", "school_year",
                "retrieved_at", "bargaining_unit", "source_type"],
        "fks": [{"col": "district_id", "parent": "districts", "key": "_district_key"}],
        "natural_key": ["source_url", "file_hash"],
        "is_parent": True,
    },
    {
        "table": "contracts",
        "own": ["union_name", "affiliation", "unit_scope", "effective_start",
                "effective_end", "term_years", "has_reopener", "reopener_terms",
                "bargaining_unit"],
        "fks": [
            {"col": "district_id", "parent": "districts", "key": "_district_key"},
            {"col": "source_doc_id", "parent": "source_documents", "key": "_source_doc_key"},
        ],
        # Must match promote.ts: 4-col DB unique index collides under NULL-equality
        # (effective_start NULL for ~100 rows); add effective_end + union_name so
        # the key is collision-free for IS NOT DISTINCT FROM matching.
        "natural_key": ["district_id", "bargaining_unit", "unit_scope",
                        "effective_start", "effective_end", "union_name"],
        "is_parent": True,
    },
    {
        "table": "contract_provisions",
        "own": ["category", "provision_key", "value_numeric", "value_text", "unit",
                "clause_excerpt", "page_ref", "confidence", "human_verified",
                "is_audit_sample", "audit_verdict"],
        "fks": [{"col": "contract_id", "parent": "contracts", "key": "_contract_key",
                 "required": True}],
        "natural_key": None,
        "is_parent": False,
    },
    {
        "table": "settlements",
        "own": ["from_year", "to_year", "base_increase_pct", "year2_pct", "year3_pct",
                "off_schedule_payment", "insurance_changed", "term_years", "method",
                "confidence", "human_verified", "notes", "page_ref", "bargaining_unit"],
        "fks": [
            {"col": "district_id", "parent": "districts", "key": "_district_key"},
            {"col": "contract_id", "parent": "contracts", "key": "_contract_key"},
            {"col": "source_doc_id", "parent": "source_documents", "key": "_source_doc_key"},
        ],
        "natural_key": ["district_id", "bargaining_unit", "from_year", "to_year"],
        "is_parent": False,
    },
    {
        "table": "final_offer_postings",
        "own": ["case_number", "year", "bargaining_unit", "district_name", "union_name",
                "posted_date", "district_offer_url", "union_offer_url", "page_url",
                "created_at", "updated_at"],
        "fks": [
            {"col": "district_id", "parent": "districts", "key": "_district_key"},
            {"col": "district_source_doc_id", "parent": "source_documents", "key": "_district_source_doc_key"},
            {"col": "union_source_doc_id", "parent": "source_documents", "key": "_union_source_doc_key"},
        ],
        "natural_key": ["case_number"],
        "is_parent": True,
    },
    {
        "table": "final_offer_items",
        "own": ["side", "topic", "topic_label", "summary", "numeric_value",
                "numeric_unit", "raw_text", "created_at"],
        "fks": [
            {"col": "posting_id", "parent": "final_offer_postings", "key": "_posting_key", "required": True},
            {"col": "source_doc_id", "parent": "source_documents", "key": "_source_doc_key"},
        ],
        "natural_key": ["posting_id", "side", "topic"],
        "is_parent": True,
    },
    {
        "table": "final_offer_comparisons",
        "own": ["topic", "topic_label", "status", "district_summary", "union_summary",
                "numeric_gap", "gap_unit", "created_at"],
        "fks": [
            {"col": "posting_id", "parent": "final_offer_postings", "key": "_posting_key", "required": True},
            {"col": "district_item_id", "parent": "final_offer_items", "key": "_district_item_key"},
            {"col": "union_item_id", "parent": "final_offer_items", "key": "_union_item_key"},
        ],
        "natural_key": ["posting_id", "topic"],
        "is_parent": False,
    },
]


def jsonable(v):
    if v is None:
        return None
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    # NOTE: do NOT strip/normalise str values. The importer stages rows into a
    # temp table cloned from the real schema, so char(n) values get re-padded and
    # match; stripping here would instead corrupt legitimate trailing whitespace
    # in text columns (e.g. union_name, now part of the contracts natural key).
    return v


def fk_for_col(spec, col):
    for fk in spec["fks"]:
        if fk["col"] == col:
            return fk
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="data/promotion_bundle.json")
    ap.add_argument("--gzip", action="store_true", help="also write <out>.gz")
    args = ap.parse_args()

    conn = common.get_db_conn()
    conn.autocommit = True
    import psycopg2.extras

    keymaps = {}        # table -> {id: key_object}
    bundle_tables = {}  # table -> [records]
    counts = {}

    with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        for spec in SPEC:
            table = spec["table"]
            select_cols = ["id"] + spec["own"] + [fk["col"] for fk in spec["fks"]]
            cur.execute(f"SELECT {', '.join(select_cols)} FROM {table}")
            rows = cur.fetchall()
            counts[table] = len(rows)

            records = []
            for row in rows:
                rec = {}
                for c in spec["own"]:
                    rec[c] = jsonable(row[c])
                for fk in spec["fks"]:
                    fkval = row[fk["col"]]
                    rec[fk["key"]] = (
                        keymaps[fk["parent"]].get(fkval) if fkval is not None else None
                    )
                records.append(rec)
            bundle_tables[table] = records

            if spec["is_parent"]:
                km = {}
                for row in rows:
                    ko = {}
                    for col in spec["natural_key"]:
                        fk = fk_for_col(spec, col)
                        if fk:
                            fkval = row[fk["col"]]
                            ko[fk["key"]] = (
                                keymaps[fk["parent"]].get(fkval)
                                if fkval is not None else None
                            )
                        else:
                            ko[col] = jsonable(row[col])
                    km[row["id"]] = ko
                keymaps[table] = km

            print(f"  {table:26s} {len(rows):>6d} rows", file=sys.stderr)

    conn.close()

    bundle = {
        "meta": {
            "format_version": 1,
            "created_at": datetime.utcnow().isoformat() + "Z",
            "table_order": [s["table"] for s in SPEC],
            "counts": counts,
        },
        "tables": bundle_tables,
    }

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(bundle, ensure_ascii=False)
    out.write_text(payload, encoding="utf-8")
    size_mb = len(payload.encode("utf-8")) / 1024 / 1024
    print(f"Wrote {out} ({size_mb:.2f} MB, {sum(counts.values())} rows total)",
          file=sys.stderr)

    if args.gzip:
        gz = Path(str(out) + ".gz")
        with gzip.open(gz, "wt", encoding="utf-8") as f:
            f.write(payload)
        print(f"Wrote {gz} ({gz.stat().st_size/1024/1024:.2f} MB)", file=sys.stderr)


if __name__ == "__main__":
    main()
