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


if __name__ == "__main__":
    unittest.main()
