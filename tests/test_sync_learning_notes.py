import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


spec = importlib.util.spec_from_file_location(
    "sync_learning_notes", Path(__file__).parents[1] / "tools/sync_learning_notes.py"
)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class SyncOrderTests(unittest.TestCase):
    def test_full_sync_preserves_zero_and_fractional_editorial_orders(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, posts, assets = root / "notes", root / "posts", root / "assets"
            for filename, order in [("[00]导读.md", 0), ("[2]测试.md", 2.5)]:
                note = source / "现代C++实践" / filename
                note.parent.mkdir(parents=True, exist_ok=True)
                note.write_text("# 页面标题\n\n## 正文\n内容\n", encoding="utf-8")
                post = posts / "现代C++实践" / filename
                post.parent.mkdir(parents=True, exist_ok=True)
                post.write_text(sync.render_front_matter(
                    "旧标题", "2026-01-01", ["学习"],
                    sync.build_permalink(note.relative_to(source)), False,
                    "现代 C++ 实践", order
                ) + "旧正文\n", encoding="utf-8")
            expected = sync.read_series_orders(posts)
            argv = ["sync", "--source", str(source), "--posts", str(posts), "--assets", str(assets)]
            with patch.object(sys, "argv", argv), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(sync.main(), 0)
                self.assertEqual(sync.main(), 0)
            self.assertEqual(sync.read_series_orders(posts), expected)
            for post in posts.rglob("*.md"):
                text = post.read_text(encoding="utf-8")
                self.assertIn("## 正文", text)
                self.assertNotIn("# 页面标题", text)

    def test_new_fractional_filename_and_invalid_existing_order(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source, posts = root / "source", root / "posts"
            note = source / "现代C++实践/[02.5]插入.md"
            note.parent.mkdir(parents=True)
            note.write_text("## 新文章\n", encoding="utf-8")
            existing = posts / "invalid.md"
            existing.parent.mkdir()
            existing.write_text("---\npermalink: /invalid/\nseries_order: NaN\n---\n", encoding="utf-8")
            self.assertEqual(sync.read_series_orders(posts), {})
            mapping = {note.resolve(): sync.build_permalink(note.relative_to(source))}
            sync.sync_notes(source, posts, [note], mapping, {})
            self.assertEqual(sync.read_series_orders(posts)[mapping[note.resolve()]], 2.5)


if __name__ == "__main__":
    unittest.main()
