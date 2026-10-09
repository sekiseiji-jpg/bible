# -*- coding: utf-8 -*-
"""聖書本文データを JSONP 形式の JS ファイルに変換する。

入力:
  bolls.life の全文 JSON
    JPKJV = 口語訳聖書 1954/1955 (ルビ付き)
    KJV   = King James Version 1769 (Strong 番号付き)
  eBible.org の USFM
    jpn1965_usfm/ = 新改訳新約聖書 1965年版 (新約27巻のみ・パブリックドメイン)
    jpnm_usfm/    = フリーダム・バイブル (66巻・パブリックドメイン・翻訳草案)

出力:
  data/meta.js          書名・別名・章節構成
  data/ja/<id>.js       口語訳 本文 (66巻)
  data/kjv/<id>.js      KJV 本文 (66巻)
  data/njb/<id>.js      新改訳 本文 (40〜66巻)
  data/fb/<id>.js       フリーダム・バイブル 本文 (66巻)

file:// から開いても動くよう、fetch ではなく <script> で読める
JSONP 形式 ( BIBLE_PUT("ja", 1, [[...]]) ) で書き出す。

使い方:
  python3 tools/build_data.py <JPKJV.json> <KJV.json> <jpn1965_usfm> <jpnm_usfm>
"""
import io
import json
import os
import re
import sys
import unicodedata

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from books import BOOKS, SECTIONS  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "data")

# 口語訳のルビ: <i>漢字</i><sup>,かんじ</sup> → {漢字|かんじ}
# 基底語と読みを両方 { } で囲んでおき、表示時に <ruby> へ展開する。
# 本文に { } | は出現しないことを確認済み。
RUBY = re.compile(r"<i>([^<]*)</i><sup>,([^<]*)</sup>")
# KJV の Strong 番号と欄外注
STRONG = re.compile(r"<S>\d+</S>")
MARGIN = re.compile(r"<sup>.*?</sup>", re.S)
TAG = re.compile(r"<[^>]+>")
SPACE_BEFORE_PUNCT = re.compile(r"\s+([,.;:!?)\]])")
SPACE_AFTER_OPEN = re.compile(r"([(\[])\s+")

# KJV に含まれるエステル記のギリシャ語付加部分 (11-16章) は 66 巻正典外
EXTRA_CHAPTERS = {("kjv", 17): 10}


def clean_ja(text):
    text = RUBY.sub(lambda m: "{" + m.group(1) + "|" + m.group(2) + "}", text)
    text = text.replace("<br/>", " ").replace("<br>", " ")
    text = TAG.sub("", text)
    return re.sub(r"[ \t　]+", " ", text).strip()


def clean_en(text):
    text = MARGIN.sub("", text)
    text = STRONG.sub("", text)
    text = text.replace("<br/>", " ").replace("<br>", " ")
    text = TAG.sub("", text)
    text = re.sub(r"\s+", " ", text)
    text = SPACE_BEFORE_PUNCT.sub(r"\1", text)
    text = SPACE_AFTER_OPEN.sub(r"\1", text)
    return text.strip()


# カタカナ → ひらがな（「よはね」でも引けるようにするため）
KANA = {chr(c): chr(c - 0x60) for c in range(0x30A1, 0x30F7)}


# 日本語の文字（和文の間に半角空白を残さないための判定）
JP_CHAR = "[\u3000-\u303f\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]"
JP_GAP = re.compile("(?<=%s) +(?=%s)" % (JP_CHAR, JP_CHAR))


def clean_plain(text):
    """USFM から取り出した本文を整える。

    詩行の改行や、取り除いた脚注の跡が半角空白として残るため、
    和文どうしの間に挟まった空白は落とす。
    """
    text = USFM_CHAR.sub("", text)
    text = re.sub(r"\s+", " ", text).strip()
    return JP_GAP.sub("", text)


def norm(s):
    """検索キー用に正規化する（NFKC・小文字化・記号除去・かな統一）。

    app.js の normKey() と同じ結果になるよう揃えてある。
    """
    s = unicodedata.normalize("NFKC", s).lower()
    s = re.sub(r"[\s'’,.\-_·・:：]", "", s)
    return "".join(KANA.get(c, c) for c in s)


