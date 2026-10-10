#!/usr/bin/env python3
"""Dumps the raw tables and rules of the official content document (`content to upload(2).docx`) to JSON for REVIEW.

    python3 scripts/content/extract-docx.py "content to upload(2).docx" /tmp/official-raw.json

This is a one-off aid (needs `pip install python-docx`), not part of the build. Its output is the document as typed (reward still
a string, rules still numbered "1. ..."). `content/concetto26/official-content.json` is the reviewed, normalised version of it:
blank lines at the ends of a cell trimmed, the "N. " rule numbers split off, rewards turned into integers, and the two
owner-approved deviations recorded in `approved_deviations`. Diff the raw dump against that file to audit the import.
"""

import json
import sys

import docx
from docx.text.paragraph import Paragraph


def ptext(p):
    return "".join(r.text for r in p.runs) if p.runs else p.text


def cell(c):
    ps = [ptext(p) for p in c.paragraphs]
    while ps and ps[-1].strip() == "":
        ps.pop()
    return "\n".join(ps)


def main(src, out):
    d = docx.Document(src)
    t0, t1 = d.tables
    themes = [
        dict(zip(("id", "name", "description"), [cell(x) for x in r.cells][:3])) for r in t0.rows[1:]
    ]
    questions = [
        dict(zip(("id", "question", "hint1", "hint2", "reward"), [cell(x) for x in r.cells][:5]))
        for r in t1.rows[1:]
    ]
    body = list(d.element.body.iterchildren())
    paras = [Paragraph(e, d) for e in body if e.tag.endswith("}p")]
    start = [i for i, p in enumerate(paras) if p.text.startswith("Section C")][0]
    rules = [ptext(p) for p in paras[start + 1 :]]
    with open(out, "w", encoding="utf8") as f:
        json.dump(
            {"themes": themes, "questions": questions, "rules_raw": rules},
            f,
            ensure_ascii=False,
            indent=1,
        )
    print(len(themes), "themes,", len(questions), "questions,", len(rules), "rule paragraphs")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    main(*sys.argv[1:])
