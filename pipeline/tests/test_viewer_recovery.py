#!/usr/bin/env python3
"""Unit tests for the embedded-viewer recovery resolvers (13_recover_viewer_cbas).

Resolvers are exercised with a fake session so no network is required: the
parsing/URL-building logic is what we verify, not live host behaviour.
"""
import importlib.util
import sys
import unittest
from pathlib import Path

_PKG_ROOT = Path(__file__).parent.parent
sys.path.insert(0, str(_PKG_ROOT))

# Module filename starts with a digit, so load it explicitly.
_spec = importlib.util.spec_from_file_location(
    "recover_viewer", _PKG_ROOT / "13_recover_viewer_cbas.py")
rec = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rec)


class _FakeResp:
    def __init__(self, text="", ok=True, status=200, json_data=None,
                 content=b"", ctype="text/html"):
        self.text = text
        self.ok = ok
        self.status_code = status
        self._json = json_data
        self.content = content
        self.headers = {"Content-Type": ctype}

    def json(self):
        if self._json is None:
            raise ValueError("no json")
        return self._json


class _FakeSession:
    """Returns a queued response per URL substring match."""
    def __init__(self, mapping):
        self.mapping = mapping

    def get(self, url, **kwargs):
        for needle, resp in self.mapping.items():
            if needle in url:
                return resp
        return _FakeResp(ok=False, status=404)


class TestHostOf(unittest.TestCase):
    def test_strips_www(self):
        self.assertEqual(rec._host_of("https://www.app.box.com/s/x"), "app.box.com")

    def test_plain(self):
        self.assertEqual(rec._host_of("https://issuu.com/u/docs/d"), "issuu.com")

    def test_garbage(self):
        self.assertEqual(rec._host_of("not a url"), "")


class TestResolveBox(unittest.TestCase):
    def test_static_passthrough(self):
        url = "https://app.box.com/shared/static/abc123.pdf"
        self.assertEqual(rec.resolve_box(url, _FakeSession({})), [url])

    def test_shared_link_static(self):
        html = 'foo "x":"y" https://company.app.box.com/shared/static/zzz.pdf bar'
        sess = _FakeSession({"/s/sharedid": _FakeResp(text=html)})
        out = rec.resolve_box("https://app.box.com/s/sharedid", sess)
        self.assertTrue(any("/shared/static/zzz.pdf" in u for u in out))

    def test_shared_link_download_endpoint(self):
        html = '{"itemID":"123456789","name":"cba.pdf"}'
        sess = _FakeSession({"/s/share2": _FakeResp(text=html)})
        out = rec.resolve_box("https://app.box.com/s/share2", sess)
        self.assertTrue(any("box_download_shared_file" in u and "file_id=f_123456789" in u
                            for u in out))

    def test_unresolvable(self):
        self.assertEqual(rec.resolve_box("https://app.box.com/notashare", _FakeSession({})), [])


class TestResolveDrive(unittest.TestCase):
    def test_file_d(self):
        out = rec.resolve_drive("https://drive.google.com/file/d/FILEID123/view", _FakeSession({}))
        self.assertEqual(out, ["https://drive.google.com/uc?export=download&id=FILEID123"])

    def test_open_id(self):
        out = rec.resolve_drive("https://drive.google.com/open?id=ABC987", _FakeSession({}))
        self.assertEqual(out, ["https://drive.google.com/uc?export=download&id=ABC987"])

    def test_folder_listing(self):
        # Embedded id list contains the folder id (must be excluded) + two files.
        folder = "FOLDERID000000000000000000"
        f1 = "AAAAAAAAAAAAAAAAAAAAAAAAAAA"
        f2 = "BBBBBBBBBBBBBBBBBBBBBBBBBBB"
        html = f'["{folder}",["x"]] ["{f1}",["y"]] ["{f2}",["z"]]'
        sess = _FakeSession({"/folders/" + folder: _FakeResp(text=html)})
        out = rec.resolve_drive(
            f"https://drive.google.com/drive/folders/{folder}", sess)
        self.assertIn(f"https://drive.google.com/uc?export=download&id={f1}", out)
        self.assertIn(f"https://drive.google.com/uc?export=download&id={f2}", out)
        self.assertFalse(any(folder in u for u in out))


class TestResolveIssuu(unittest.TestCase):
    def test_downloadable(self):
        sess = _FakeSession({"reader3_4.json": _FakeResp(
            json_data={"document": {"downloadable": True,
                                    "publicationId": "pub1", "revisionId": "rev1"}})})
        out = rec.resolve_issuu("https://issuu.com/myuser/docs/mydoc", sess)
        self.assertTrue(any("/docs/mydoc/download" in u for u in out))

    def test_not_downloadable(self):
        sess = _FakeSession({"reader3_4.json": _FakeResp(
            json_data={"document": {"downloadable": False}})})
        self.assertEqual(rec.resolve_issuu("https://issuu.com/u/docs/d", sess), [])

    def test_bad_url(self):
        self.assertEqual(rec.resolve_issuu("https://issuu.com/u", _FakeSession({})), [])