# USFM の書名コード
USFM_BOOKS = {
    "GEN": 1, "EXO": 2, "LEV": 3, "NUM": 4, "DEU": 5, "JOS": 6, "JDG": 7,
    "RUT": 8, "1SA": 9, "2SA": 10, "1KI": 11, "2KI": 12, "1CH": 13, "2CH": 14,
    "EZR": 15, "NEH": 16, "EST": 17, "JOB": 18, "PSA": 19, "PRO": 20,
    "ECC": 21, "SNG": 22, "ISA": 23, "JER": 24, "LAM": 25, "EZK": 26,
    "DAN": 27, "HOS": 28, "JOL": 29, "AMO": 30, "OBA": 31, "JON": 32,
    "MIC": 33, "NAM": 34, "HAB": 35, "ZEP": 36, "HAG": 37, "ZEC": 38,
    "MAL": 39,
    "MAT": 40, "MRK": 41, "LUK": 42, "JHN": 43, "ACT": 44, "ROM": 45,
    "1CO": 46, "2CO": 47, "GAL": 48, "EPH": 49, "PHP": 50, "COL": 51,
    "1TH": 52, "2TH": 53, "1TI": 54, "2TI": 55, "TIT": 56, "PHM": 57,
    "HEB": 58, "JAS": 59, "1PE": 60, "2PE": 61, "1JN": 62, "2JN": 63,
    "3JN": 64, "JUD": 65, "REV": 66,
}
# 本文を持たない行（書名・目次・序文・節見出し）
USFM_SKIP = re.compile(
    r"^\\(id|ide|h|toc\d|mt\d?|ms\d?|mr|s\d?|sr|r|is\d?|ip|ib|imi|imt\d?"
    r"|rem|cl|sts|periph|iot|io\d)\b")
# 段落・詩行のマーカー。本文はそのまま続くので印だけ落とす
USFM_PARA = re.compile(r"^\\(p|m|mi|b|q\d*|qr|qc|pi\d*|li\d*|ph\d*|nb|pc|cls|sp|tr)\b ?")
# 表題（詩篇の「ダビデの詩。」など）。直後の節の頭に【】付きで入れる
USFM_TITLE = re.compile(r"^\\d\b ?(.*)$")
USFM_CHAP = re.compile(r"^\\c\s+(\d+)")
USFM_VERSE = re.compile(r"^\\v\s+(\d+)(?:-(\d+))? ?(.*)$")
# 脚注と相互参照はまるごと落とす
USFM_NOTE = re.compile(r"\\(f|x|fe)\b.*?\\\1\*", re.S)
# 残った文字装飾マーカー（\wj ... \wj* など）は印だけ落とす
USFM_CHAR = re.compile(r"\\\+?[a-z]+\d*\*?")

# 新改訳はマルコ7:16-17のように複数の節をまとめて訳している箇所がある。
# まとめ書きの範囲を覚えておき、表示時に「16-17」と出せるようにする。
BRIDGES = {}          # 現在読み込み中の訳のまとめ書き
OMITTED = {}          # 底本にないため本文を持たない節


def snapshot():
    """直前に読んだ USFM のまとめ書き・欠落節を取り出す。

    USFM の訳が 2 つ以上あるため、読み終えるたびにここで引き取る。
    """
    return {"bridges": dict(BRIDGES), "omitted": dict(OMITTED)}


