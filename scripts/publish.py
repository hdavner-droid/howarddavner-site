#!/usr/bin/env python3
"""
publish.py — wire newly added articles into insights.html and sitemap.xml.

Design rule: ADDITIVE ONLY. Existing cards and sitemap entries are never
rewritten, reordered, or reworded. Hand-tuned copy stays hand-tuned. The
script only fills in what is missing for files that aren't listed yet.

Usage:
    python3 scripts/publish.py            # apply changes
    python3 scripts/publish.py --check    # report only, exit 1 if work pending
"""

import datetime
import html
import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = ROOT / "insights.html"
SITEMAP = ROOT / "sitemap.xml"
BASE = "https://howarddavner.com"

# Directories scanned, and the sitemap priority given to new entries.
SECTIONS = {"insights": "0.7", "press": "0.6"}
# Only this section gets cards on the insights index page.
CARDED = "insights"


def read(path):
    return path.read_text(encoding="utf-8")


def grab(pattern, text, default=""):
    m = re.search(pattern, text, re.I | re.S)
    return m.group(1).strip() if m else default


def article_meta(path):
    """Pull the display fields out of a standalone article page."""
    src = read(path)
    h1 = grab(r"<h1[^>]*>(.*?)</h1>", src)
    title = re.sub(r"<[^>]+>", "", h1) or grab(r"<title[^>]*>(.*?)</title>", src)
    # Strip a trailing site-name suffix if the <title> was the fallback.
    title = re.sub(r"\s*[|]\s*Howard Davner.*$", "", title).strip()
    desc = grab(r'<meta\s+name=["\']description["\']\s+content=["\'](.*?)["\']', src)
    tag = grab(r'<span class=["\']tag["\']>(.*?)</span>', src, "Insights")
    date = grab(r'"datePublished"\s*:\s*"(\d{4}-\d{2}-\d{2})"', src)
    return {
        "slug": path.stem,
        "title": " ".join(title.split()),
        "desc": " ".join(desc.split()),
        "tag": " ".join(re.sub(r"<[^>]+>", "", tag).split()),
        "date": date or datetime.date.today().isoformat(),
    }


def card_html(meta, section):
    """One grid card, matching the existing markup byte for byte in shape."""
    return (
        "    <a class='post' href='/{sec}/{slug}'><div class=\"body\">"
        '<span class="tag">{tag}</span><h3>{title}</h3><p>{desc}</p>'
        "</div></a>".format(
            sec=section,
            slug=meta["slug"],
            tag=html.escape(meta["tag"]),
            title=html.escape(meta["title"]),
            desc=html.escape(meta["desc"]),
        )
    )


def main():
    check_only = "--check" in sys.argv
    index_src = read(INDEX)
    sitemap_src = read(SITEMAP)

    new_cards, new_urls, notes = [], [], []

    for section, priority in SECTIONS.items():
        folder = ROOT / section
        if not folder.is_dir():
            continue
        for path in sorted(folder.glob("*.html")):
            meta = article_meta(path)
            loc = "{}/{}/{}.html".format(BASE, section, meta["slug"])

            if loc not in sitemap_src and loc not in "\n".join(new_urls):
                new_urls.append(
                    "  <url><loc>{}</loc><lastmod>{}</lastmod>"
                    "<priority>{}</priority></url>".format(loc, meta["date"], priority)
                )
                notes.append("sitemap  + {}/{}".format(section, meta["slug"]))

            if section == CARDED:
                href = "/{}/{}".format(section, meta["slug"])
                if "href='{}'".format(href) not in index_src:
                    if not meta["title"] or not meta["desc"]:
                        notes.append(
                            "SKIPPED  ! {}/{} — missing <h1> or meta description".format(
                                section, meta["slug"]
                            )
                        )
                        continue
                    new_cards.append((meta["date"], card_html(meta, section)))
                    notes.append("index    + {}/{}".format(section, meta["slug"]))

    for note in notes:
        print(note)
    if not notes:
        print("nothing to do — index and sitemap are current")
        return 0
    if check_only:
        return 1

    # Newest first, matching how the grid is currently ordered.
    if new_cards:
        block = "\n".join(c for _, c in sorted(new_cards, reverse=True))
        anchor = '<div class="posts">\n'
        if anchor not in index_src:
            print("ERROR: could not find the .posts grid in insights.html")
            return 2
        index_src = index_src.replace(anchor, anchor + block + "\n", 1)
        INDEX.write_text(index_src, encoding="utf-8")

    if new_urls:
        closing = "</urlset>"
        sitemap_src = sitemap_src.replace(
            closing, "\n".join(new_urls) + "\n" + closing, 1
        )
        SITEMAP.write_text(sitemap_src, encoding="utf-8")

    print("\nwrote {} card(s), {} sitemap entr(ies)".format(len(new_cards), len(new_urls)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