class TestResolveYumpu(unittest.TestCase):
    def test_view_id(self):
        out = rec.resolve_yumpu("https://www.yumpu.com/en/document/view/12345/title", _FakeSession({}))
        self.assertEqual(out, ["https://www.yumpu.com/en/document/download/12345"])


class TestDispatch(unittest.TestCase):
    def test_unknown_host(self):
        self.assertEqual(rec.resolve_viewer("https://example.com/x.pdf", _FakeSession({})), [])

    def test_box_dispatch(self):
        url = "https://app.box.com/shared/static/q.pdf"
        self.assertEqual(rec.resolve_viewer(url, _FakeSession({})), [url])


class TestIngestGuards(unittest.TestCase):
    def test_rejects_too_small(self):
        status, _ = rec._ingest_pdf_bytes(None, 1, "u", b"%PDF-1.4", "teachers", dry_run=True)
        self.assertEqual(status, "failed")

    def test_rejects_non_pdf(self):
        big = b"<html>" + b"x" * 5000
        status, detail = rec._ingest_pdf_bytes(None, 1, "u", big, "teachers", dry_run=True)
        self.assertEqual(status, "failed")
        self.assertIn("not_a_pdf", detail)


class TestClassifyCbaText(unittest.TestCase):
    """The content-aware CBA classifier — the core of telling real union
    contracts apart from board-meeting agendas in embedded viewers."""

    CBA = (
        "COLLECTIVE BARGAINING AGREEMENT between the Board of Education and the "
        "Education Association. ARTICLE I RECOGNITION. ARTICLE II GRIEVANCE "
        "PROCEDURE. The grievance shall be resolved by binding arbitration. "
        "ARTICLE III SALARY SCHEDULE. Sick leave and personal leave. Reduction "
        "in force and seniority. This agreement shall be effective. The "
        "bargaining unit. Retirement and insurance. Probationary teachers. "
        "Negotiations between the parties hereinafter. Workday and work year."
    )
    AGENDA = (
        "BOARD OF EDUCATION REGULAR MEETING AGENDA. Call to Order. Roll Call. "
        "Pledge of Allegiance. Approval of minutes. Consent Agenda. Public "
        "Comment. Superintendent's report. Old Business. New Business. Motion "
        "to approve, moved by Mr. Smith, seconded by Mrs. Jones. Adjournment."
    ) * 3
    MINUTES = (
        "MINUTES of the Regular Meeting of the Board of Education. The meeting "
        "was called to order. Roll call was taken. Motion to approve the consent "
        "agenda, moved by Director Lopez, seconded by Director Kim. Public "
        "participation. The board recessed into executive session. Adjourn."
    ) * 3
    RETURN_TO_LEARN = (
        "Return to Learn Plan 2021-2022. This plan outlines remote learning, "
        "hybrid instruction, mitigation, masking, and student safety protocols."
    ) * 8
    # An agenda that merely *mentions* approving a CBA must still be rejected.
    AGENDA_MENTIONING_CBA = (
        "BOARD MEETING AGENDA. Call to Order. Roll Call. Approval of minutes. "
        "Consent Agenda. Motion to approve the collective bargaining agreement, "
        "moved by Mr. A, seconded by Ms. B. Public Comment. Old Business. New "
        "Business. Superintendent's report. Adjournment."
    ) * 3

    def test_accepts_real_cba(self):
        ok, detail = rec.classify_cba_text(self.CBA)
        self.assertTrue(ok, detail)

    def test_rejects_agenda(self):
        ok, detail = rec.classify_cba_text(self.AGENDA)
        self.assertFalse(ok, detail)

    def test_rejects_minutes(self):
        ok, detail = rec.classify_cba_text(self.MINUTES)
        self.assertFalse(ok, detail)

    def test_rejects_return_to_learn(self):
        ok, detail = rec.classify_cba_text(self.RETURN_TO_LEARN)
        self.assertFalse(ok, detail)

    def test_rejects_agenda_that_mentions_a_cba(self):
        ok, detail = rec.classify_cba_text(self.AGENDA_MENTIONING_CBA)
        self.assertFalse(ok, detail)

    def test_rejects_insufficient_text(self):
        ok, detail = rec.classify_cba_text("too short")
        self.assertFalse(ok)
        self.assertIn("insufficient_text", detail)


if __name__ == "__main__":
    unittest.main()