def load_usfm(path):
    """eBible.org の USFM ディレクトリを読む。

    まとめ書き（\\v 16-17）は先頭の節に本文を入れ、
    残りの節番号は空にして位置を保つ。範囲は BRIDGES に控える。
    """
    # 訳ごとに数え直す。持ち越すと別の訳のまとめ書きが混ざる。
    BRIDGES.clear()
    OMITTED.clear()
    rows = []
    for name in sorted(os.listdir(path)):
        if not name.lower().endswith(".usfm"):
            continue
        text = io.open(os.path.join(path, name), encoding="utf-8").read()
        text = USFM_NOTE.sub("", text)
        code = re.search(r"\\id\s+(\S+)", text)
        if not code or code.group(1) not in USFM_BOOKS:
            continue                      # 序文ファイルなど
        book = USFM_BOOKS[code.group(1)]
        chapter = 0
        cur = None
        title = ""

        for line in text.splitlines():
            line = line.strip()
            if not line or USFM_SKIP.match(line):
                continue

            m = USFM_CHAP.match(line)
            if m:
                chapter = int(m.group(1))
                cur = None
                title = ""
                continue

            m = USFM_TITLE.match(line)
            if m:
                title = m.group(1).strip()
                continue

            line = USFM_PARA.sub("", line)
            m = USFM_VERSE.match(line)
            if m:
                start, end = int(m.group(1)), int(m.group(2) or 0)
                body = m.group(3)
                if title:
                    body = "【" + title.rstrip("。") + "】" + body
                    title = ""
                cur = {"book": book, "chapter": chapter, "verse": start, "text": body}
                rows.append(cur)
                # 脚注だけで本文のない節は「底本にない節」として控える
                if not clean_plain(body):
                    OMITTED.setdefault(book, {}).setdefault(chapter, []).append(start)
                if end > start:
                    BRIDGES.setdefault(book, {}).setdefault(chapter, {})[start] = end
                    # まとめ書きの続きの節番号も席だけ作っておく。
                    # そうしないと章末がまとめ書きのとき節数が 1 つ足りなくなる。
                    for k in range(start + 1, end + 1):
                        rows.append({"book": book, "chapter": chapter,
                                     "verse": k, "text": ""})
                continue

            if cur is not None and line:
                cur["text"] += " " + line

        if chapter == 0:
            raise SystemExit("%s に章がありません" % name)

    if not rows:
        raise SystemExit("USFM を読み込めませんでした: %s" % path)
    return rows


def load(path, cleaner, key, books=None, reader=None):
    """{book: [[verse, ...], ...]} の形に整形する。

    books を渡すと、その巻だけを収録対象として検証する（新改訳は新約のみ）。
    """
    rows = reader(path) if reader else json.load(open(path, encoding="utf-8"))
    expect = set(books) if books else set(range(1, 67))
    limit = {b: c for (k, b), c in EXTRA_CHAPTERS.items() if k == key}
    books = {}
    for r in rows:
        b, c, v = r["book"], r["chapter"], r["verse"]
        if b not in expect:
            continue
        if b in limit and c > limit[b]:
            continue
        chapters = books.setdefault(b, {})
        chapters.setdefault(c, {})[v] = cleaner(r["text"])

    out = {}
    for b, chapters in books.items():
        flat = []
        for c in range(1, max(chapters) + 1):
            verses = chapters.get(c, {})
            if not verses:
                raise SystemExit("%s: %d章 %d が欠落" % (key, b, c))
            flat.append([verses.get(v, "") for v in range(1, max(verses) + 1)])
        out[b] = flat
    missing = [b for b in sorted(expect) if b not in out]
    if missing:
        raise SystemExit("%s: 巻が欠落 %s" % (key, missing))
    return out


def write_books(key, data):
    d = os.path.join(OUT, key)
    os.makedirs(d, exist_ok=True)
    total = 0
    for b in sorted(data):
        body = json.dumps(data[b], ensure_ascii=False, separators=(",", ":"))
        path = os.path.join(d, "%d.js" % b)
        with open(path, "w", encoding="utf-8") as f:
            f.write('BIBLE_PUT("%s",%d,%s);\n' % (key, b, body))
        total += os.path.getsize(path)
    return total


