#!/usr/bin/env python3
"""Re-compress public/assets/fonts/*.ttf to woff2 in .cache-fonts/.

The single-file build embeds every font as a base64 data URI, so the 2.2 MB of
raw TTF matters. woff2 keeps the same glyphs at roughly a third of the size.
"""

import pathlib

from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parents[1]
SRC = ROOT / "public/assets/fonts"
OUT = ROOT / ".cache-fonts"

OUT.mkdir(exist_ok=True)
for ttf in sorted(SRC.glob("*.ttf")):
    font = TTFont(str(ttf))
    font.flavor = "woff2"
    dst = OUT / f"{ttf.stem}.woff2"
    font.save(str(dst))
    print(f"{ttf.name}: {ttf.stat().st_size / 1024:.0f}K -> {dst.stat().st_size / 1024:.0f}K")
