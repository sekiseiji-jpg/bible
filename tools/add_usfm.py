# -*- coding: utf-8 -*-
"""eBible.org の USFM をひとつ、既存の data/ に足す。

build_data.py は全訳を作り直すため、元データ（bolls.life の JSON など）が
一式そろっていないと動かない。訳を 1 つ足すだけなら、
既に検証済みの本文を作り直さずに済むこちらを使う。

解析は build_data.py の関数をそのまま使う。両方に同じ処理を書かないため。

やること:
  1. USFM を読んで data/<id>/<巻>.js を書く
  2. data/meta.js の各巻に vc.<id> を足し、translations に 1 件挿す

使い方:
  python3 tools/add_usfm.py <id> <USFM ディレクトリ> [<この訳の次に来る訳の id>]

例:
  python3 tools/add_usfm.py fb ~/dl/jpnm_usfm kjv
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_data as B  # noqa: E402

# 訳ごとの表示名。build_data.py の build_meta() と同じ内容を持つ。
# 新しい訳を足すときは両方に書くこと（build_data.py は全再生成用）。
INFO = {
    "fb": {"lang": "ja", "name": "フリーダム",
           "full": "フリーダム・バイブル（翻訳草案）", "ruby": False,
           "note": "訳者不明・eBible.org 配布の草案", "draft": True},
}


def read_meta(path):
    text = io.open(path, encoding="utf-8").read().strip()
    head, tail = "BIBLE_META(", ");"
    if not text.startswith(head) or not text.endswith(tail):
        raise SystemExit("meta.js の形が違う: %s" % path)
    return json.loads(text[len(head):-len(tail)])


def write_meta(path, meta):
    with io.open(path, "w", encoding="utf-8") as f:
        f.write("BIBLE_META(%s);\n"
                % json.dumps(meta, ensure_ascii=False, separators=(",", ":")))


def main():
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    key, path = sys.argv[1], sys.argv[2]
    before = sys.argv[3] if len(sys.argv) > 3 else None
    if key not in INFO:
        raise SystemExit("INFO に %s の訳情報がない" % key)

    data = B.load(path, B.clean_plain, key, reader=B.load_usfm)
    mk = B.snapshot()

    # 空の節は「まとめ書きの続き」か「底本にない節」のどちらかでなければならない。
    # 合わないときは取りこぼしがあるので止める。
    blank = sum(1 for b in data.values() for ch in b for v in ch if not v)
    spans = sum(e - v for b in mk["bridges"].values()
                for c in b.values() for v, e in c.items())
    gone = sum(len(v) for b in mk["omitted"].values() for v in b.values())
    if spans + gone != blank:
        raise SystemExit("%s: まとめ書き %d + 底本にない節 %d に対し空の節が %d 件"
                         % (key, spans, gone, blank))

    meta = read_meta(os.path.join(B.OUT, "meta.js"))
    if any(t["id"] == key for t in meta["translations"]):
        raise SystemExit("%s は既に meta.js にある" % key)

    for b in meta["books"]:
        b["vc"][key] = [len(ch) for ch in data.get(b["id"], [])]

    entry = {"id": key}
    entry.update(INFO[key])
    entry["bridges"] = mk["bridges"]
    entry["omitted"] = mk["omitted"]
    ids = [t["id"] for t in meta["translations"]]
    meta["translations"].insert(ids.index(before) if before in ids else len(ids), entry)

    size = B.write_books(key, data)
    write_meta(os.path.join(B.OUT, "meta.js"), meta)

    chapters = sum(len(b) for b in data.values())
    verses = sum(len(ch) for b in data.values() for ch in b)
    print("%-4s %2d巻 %5d章 %6d節%s  %6.1f MB"
          % (key, len(data), chapters, verses,
             ("（まとめ書き %d・底本にない節 %d）" % (spans, gone)) if blank else "",
             size / 1048576))
    print("訳の並び: %s" % " ".join(t["id"] for t in meta["translations"]))


if __name__ == "__main__":
    main()
