# -*- coding: utf-8 -*-
"""重要聖句のデータを data/keys.js に書き出す。

要旨と解説はこのアプリのために書き下ろしたもので、
既存の注解書や注釈付き聖書からの引用ではない。
聖句の本文はアプリが持つ口語訳データから表示するため、ここには含めない。

節番号は口語訳（ヘブライ語本文の区分）に合わせてある。
他の訳とずれる箇所は解説の中で断ってある。

使い方: python3 tools/build_keys.py
"""
import io
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from keys_ot import OT    # noqa: E402
from keys_nt import NT    # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    data = {}
    data.update(OT)
    data.update(NT)

    out = {}
    for bid in range(1, 67):
        summary, verses = data[bid]
        items = []
        for (c, v, note, detail, refs) in verses:
            item = {"c": c, "v": v, "n": note, "d": detail}
            if refs:
                item["r"] = [[rb, rc, rv] for (rb, rc, rv) in refs]
            items.append(item)
        out[str(bid)] = {"s": summary, "v": items}

    path = os.path.join(ROOT, "data", "keys.js")
    body = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    with io.open(path, "w", encoding="utf-8") as f:
        f.write("BIBLE_KEYS(%s);\n" % body)

    total = sum(len(v["v"]) for v in out.values())
    refs = sum(len(k.get("r", [])) for v in out.values() for k in v["v"])
    chars = sum(len(k["d"]) for v in out.values() for k in v["v"])
    print("data/keys.js  %d巻 %d聖句 関連%d件  詳解%d字（平均%d字）  %.1f KB"
          % (len(out), total, refs, chars, chars // total,
             os.path.getsize(path) / 1024))


if __name__ == "__main__":
    main()
