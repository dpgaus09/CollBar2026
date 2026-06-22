#!/usr/bin/env python3
"""Promote vetted CBA data from DEV to a target CollBar app (dev or prod).

Flow:  export dev bundle -> POST dry-run -> print diff -> (with --apply) POST apply.

The bundle is gzipped and POSTed to <base>/api/admin/promote. Authentication uses
Authorization: Bearer $ADMIN_TOKEN.

Examples:
  # Dry-run against the DEV app itself (idempotency check — expect ~0 inserts):
  python3 21_promote_to_prod.py --base "https://$REPLIT_DEV_DOMAIN"

  # Dry-run then apply against production:
  python3 21_promote_to_prod.py --base https://<your-app>.replit.app --apply
"""
import argparse
import gzip
import json
import os
import subprocess
import sys
from pathlib import Path

import requests

HERE = Path(__file__).resolve().parent
DEFAULT_BUNDLE = HERE / "data" / "promotion_bundle.json"


def export_bundle(out: Path) -> None:
    print("Exporting dev bundle ...", file=sys.stderr)
    subprocess.run(
        [sys.executable, str(HERE / "20_export_promotion_bundle.py"), "--out", str(out)],
        check=True,
        cwd=str(HERE),
    )


def post_bundle(base: str, token: str, payload: bytes, apply: bool) -> dict:
    url = base.rstrip("/") + "/api/admin/promote" + ("?apply=true" if apply else "")
    resp = requests.post(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/gzip",
            "Content-Encoding": "gzip",
        },
        timeout=600,
    )
    if resp.status_code != 200:
        print(f"HTTP {resp.status_code}: {resp.text[:500]}", file=sys.stderr)
        resp.raise_for_status()
    return resp.json()


def print_summary(summary: dict) -> None:
    mode = "DRY RUN" if summary.get("dryRun") else "APPLIED"
    print(f"\n=== {mode}  (run {summary.get('runId')}) ===")
    hdr = f"{'table':26s} {'in':>6s} {'ins':>6s} {'upd':>6s} {'del':>6s} {'skip':>6s}"
    print(hdr)
    print("-" * len(hdr))
    for table, r in summary.get("tables", {}).items():
        print(f"{table:26s} {r['inputRows']:>6d} {r['inserted']:>6d} "
              f"{r['updated']:>6d} {r['deleted']:>6d} {r['skipped']:>6d}")
        for w in r.get("warnings", [])[:5]:
            print(f"    ! {w}")
    t = summary.get("totals", {})
    print("-" * len(hdr))
    print(f"{'TOTAL':26s} {'':>6s} {t.get('inserted',0):>6d} "
          f"{t.get('updated',0):>6d} {t.get('deleted',0):>6d} {t.get('skipped',0):>6d}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", required=True, help="Target app base URL")
    ap.add_argument("--bundle", default=str(DEFAULT_BUNDLE))
    ap.add_argument("--no-export", action="store_true", help="reuse existing bundle file")
    ap.add_argument("--apply", action="store_true", help="commit after dry-run")
    args = ap.parse_args()

    token = os.environ.get("ADMIN_TOKEN", "")
    if not token:
        print("ADMIN_TOKEN env var is required.", file=sys.stderr)
        sys.exit(1)

    bundle_path = Path(args.bundle)
    if not args.no_export:
        export_bundle(bundle_path)
    if not bundle_path.exists():
        print(f"Bundle not found: {bundle_path}", file=sys.stderr)
        sys.exit(1)

    payload = gzip.compress(bundle_path.read_bytes())
    print(f"Bundle gzipped to {len(payload)/1024/1024:.2f} MB", file=sys.stderr)

    dry = post_bundle(args.base, token, payload, apply=False)
    print_summary(dry)

    if args.apply:
        applied = post_bundle(args.base, token, payload, apply=True)
        print_summary(applied)
    else:
        print("\n(dry run only — re-run with --apply to commit)")


if __name__ == "__main__":
    main()
