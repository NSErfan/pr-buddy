#!/usr/bin/env python3
"""Regenerate the extension icons.

Large sizes composite icons/glyph-source.png (the white branch-and-bubble
glyph, stored as an alpha mask) onto a geometrically perfect rounded-square
tile in GitHub green. The 16px icon is drawn separately: at that size the
ringed nodes and the speech bubble collapse into mush, so it uses a
simplified branch with filled nodes.

    python3 tools/make-icons.py        # writes icons/icon-{16,32,48,128}.png

Requires Pillow.
"""

from pathlib import Path

from PIL import Image, ImageDraw

GREEN = (31, 136, 61, 255)  # GitHub #1f883d
WHITE = (255, 255, 255, 255)
RADIUS_PCT = 0.225  # corner radius as a fraction of the tile
GLYPH_H_PCT = 0.66  # glyph height as a fraction of the tile

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "icons"


def rounded_mask(size):
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * RADIUS_PCT), fill=255
    )
    return mask


def build_master(size=1024):
    glyph = Image.open(ICONS / "glyph-source.png")
    gw, gh = glyph.size
    th = int(size * GLYPH_H_PCT)
    tw = max(1, round(gw * th / gh))
    scaled = glyph.resize((tw, th), Image.LANCZOS)

    mask = rounded_mask(size)
    tile = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    tile.paste(Image.new("RGBA", (size, size), GREEN), (0, 0), mask)

    placed = Image.new("L", (size, size), 0)
    placed.paste(scaled, ((size - tw) // 2, (size - th) // 2))
    out = Image.composite(Image.new("RGBA", (size, size), WHITE), tile, placed)
    out.putalpha(mask)
    return out


def build_small(size=16, k=32):
    """Simplified branch — filled nodes survive the downscale, rings do not."""
    n = size * k
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    mask = rounded_mask(n)
    img.paste(Image.new("RGBA", (n, n), GREEN), (0, 0), mask)

    d = ImageDraw.Draw(img)
    d.line((5 * k, 4.6 * k, 5 * k, 11.4 * k), fill=WHITE, width=int(1.5 * k), joint="curve")
    d.line((5.2 * k, 7.4 * k, 11 * k, 11.2 * k), fill=WHITE, width=int(1.5 * k), joint="curve")
    for cx, cy in ((5, 4.4), (5, 11.6), (11.2, 11.6)):
        r = 1.9 * k
        d.ellipse((cx * k - r, cy * k - r, cx * k + r, cy * k + r), fill=WHITE)

    img.putalpha(mask)
    return img.resize((size, size), Image.LANCZOS)


def main():
    master = build_master()
    master.save(ICONS / "icon-master.png")
    for size in (128, 48, 32):
        master.resize((size, size), Image.LANCZOS).save(ICONS / f"icon-{size}.png")
    build_small().save(ICONS / "icon-16.png")
    print("wrote", ", ".join(f"icon-{s}.png" for s in (16, 32, 48, 128)))


if __name__ == "__main__":
    main()
