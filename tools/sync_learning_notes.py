#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import shutil
import urllib.parse
from datetime import datetime
from pathlib import Path


IMAGE_EXTENSIONS = {
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".svg",
    ".bmp",
    ".avif",
    ".ico",
}

TEXT_EXTENSIONS = {".md", ""}
MERMAID_PREFIXES = (
    "erDiagram",
    "flowchart",
    "graph ",
    "sequenceDiagram",
    "classDiagram",
    "stateDiagram",
    "journey",
    "gantt",
    "pie ",
    "mindmap",
    "timeline",
)

SERIES_LABELS = {
    "现代C++实践": "现代 C++ 实践",
    "高性能C++并行编程": "高性能 C++ 并行编程",
    "Linux高性能服务器编程": "Linux 服务器编程",
    "Liunx & c++工程化": "Linux 与 C++ 工程化",
    "AI模型开发": "AI 模型开发",
    "网络服务实战": "网络服务实战",
    "实时竞技游戏开发": "实时竞技游戏开发",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Sync local learning notes into Hexo posts."
    )
    parser.add_argument("--source", required=True, help="Source notes root")
    parser.add_argument("--posts", required=True, help="Target Hexo posts root")
    parser.add_argument("--assets", required=True, help="Target Hexo image root")
    return parser.parse_args()


def is_text_note(path: Path) -> bool:
    return path.is_file() and not path.name.startswith(".") and path.suffix.lower() in TEXT_EXTENSIONS


def is_asset(path: Path) -> bool:
    return path.is_file() and not path.name.startswith(".") and path.suffix.lower() in IMAGE_EXTENSIONS


def slugify_segment(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"\s+", "-", value)
    value = re.sub(r"[^\w\u4e00-\u9fff-]+", "-", value)
    value = re.sub(r"-{2,}", "-", value).strip("-_")
    return value or "note"


def title_from_content(content: str, fallback: str) -> str:
    for line in content.splitlines():
        stripped = line.strip()
        if stripped.startswith("# "):
            return stripped[2:].strip()
    return fallback


def strip_front_matter(content: str) -> str:
    if content.startswith("---\n"):
        parts = content.split("\n---\n", 1)
        if len(parts) == 2:
            return parts[1]
    return content


def clean_content(content: str) -> str:
    content = strip_front_matter(content)
    content = re.sub(r"cite.*?", "", content)
    content = re.sub(r"[ \t]+(\n)", r"\1", content)
    content = re.sub(r"\n{3,}", "\n\n", content)
    return content.strip() + "\n"


def remove_leading_h1(content: str) -> str:
    lines = content.splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
        while lines and not lines[0].strip():
            lines.pop(0)
    return "\n".join(lines).strip() + "\n"


def prepare_mermaid(content: str) -> tuple[str, bool]:
    if re.search(r"^```mermaid\s*$", content, flags=re.MULTILINE | re.IGNORECASE):
        return content, True

    stripped = content.lstrip()
    if stripped.startswith("```"):
        return content, False
    if any(stripped.startswith(prefix) for prefix in MERMAID_PREFIXES):
        return f"```mermaid\n{content.strip()}\n```\n", True
    return content, False


def yaml_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def note_output_name(relative_path: Path) -> str:
    if relative_path.suffix:
        return relative_path.name
    return f"{relative_path.name}.md"


def build_permalink(relative_path: Path) -> str:
    parts = list(relative_path.parts)
    if parts and Path(parts[-1]).stem.upper() == "README":
        parts = parts[:-1]
    else:
        stem = Path(parts[-1]).stem if parts else "note"
        parts[-1] = stem

    slug_parts = [slugify_segment(part) for part in parts]
    slug_path = "/".join(part for part in slug_parts if part)
    return f"/notes/{slug_path}/"


def render_front_matter(
    title: str,
    date_text: str,
    categories: list[str],
    permalink: str,
    mermaid: bool,
    series: str | None,
    series_order: int | None,
) -> str:
    lines = [
        "---",
        f"title: {yaml_quote(title)}",
        f"date: {date_text}",
        f"updated: {date_text}",
        "categories:",
    ]
    for category in categories:
        lines.append(f"  - {yaml_quote(category)}")
    lines.append(f"permalink: {permalink}")
    if series:
        lines.append(f"series: {yaml_quote(series)}")
    if series_order is not None:
        lines.append(f"series_order: {series_order}")
    if mermaid:
        lines.append("mermaid: true")
    lines.append("---")
    return "\n".join(lines) + "\n\n"