def build_meta(sets, marks):
    section_of = {}
    for sid, ja, en, rng in SECTIONS:
        for b in rng:
            section_of[b] = (sid, ja, en)

    books = []
    for bid, ja, en, alt_ja, ab_ja, ab_en in BOOKS:
        sid, sja, sen = section_of[bid]
        keys = {norm(x) for x in [ja, en] + alt_ja + ab_ja + ab_en}
        # 「ヨハネによる福音書」→「ヨハネ」のように助詞を落とした形も引けるように
        for x in [ja] + alt_ja:
            keys.add(norm(re.sub(r"(による福音書|の福音書|人への|への|の信徒への|記|書|篇|編)$", "", x)))
        books.append({
            "id": bid,
            "ja": ja,
            "en": en,
            "t": "ot" if bid <= 39 else "nt",
            "sid": sid,
            "sja": sja,
            "sen": sen,
            "abja": ab_ja[0],
            "aben": ab_en[0],
            "keys": sorted(k for k in keys if k),
            # 訳ごとの各章の節数。収録していない巻は空配列。
            "vc": {k: [len(ch) for ch in data.get(bid, [])] for k, data in sets.items()},
        })

    meta = {
        "translations": [
            {"id": "ja", "lang": "ja", "name": "口語訳",
             "full": "口語訳聖書（1954/1955年）", "ruby": True,
             "note": "日本聖書協会"},
            {"id": "njb", "lang": "ja", "name": "新改訳",
             "full": "新改訳聖書 新約（1965年版）", "ruby": False,
             "note": "新改訳聖書刊行会・新約聖書のみ",
             "bridges": marks["njb"]["bridges"],
             "omitted": marks["njb"]["omitted"]},
            # 訳者が公表されておらず、底本の記載もない翻訳草案。
            # 配布元が著作権を設定していないと明記しているため収録できるが、
            # 校訂された訳と同じようには扱えない。その旨を draft で持つ。
            {"id": "fb", "lang": "ja", "name": "フリーダム",
             "full": "フリーダム・バイブル（翻訳草案）", "ruby": False,
             "note": "訳者不明・eBible.org 配布の草案", "draft": True,
             "bridges": marks["fb"]["bridges"],
             "omitted": marks["fb"]["omitted"]},
            {"id": "kjv", "lang": "en", "name": "KJV",
             "full": "King James Version (1769)", "ruby": False,
             "note": "英語"},
        ],
        "books": books,
    }
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "meta.js")
    with open(path, "w", encoding="utf-8") as f:
        f.write("BIBLE_META(%s);\n" % json.dumps(meta, ensure_ascii=False, separators=(",", ":")))
    return os.path.getsize(path)


def main():
    if len(sys.argv) < 5:
        raise SystemExit(__doc__)
    # USFM の訳は読んだ直後に snapshot() で引き取る（下の順序に意味がある）。
    sets = {}
    marks = {}
    sets["ja"] = load(sys.argv[1], clean_ja, "ja")
    sets["kjv"] = load(sys.argv[2], clean_en, "kjv")
    sets["njb"] = load(sys.argv[3], clean_plain, "njb",
                       books=range(40, 67), reader=load_usfm)
    marks["njb"] = snapshot()
    sets["fb"] = load(sys.argv[4], clean_plain, "fb", reader=load_usfm)
    marks["fb"] = snapshot()

    for key in ("ja", "njb", "fb", "kjv"):
        data = sets[key]
        size = write_books(key, data)
        verses = sum(len(ch) for b in data.values() for ch in b)
        blank = sum(1 for b in data.values() for ch in b for v in ch if not v)
        mk = marks.get(key, {})
        spans = sum(e - v for b in mk.get("bridges", {}).values()
                    for c in b.values() for v, e in c.items())
        gone = sum(len(v) for b in mk.get("omitted", {}).values() for v in b.values())
        if spans + gone != blank:
            raise SystemExit("%s: まとめ書き %d + 底本にない節 %d に対し空の節が %d 件"
                             % (key, spans, gone, blank))
        chapters = sum(len(b) for b in data.values())
        print("%-4s %2d巻 %5d章 %6d節%s  %6.1f MB"
              % (key, len(data), chapters, verses,
                 ("（まとめ書き %d・底本にない節 %d）" % (spans, gone)) if blank else "",
                 size / 1048576))
    print("meta.js %.1f KB" % (build_meta(sets, marks) / 1024))


if __name__ == "__main__":
    main()
