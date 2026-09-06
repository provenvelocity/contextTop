#!/usr/bin/env python3
"""Validate Markdown docs: no broken local file links, no trailing whitespace.

Runs in CI and locally. Scope: README.md, TASKS.md, and docs/*.md.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILES = [ROOT / "README.md", ROOT / "TASKS.md", *sorted((ROOT / "docs").glob("*.md"))]
LINK = re.compile(r"\[[^\]]+\]\(([^)]+)\)")


def main() -> int:
    broken: list[str] = []
    whitespace: list[str] = []
    for path in FILES:
        if not path.exists():
            continue
        text = path.read_text()
        for i, line in enumerate(text.splitlines(), 1):
            if line.rstrip() != line:
                whitespace.append(f"{path.relative_to(ROOT)}:{i}")
        for target in LINK.findall(text):
            if "://" in target or target.startswith("#"):
                continue
            rel = target.split("#", 1)[0]
            if rel and not (path.parent / rel).resolve().exists():
                broken.append(f"{path.relative_to(ROOT)} -> {target}")

    print(f"Checked {len(FILES)} Markdown files.")
    print(f"Broken local links: {len(broken)}")
    for item in broken:
        print(f"  {item}")
    print(f"Lines with trailing whitespace: {len(whitespace)}")
    for item in whitespace:
        print(f"  {item}")
    return 1 if (broken or whitespace) else 0


if __name__ == "__main__":
    sys.exit(main())