def resolve_markdown_target(raw_target: str, base_dir: Path) -> tuple[Path | None, str]:
    target = raw_target.strip()
    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1].strip()

    if not target or target.startswith(("#", "/", "http://", "https://", "mailto:")):
        return None, raw_target

    parsed = urllib.parse.urlsplit(target)
    if parsed.scheme:
        return None, raw_target

    decoded_path = urllib.parse.unquote(parsed.path)
    resolved = (base_dir / decoded_path).resolve()
    suffix = ""
    if parsed.fragment:
        suffix = f"#{parsed.fragment}"
    if parsed.query:
        suffix = f"?{parsed.query}{suffix}"
    return resolved, suffix


def rewrite_markdown_links(
    content: str,
    current_file: Path,
    note_link_map: dict[Path, str],
    asset_link_map: dict[Path, str],
) -> str:
    pattern = re.compile(r"(!?\[.*?\]\()([^)]+)(\))")

    def replace(match: re.Match[str]) -> str:
        prefix, raw_target, suffix = match.groups()
        resolved, tail = resolve_markdown_target(raw_target, current_file.parent)
        if resolved is None:
            return match.group(0)

        if resolved in note_link_map:
            return f"{prefix}{note_link_map[resolved]}{tail}{suffix}"

        if resolved in asset_link_map:
            return f"{prefix}{asset_link_map[resolved]}{tail}{suffix}"

        return match.group(0)

    return pattern.sub(replace, content)


def collect_paths(source_root: Path) -> tuple[list[Path], list[Path]]:
    notes: list[Path] = []
    assets: list[Path] = []
    for path in sorted(source_root.rglob("*")):
        if is_text_note(path):
            notes.append(path)
        elif is_asset(path):
            assets.append(path)
    return notes, assets


def sync_assets(source_root: Path, asset_root: Path, assets: list[Path]) -> dict[Path, str]:
    link_map: dict[Path, str] = {}
    for asset in assets:
        relative_path = asset.relative_to(source_root)
        target_path = asset_root / relative_path
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(asset, target_path)
        url_path = "/img/notes/学习/" + "/".join(relative_path.parts)
        link_map[asset.resolve()] = url_path
    return link_map


def sync_notes(
    source_root: Path,
    post_root: Path,
    notes: list[Path],
    note_link_map: dict[Path, str],
    asset_link_map: dict[Path, str],
) -> int:
    count = 0
    for note in notes:
        relative_path = note.relative_to(source_root)
        raw_content = note.read_text(encoding="utf-8")
        content = clean_content(raw_content)
        title = title_from_content(content, note.stem or note.name)
        content = remove_leading_h1(content)
        content, mermaid = prepare_mermaid(content)
        content = rewrite_markdown_links(content, note.resolve(), note_link_map, asset_link_map)

        date_text = datetime.fromtimestamp(note.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
        parent_parts = list(relative_path.parent.parts)
        series = SERIES_LABELS.get(parent_parts[0]) if parent_parts else None
        if parent_parts and series:
            parent_parts[0] = series
        categories = ["学习", *parent_parts]
        order_match = re.match(r"^\[(\d+)]", note.stem)
        series_order = int(order_match.group(1)) if order_match and series else None
        if series and note.stem.upper() == "README":
            series_order = 0
        permalink = note_link_map[note.resolve()]
        front_matter = render_front_matter(
            title,
            date_text,
            categories,
            permalink,
            mermaid,
            series,
            series_order,
        )

        target_path = post_root / relative_path.parent / note_output_name(relative_path)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        target_path.write_text(front_matter + content, encoding="utf-8")
        count += 1
    return count


def main() -> int:
    args = parse_args()
    source_root = Path(args.source).expanduser().resolve()
    post_root = Path(args.posts).expanduser().resolve()
    asset_root = Path(args.assets).expanduser().resolve()

    if not source_root.exists():
        raise FileNotFoundError(f"Source notes root does not exist: {source_root}")

    if post_root.exists():
        shutil.rmtree(post_root)
    if asset_root.exists():
        shutil.rmtree(asset_root)

    notes, assets = collect_paths(source_root)
    note_link_map = {
        note.resolve(): build_permalink(note.relative_to(source_root))
        for note in notes
    }
    asset_link_map = sync_assets(source_root, asset_root, assets)
    note_count = sync_notes(source_root, post_root, notes, note_link_map, asset_link_map)

    print(
        f"Synced {note_count} notes and {len(assets)} assets "
        f"from {source_root} into {post_root}."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
