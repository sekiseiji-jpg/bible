/* ===== 聖書 Bible =====
 * 旧約・新約聖書ビューア
 *   日本語 = 口語訳聖書（1954/1955）
 *   英語   = King James Version（1769）
 *
 * 本文は data/<訳>/<巻番号>.js に JSONP 形式で保存してある。
 * file:// から開いても読めるよう fetch ではなく <script> で読み込む。
 */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- 定数 */

  var STORE_KEY = 'bible.v1';
  var MAX_HISTORY = 24;
  var PAGE_HITS = 200;          // 検索結果の 1 ページ分
  var TR_JA_DEFAULT = 'ja';
  var SIZE_MIN = 13;
  var SIZE_MAX = 34;

  /* ------------------------------------------------------------ 状態管理 */

  var META = null;              // data/meta.js の内容
  var BOOK = {};                // 巻番号 -> 書誌
  var TR = {};                  // 訳 id -> 訳情報
  var DATA = {};                // 訳 -> 巻 -> [章][節] 本文
  var PLAIN = {};               // 訳 -> 巻 -> [章][節] ルビなし本文（検索用）

  var S = {
    tr: 'ja',                   // 表示する訳
    tr2: 'kjv',                 // 対訳で隣に並べる訳
    pair: false,                // 対訳表示かどうか
    book: 1, chap: 1, verse: 0,
    test: 'ot',                 // サイドバーの表示（ot | nt | mark）
    scope: 'all',               // 検索範囲
    theme: 'auto', size: 18, ruby: true, brk: true, rate: 1,
    marks: [], history: [],
    pages: {},                  // 紙の聖書のページ対応表（訳ごと）
    hymnal: '讃美歌',            // 使っている讃美歌集
    hymnNos: [],                // 最近さがした賛美歌の番号
    autoread: false,            // 開いた章を自動で記録するか
    log: [],                    // 読書記録 [{b, c, t}]
    plan: null                  // 通読プラン {kind, days, start}
  };

  var LAST = { query: '', tr: 'ja', kind: 'text', hits: [], shown: 0 };
  var omniItems = [];
  var omniIndex = -1;
  var hashLock = false;

  /* -------------------------------------------------------------- 小道具 */

  function $(id) { return document.getElementById(id); }
  function el(tag, cls) { var e = document.createElement(tag); if (cls) e.className = cls; return e; }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // カタカナ → ひらがな。tools/build_data.py の norm() と対になっている。
  function kana(s) {
    return s.replace(/[ァ-ヶ]/g, function (c) {
      return String.fromCharCode(c.charCodeAt(0) - 0x60);
    });
  }

  function normKey(s) {
    s = s.normalize('NFKC').toLowerCase().replace(/[\s'’,.\-_·・:：]/g, '');
    return kana(s);
  }

  // {漢字|かんじ} → <ruby>漢字<rt>かんじ</rt></ruby>
  function toHtml(text) {
    var out = esc(text).replace(/\{([^{}|]*)\|([^{}|]*)\}/g,
      function (_, base, read) { return '<ruby>' + base + '<rt>' + read + '</rt></ruby>'; });
    // 詩篇などの表題【…】は本文と区別して表示する
    return out.replace(/^(【[^】]*】)/, '<span class="verse-head">$1</span>');
  }

  // {漢字|かんじ} → 漢字（検索・コピー・読み上げ用）
  function toPlain(text) {
    return text.replace(/\{([^{}|]*)\|([^{}|]*)\}/g, '$1');
  }

  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2200);
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch (e) { /* 無視 */ }
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var o = JSON.parse(raw);
      for (var k in S) if (Object.prototype.hasOwnProperty.call(o, k)) S[k] = o[k];

      // 節を持たない古いしおりは章のしおりとして扱う。
      // メモ（n）など他の項目を落とさないよう、作り直さずその場で整える。
      S.marks = (S.marks || []).filter(function (m) { return m && m.b && m.c; });
      S.marks.forEach(function (m) { if (!m.v) m.v = 0; });
      sortMarks();

      // 旧版（mode: ja|njb|kjv|both ／ jaTr）からの引き継ぎ
      if (o.mode) {
        S.pair = o.mode === 'both';
        S.tr = S.pair ? (o.jaTr || TR_JA_DEFAULT) : o.mode;
        S.tr2 = 'kjv';
      }
    } catch (e) { /* 無視 */ }
  }

  /* ------------------------------------------------------- データ読み込み */

  var pending = {};

  window.BIBLE_META = function (m) { META = m; };
  window.BIBLE_PUT = function (tr, book, data) {
    (DATA[tr] || (DATA[tr] = {}))[book] = data;
  };

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error(src + ' を読み込めませんでした')); };
      document.head.appendChild(s);
    });
  }

  function loadBook(tr, book) {
    if (!DATA[tr]) DATA[tr] = {};
    if (DATA[tr][book]) return Promise.resolve(DATA[tr][book]);
    if (!has(tr, book)) return Promise.resolve(null);
    var key = tr + ':' + book;
    if (!pending[key]) {
      pending[key] = loadScript('data/' + tr + '/' + book + '.js').then(function () {
        delete pending[key];
        return DATA[tr][book];
      }, function (err) { delete pending[key]; throw err; });
    }
    return pending[key];
  }

  // 検索用のルビなし本文。必要になった巻だけ作る。
  function plainBook(tr, book) {
    if (!PLAIN[tr]) PLAIN[tr] = {};
    if (!PLAIN[tr][book]) {
      var src = (DATA[tr] || {})[book] || [];
      PLAIN[tr][book] = TR[tr].ruby
        ? src.map(function (ch) { return ch.map(toPlain); })
        : src;
    }
    return PLAIN[tr][book];
  }

  function busy(text) {
    $('loading-text').textContent = text || '読み込み中…';
    $('loading').hidden = false;
  }
  function idle() { $('loading').hidden = true; }

  /* ------------------------------------------------------------ 書誌参照 */

  // 表示中の訳。対訳のときは null（両方の多い方に合わせる）
  function activeTr() { return S.pair ? null : S.tr; }

  // 新改訳のマルコ7:16-17のように、複数の節をまとめて訳している箇所。
  // 先頭の節に本文が入り、続く節番号は空になっている。
  function bridgeEnd(tr, book, chap, verse) {
    var br = TR[tr] && TR[tr].bridges;
    var c = br && br[book] && br[book][chap];
    return (c && c[verse]) || 0;
  }

  // 「まとめ書きの続き」の節番号 -> 先頭の節番号
  function bridgeCont(tr, book, chap) {
    var br = TR[tr] && TR[tr].bridges;
    var c = br && br[book] && br[book][chap];
    var map = {};
    for (var v in c) {
      for (var k = +v + 1; k <= c[v]; k++) map[k] = +v;
    }
    return map;
  }

  // その訳がその巻を収録しているか（新改訳は新約のみ）
  function has(tr, book) {
    var b = BOOK[book];
    return !!(b && b.vc[tr] && b.vc[tr].length);
  }

  // どれかの訳が収録している章数・節数（表示中の訳が未収録のときの代わり）
  function anyChapCount(book) {
    var b = BOOK[book], n = 0;
    if (!b) return 0;
    for (var id in TR) n = Math.max(n, (b.vc[id] || []).length);
    return n;
  }

  function anyVerseCount(book, chap) {
    var b = BOOK[book], n = 0;
    if (!b) return 0;
    for (var id in TR) n = Math.max(n, (b.vc[id] || [])[chap - 1] || 0);
    return n;
  }

  function chapCount(book, tr) {
    var b = BOOK[book];
    if (!b) return 0;
    if (tr === undefined) tr = activeTr();
    if (tr) return (b.vc[tr] || []).length;
    return modeTrs().reduce(function (n, t) {
      return Math.max(n, (b.vc[t] || []).length);
    }, 0);
  }

  function verseCount(book, chap, tr) {
    var b = BOOK[book];
    if (!b) return 0;
    if (tr === undefined) tr = activeTr();
    if (tr) return (b.vc[tr] || [])[chap - 1] || 0;
    return modeTrs().reduce(function (n, t) {
      return Math.max(n, (b.vc[t] || [])[chap - 1] || 0);
    }, 0);
  }

  function modeTrs() { return S.pair ? [S.tr, S.tr2] : [S.tr]; }
  function primaryTr() { return S.tr; }
  function isEn(tr) { return TR[tr] && TR[tr].lang === 'en'; }
  // 参照の見出しに使う表記（対訳のときは両方の言語を見て決める）
  function displayMode() { return S.pair ? 'both' : S.tr; }

  // その言語の語句を検索するときに使う訳。表示中のものを優先する。
  function searchTr(lang) {
    var shown = modeTrs().filter(function (t) { return (TR[t].lang === 'en') === (lang === 'en'); });
    if (shown.length) return shown[0];
    for (var id in TR) if ((TR[id].lang === 'en') === (lang === 'en')) return id;
    return S.tr;
  }

  // 表示モードに応じた参照の見出し（例: 創世記 1章 / Genesis 1）
  function refLabel(book, chap, verse, mode) {
    var b = BOOK[book];
    if (!b) return '';
    mode = mode || displayMode();
    var ja = b.ja + ' ' + chap + '章' + (verse ? verse + '節' : '');
    var en = b.en + ' ' + chap + (verse ? ':' + verse : '');
    if (mode === 'both') {
      // 和訳どうしを並べているときに英語の参照は出さない
      var trs = modeTrs();
      var hasJa = trs.some(function (t) { return !isEn(t); });
      var hasEn = trs.some(isEn);
      if (hasJa && hasEn) return ja + ' / ' + en;
      return hasEn ? en : ja;
    }
    if (isEn(mode)) return en;
    return ja;
  }

  /* -------------------------------------------------------- 参照の解析 */

  // 末尾の「数字＋区切り」部分だけを切り出すための判定
  var TAIL_ONLY = /^[\s\d:：.,、章節篇\-–—~〜～]+$/;

  function parseRef(raw) {
    var s = raw.normalize('NFKC').trim();
    if (!s) return null;

    // 先頭から走査し、「ここから末尾まで数字と区切りだけ」になる最初の位置で切る。
    // こうすると「1コリント13:4」の先頭の 1 を章と誤解しない。
    var cut = -1;
    for (var i = 0; i < s.length; i++) {
      if (s[i] >= '0' && s[i] <= '9' && TAIL_ONLY.test(s.slice(i))) { cut = i; break; }
    }

    if (cut < 0) return { name: s, chap: 0, verse: 0, to: 0 };
    if (cut === 0) return null;   // 数字だけの入力は参照とみなさない

    var name = s.slice(0, cut).trim();
    var tail = s.slice(cut).replace(/\s+/g, '');
    var m = tail.match(/^(\d+)(?:(?:[:：.,、]|章)(\d+)(?:節)?(?:[-–—~〜～](\d+))?)?(?:章|節|篇)?$/);
    if (!m) m = [null, (tail.match(/\d+/) || [0])[0]];

    return {
      name: name,
      chap: parseInt(m[1], 10) || 0,
      verse: parseInt(m[2], 10) || 0,
      to: parseInt(m[3], 10) || 0
    };
  }

  function matchBooks(q) {
    var k = normKey(q);
    if (!k) return [];
    var out = [];
    META.books.forEach(function (b) {
      var score = 0;
      b.keys.forEach(function (key) {
        var s = 0;
        if (key === k) s = 100;
        else if (key.indexOf(k) === 0) s = 72 - Math.min(key.length - k.length, 20);
        else if (k.indexOf(key) === 0) s = 56;
        else if (k.length >= 2 && key.indexOf(k) > 0) s = 28;
        if (s > score) score = s;
      });
      if (score) out.push({ b: b, score: score });
    });
    out.sort(function (x, y) { return y.score - x.score || x.b.id - y.b.id; });
    return out;
  }

  /* ------------------------------------------------- 検索ボックスの候補 */

  function buildOmni() {
    var input = $('omni');
    var list = $('omni-list');
    var q = input.value.trim();
    $('omni-clear').hidden = !q;

    if (!q) { closeOmni(); return; }

    var items = [];

    // 賛美歌の番号（賛美歌312 / 讃美歌21 312 など）
    var hy = parseHymn(q);
    if (hy) {
      var hyName = hy.hymnal || hymnalName();
      items.push({
        kind: 'hymn', label: '賛美歌',
        ref: hyName + ' ' + hy.no + '番をさがす',
        sub: 'YouTube や Google の検索を開きます（歌入り・演奏のみ・歌詞）',
        run: function () {
          if (hy.hymnal) { S.hymnal = hy.hymnal; save(); }
          openHymn(hy.no);
        }
      });
    }

    // 紙の聖書のページ番号（p123 / 123ページ）
    var page = parsePage(q);
    if (page) {
      META.translations.forEach(function (t) {
        if (!hasPages(t.id)) return;
        var at = pageToRef(t.id, page);
        if (!at) return;
        items.push({
          kind: 'page', label: 'ページ',
          ref: page + 'ページ → ' + refLabel(at.b, at.c, at.v, isEn(t.id) ? 'kjv' : 'ja') + ' あたり',
          sub: t.full + ' のページ対応表から推定',
          run: function () { if (S.tr !== t.id) setTr(t.id); go(at.b, at.c, at.v); }
        });
      });
    }

    // ページ番号として読めたときは、書名としては解釈しない
    var ref = items.length ? null : parseRef(q);

    if (ref && ref.name) {
      matchBooks(ref.name).slice(0, 7).forEach(function (hit) {
        var b = hit.b;
        // 表示中の訳が収録していない巻は、他の訳の章立てで案内する
        var own = chapCount(b.id);
        var nCh = own || anyChapCount(b.id);
        if (!nCh) return;
        var chap = Math.min(Math.max(ref.chap || 1, 1), nCh);
        var nv = verseCount(b.id, chap) || anyVerseCount(b.id, chap);
        var verse = ref.verse ? Math.min(ref.verse, nv) : 0;
        items.push({
          kind: 'ref', label: '参照',
          ref: refLabel(b.id, chap, verse, isEn(primaryTr()) ? 'kjv' : 'ja'),
          sub: (isEn(primaryTr()) ? b.ja : b.en) + ' ・ ' + b.sja + ' ・ 全' + nCh + '章' +
            (own ? '' : '（' + TR[primaryTr()].name + 'は未収録）'),
          run: function () { go(b.id, chap, verse); }
        });
      });
    }

    // 「愛」「神」のような 1 文字の日本語でも検索できるようにする
    var minLen = /^[\x20-\x7e]+$/.test(q) ? 2 : 1;

    if (q.length >= minLen) {
      var notes = noteHits(q);
      if (notes.length) {
        items.push({
          kind: 'note', label: 'メモ',
          ref: '自分のメモから ' + notes.length + ' 件',
          sub: notes[0].n.replace(/\s+/g, ' ').slice(0, 44) +
            (notes.length > 1 ? ' ほか' : ''),
          run: function () { startNoteSearch(q); }
        });
      }
    }

    if (q.length >= minLen) {
      var tr = guessTr(q);
      items.push({
        kind: 'find', label: '全文',
        ref: '「' + q + '」を全文検索',
        sub: TR[tr].full + ' の全巻から語句を探します',
        run: function () { startSearch(q); }
      });
    }

    omniItems = items;
    omniIndex = items.length ? 0 : -1;

    if (!items.length) {
      list.innerHTML = '<li class="omni-empty">見つかりませんでした</li>';
    } else {
      list.innerHTML = items.map(function (it, i) {
        return '<li class="omni-item" role="option" data-i="' + i + '"' +
          ' aria-selected="' + (i === omniIndex) + '">' +
          '<span class="omni-kind ' + it.kind + '">' + it.label + '</span>' +
          '<span class="omni-main"><span class="omni-ref">' + esc(it.ref) + '</span>' +
          '<span class="omni-sub">' + esc(it.sub) + '</span></span></li>';
      }).join('');
    }
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }

  function closeOmni() {
    $('omni-list').hidden = true;
    $('omni').setAttribute('aria-expanded', 'false');
    omniItems = [];
    omniIndex = -1;
  }

  function moveOmni(d) {
    if (!omniItems.length) return;
    omniIndex = (omniIndex + d + omniItems.length) % omniItems.length;
    [].forEach.call($('omni-list').children, function (li, i) {
      li.setAttribute('aria-selected', i === omniIndex);
      if (i === omniIndex && li.scrollIntoView) li.scrollIntoView({ block: 'nearest' });
    });
  }

  function runOmni() {
    var it = omniItems[omniIndex >= 0 ? omniIndex : 0];
    if (!it) return;
    closeOmni();
    $('omni').blur();
    it.run();
  }

  // 問い合わせの文字種から検索対象の訳を決める（英字だけなら KJV）
  function guessTr(q) {
    var latin = /[A-Za-z]/.test(q) && !/[　-ヿ㐀-鿿ｦ-ﾟ]/.test(q);
    return searchTr(latin ? 'en' : 'ja');
  }

  /* ------------------------------------------------------------ 本文表示 */

  function go(book, chap, verse) {
    openChapter(book, chap, verse);
  }

  function openChapter(book, chap, verse) {
    book = Math.min(Math.max(book | 0, 1), 66);
    var nCh = chapCount(book);
    chap = nCh ? Math.min(Math.max(chap | 0 || 1, 1), nCh) : 1;
    verse = verse | 0;

    S.book = book; S.chap = chap; S.verse = verse;

    var trs = modeTrs();
    var slow = trs.some(function (t) { return has(t, book) && !(DATA[t] || {})[book]; });
    if (slow) busy('本文を読み込んでいます…');

    return Promise.all(trs.map(function (t) { return loadBook(t, book); }))
      .then(function () {
        idle();
        showView('read');
        renderChapter(verse);
        syncPicker();
        syncSidebar();
        pushHistory(book, chap);
        // 章数の上限で丸めた結果も URL に反映させる
        setHash(S.book, S.chap, S.verse);
        save();
      })
      .catch(function (err) {
        idle();
        toast(err.message || '本文を読み込めませんでした');
      });
  }

  function renderChapter(targetVerse) {
    var book = S.book, chap = S.chap;
    var b = BOOK[book];
    var box = $('verses');
    var trs = modeTrs();

    $('chapter-title').textContent = refLabel(book, chap, 0);

    var names = trs.map(function (t) { return TR[t].full; }).join(' ／ ');
    var nv = verseCount(book, chap);
    var page = hasPages(primaryTr())
      ? refToPage(primaryTr(), book, chap, S.verse) : 0;
    $('chapter-sub').textContent = [
      isEn(primaryTr()) ? b.sen : b.sja,
      nv ? nv + '節' : null,
      page ? '約' + page + 'ページ' : null,
      names
    ].filter(Boolean).join(' ・ ');

    var html = [];
    if (S.pair) {
      var L = S.tr, R = S.tr2;
      var lv = ((DATA[L] || {})[book] || [])[chap - 1] || [];
      var rv = ((DATA[R] || {})[book] || [])[chap - 1] || [];
      var n = Math.max(lv.length, rv.length);
      var lc = bridgeCont(L, book, chap);
      var rc = bridgeCont(R, book, chap);
      if (!n) html.push(missingHtml());
      else if (!lv.length) html.push(missingHtml(L, book));
      else if (!rv.length) html.push(missingHtml(R, book));
      for (var i = 0; i < n; i++) {
        html.push('<div class="verse pair' + (isMarked(book, chap, i + 1) ? ' is-marked' : '') +
          '" id="v' + (i + 1) + '" data-v="' + (i + 1) + '">' +
          verseNoHtml(i + 1, 0) +
          '<span class="verse-body' + (isEn(L) ? ' en' : '') + '">' +
          verseHtml(L, lv[i], lc[i + 1]) + '</span>' +
          '<span class="verse-body' + (isEn(R) ? ' en' : '') + '">' +
          verseHtml(R, rv[i], rc[i + 1]) + '</span>' +
          '</div>');
      }
    } else {
      var tr = S.tr;
      var vs = ((DATA[tr] || {})[book] || [])[chap - 1] || [];
      if (!vs.length) html.push(missingHtml(tr, book));
      for (var j = 0; j < vs.length; j++) {
        // まとめ書きの続きの節番号は本文を持たないので飛ばす
        if (!vs[j]) continue;
        var end = bridgeEnd(tr, book, chap, j + 1);
        html.push('<div class="verse' + (isMarked(book, chap, j + 1) ? ' is-marked' : '') +
          '" id="v' + (j + 1) + '" data-v="' + (j + 1) + '">' +
          verseNoHtml(j + 1, end) +
          '<span class="verse-body' + (isEn(tr) ? ' en' : '') + '">' +
          (TR[tr].ruby ? toHtml(vs[j]) : esc(vs[j])) + '</span></div>');
      }
    }
    box.innerHTML = html.join('');

    var view = $('view-read');
    if (targetVerse) {
      var hit = $('v' + targetVerse);
      if (hit) {
        hit.classList.add('is-target');
        hit.scrollIntoView({ block: 'center' });
      } else {
        view.scrollTop = 0;
      }
    } else {
      view.scrollTop = 0;
    }

    // しおりが付いている節の下にメモ行を足す
    [].forEach.call(box.querySelectorAll('.verse.is-marked'), function (row) {
      renderNoteRow(row, findMark(book, chap, +row.dataset.v));
    });
    renderChapterNote();

    syncReadBtn();
    scheduleAutoRead();

    var marked = isMarked(book, chap, 0);
    $('btn-mark').classList.toggle('is-on', marked);
    $('btn-mark').title = (marked ? 'この章のしおりを外す' : 'この章にしおりを付ける') +
      '（節に付けるには節番号を押してください）';

    var noPrev = !findStep(-1), noNext = !findStep(1);
    ['btn-prev', 'btn-prev2'].forEach(function (id) { $(id).disabled = noPrev; });
    ['btn-next', 'btn-next2'].forEach(function (id) { $(id).disabled = noNext; });

    stopSpeak();
  }

  // 節番号はそのまましおりの切替ボタンにする
  function verseNoHtml(v, end) {
    return '<button class="verse-no" data-mark="' + v +
      '" title="' + v + '節にしおりを付ける／外す">' + v + (end ? '-' + end : '') + '</button>';
  }

  function verseHtml(tr, text, contFrom) {
    if (!text) {
      return contFrom
        ? '<span class="pair-miss" title="' + contFrom + '節にまとめて訳されています">↑ ' +
          contFrom + '節へ</span>'
        : '<span class="pair-miss">—</span>';
    }
    return TR[tr].ruby ? toHtml(text) : esc(text);
  }

  // 収録範囲や章立ての違いで本文が出せないときの断り書き
  function missingHtml(side, book) {
    var who = side ? TR[side].full : 'この訳';

    // 新改訳のように、そもそもその巻を収録していない場合
    if (side && book && !has(side, book)) {
      var other = TR[side].lang === 'ja' ? TR_JA_DEFAULT : 'kjv';
      return '<p class="note"><b>' + esc(who) + '</b>は' +
        (BOOK[book].t === 'ot' ? '新約聖書のみを収録しています。' : 'この巻を収録していません。') +
        '<br>' + esc(BOOK[book].ja) + 'を読むには ' +
        '<button class="link-btn" data-switch="' + other + '">' +
        esc(TR[other].name) + 'に切り替え</button> てください。</p>';
    }

    return '<p class="note">この章は<b>' + esc(who) + '</b>にはありません。<br>' +
      'ヨエル書とマラキ書は、口語訳がヘブライ語本文の章区分を採り、' +
      'KJV が別の区分を採っているため章の数が異なります。</p>';
  }

  // 現在位置から d 章ぶん進んだ先。収録していない巻は読み飛ばす。
  // 行き先がなければ null（ボタンを無効にする判定にも使う）
  function findStep(d) {
    var book = S.book;
    var chap = S.chap + d;
    for (var guard = 0; guard < 70; guard++) {
      var n = chapCount(book);
      if (n && chap >= 1 && chap <= n) return { b: book, c: chap };
      book += d;
      if (book < 1 || book > 66) return null;
      chap = d > 0 ? 1 : chapCount(book);
    }
    return null;
  }

  function step(d) {
    var at = findStep(d);
    if (at) go(at.b, at.c, 0);
  }

  /* ------------------------------------------------- 書名・章・節セレクタ */

  function fillSelect(sel, items, value) {
    sel.innerHTML = items.map(function (it) {
      return '<option value="' + it.v + '"' + (it.v === value ? ' selected' : '') + '>' + esc(it.t) + '</option>';
    }).join('');
  }

  // 訳の切替ボタンと、対訳の相手プルダウンを組み立てる
  function buildTrControls() {
    $('tr-seg').innerHTML = META.translations.map(function (t) {
      return '<button class="seg-btn" data-tr="' + t.id + '" title="' + esc(t.full) + '">' +
        esc(t.name) + '</button>';
    }).join('');
  }

  function syncPartnerSelect() {
    var sel = $('sel-pair');
    sel.hidden = !S.pair;
    if (!S.pair) return;
    sel.innerHTML = META.translations
      .filter(function (t) { return t.id !== S.tr; })
      .map(function (t) {
        return '<option value="' + t.id + '"' + (t.id === S.tr2 ? ' selected' : '') + '>⇄ ' +
          esc(t.name) + '</option>';
      }).join('');
  }

  function buildBookSelect() {
    var sel = $('sel-book');
    var html = '';
    [['ot', '旧約聖書'], ['nt', '新約聖書']].forEach(function (pair) {
      html += '<optgroup label="' + pair[1] + '">';
      META.books.filter(function (b) { return b.t === pair[0]; }).forEach(function (b) {
        html += '<option value="' + b.id + '">' + esc(b.ja + '  ' + b.en) + '</option>';
      });
      html += '</optgroup>';
    });
    sel.innerHTML = html;
  }

  function syncPicker() {
    $('sel-book').value = String(S.book);

    var nCh = chapCount(S.book);
    var chaps = [];
    for (var c = 1; c <= nCh; c++) chaps.push({ v: String(c), t: c + '章' });
    if (!nCh) chaps.push({ v: '1', t: '—' });
    fillSelect($('sel-chap'), chaps, String(S.chap));

    var verses = [{ v: '0', t: '先頭' }];
    for (var v = 1; v <= verseCount(S.book, S.chap); v++) verses.push({ v: String(v), t: v + '節' });
    fillSelect($('sel-verse'), verses, String(S.verse || 0));
    $('sel-chap').disabled = !nCh;
    $('sel-verse').disabled = !nCh;
  }

  /* ------------------------------------------------------- サイドバー */

  function renderSidebar() {
    var box = $('book-list');
    var filter = normKey($('book-filter').value);

    $('book-filter').placeholder = S.test === 'mark'
      ? 'しおり・メモをしぼりこみ' : '書名でしぼりこみ';

    if (S.test === 'mark') {
      if (!S.marks.length) {
        box.innerHTML = '<p class="sidebar-empty">しおりはまだありません。<br><br>' +
          '章に付けるには本文の「🔖 しおり」、<br>節に付けるには<b>節番号</b>を押してください。</p>';
        return;
      }
      var shown = S.marks.filter(function (m) {
        if (!filter) return true;
        var b = BOOK[m.b];
        return normKey(b.ja + b.en + b.abja + m.c + ':' + (m.v || '') +
          ' ' + (m.t || '') + ' ' + (m.n || '')).indexOf(filter) >= 0;
      });

      if (!shown.length) {
        box.innerHTML = '<p class="sidebar-empty">当てはまるしおりがありません</p>';
        return;
      }

      box.innerHTML = shown.map(function (m) {
        var b = BOOK[m.b];
        var v = m.v || 0;
        return '<div class="mark-row">' +
          '<button class="book-item mark-item" data-book="' + m.b +
          '" data-chap="' + m.c + '" data-verse="' + v + '">' +
          '<span class="bi-name">' +
          '<span class="mark-ref">' + esc(b.ja) + ' ' + m.c + (v ? ':' + v : '章') + '</span>' +
          (v && m.t
            ? '<span class="mark-text">' + esc(m.t) + '</span>'
            : '<span class="bi-en">' + esc(b.en) + ' ' + m.c + (v ? ':' + v : '') + '</span>') +
          (m.n ? '<span class="mark-note">📝 ' + esc(m.n) + '</span>' : '') +
          '</span></button>' +
          '<button class="mark-edit" data-edit="' + m.b + '.' + m.c + '.' + v + '" ' +
          'title="メモを書く" aria-label="メモを書く">' + (m.n ? '📝' : '＋') + '</button>' +
          '</div>';
      }).join('');
      return;
    }

    var books = META.books.filter(function (b) {
      if (b.t !== S.test) return false;
      if (!filter) return true;
      return b.keys.some(function (k) { return k.indexOf(filter) === 0 || k.indexOf(filter) > 0; });
    });

    if (!books.length) {
      box.innerHTML = '<p class="sidebar-empty">該当する書名がありません</p>';
      return;
    }

    var html = '', group = '';
    books.forEach(function (b) {
      if (b.sja !== group) { group = b.sja; html += '<div class="book-group">' + esc(group) + '</div>'; }
      var n = chapCount(b.id);
      html += '<button class="book-item' + (b.id === S.book ? ' is-on' : '') +
        (n ? '' : ' is-off') + '" data-book="' + b.id + '"' +
        (n ? '' : ' title="' + esc(TR[primaryTr()].full) + 'は収録していません"') + '>' +
        '<span class="bi-name">' + esc(b.ja) + '<br><span class="bi-en">' + esc(b.en) + '</span></span>' +
        '<span class="bi-ch">' + (n ? n + '章' : '—') + '</span></button>';
    });
    box.innerHTML = html;
  }

  function syncSidebar() {
    var want = BOOK[S.book].t;
    if (S.test !== 'mark' && S.test !== want) {
      S.test = want;
      [].forEach.call(document.querySelectorAll('[data-test]'), function (btn) {
        btn.classList.toggle('is-on', btn.dataset.test === S.test);
      });
    }
    renderSidebar();
  }

  function drawer(on) {
    document.body.dataset.drawer = on ? 'on' : 'off';
    $('scrim').hidden = !on || window.innerWidth > 720;
  }

  /* ---------------------------------------------------------- 全文検索 */

  function startSearch(query) {
    query = query.trim();
    if (query.length < 1) return;
    var tr = guessTr(query);
    LAST.query = query;
    LAST.tr = tr;
    LAST.kind = 'text';
    $('scope-seg').hidden = false;
    showView('search');
    $('result-title').textContent = '「' + query + '」を検索中…';
    $('results').innerHTML = '';

    loadAll(tr).then(function () {
      LAST.hits = search(query, tr, S.scope);
      LAST.shown = 0;
      renderResults();
    }).catch(function (err) {
      idle();
      toast(err.message || '検索用データを読み込めませんでした');
    });
  }

  // 全文検索には全巻が必要なので、まとめて読み込む（初回のみ）
  function loadAll(tr) {
    var todo = [];
    if (!DATA[tr]) DATA[tr] = {};
    for (var b = 1; b <= 66; b++) if (has(tr, b) && !DATA[tr][b]) todo.push(b);
    if (!todo.length) return Promise.resolve();

    var done = 0;
    busy('検索用に全巻を読み込んでいます… 0 / ' + todo.length);

    function batch(i) {
      if (i >= todo.length) { idle(); return Promise.resolve(); }
      var slice = todo.slice(i, i + 8);
      return Promise.all(slice.map(function (b) {
        return loadBook(tr, b).then(function () {
          done++;
          $('loading-text').textContent = '検索用に全巻を読み込んでいます… ' + done + ' / ' + todo.length;
        });
      })).then(function () { return batch(i + 8); });
    }
    return batch(0);
  }

  function search(query, tr, scope) {
    var needle = query.normalize('NFKC');
    var ci = tr === 'kjv';
    if (ci) needle = needle.toLowerCase();

    var from = 1, to = 66;
    if (scope === 'ot') to = 39;
    else if (scope === 'nt') from = 40;
    else if (scope === 'book') { from = to = S.book; }

    var hits = [];
    for (var b = from; b <= to; b++) {
      if (!has(tr, b)) continue;
      var chapters = plainBook(tr, b);
      for (var c = 0; c < chapters.length; c++) {
        var vs = chapters[c];
        for (var v = 0; v < vs.length; v++) {
          var text = vs[v];
          if (!text) continue;   // 底本の違いによる欠番
          var hay = ci ? text.toLowerCase() : text;
          if (hay.indexOf(needle) >= 0) hits.push({ b: b, c: c + 1, v: v + 1, text: text });
        }
      }
    }
    return hits;
  }

  function renderResults() {
    var q = LAST.query, tr = LAST.tr, hits = LAST.hits;
    var scopeName = { all: '全巻', ot: '旧約聖書', nt: '新約聖書', book: BOOK[S.book].ja }[S.scope];

    $('result-title').innerHTML = '「<b>' + esc(q) + '</b>」の検索結果 ' +
      hits.length.toLocaleString() + ' 件' +
      '<span class="omni-sub"> ' + esc(TR[tr].full) + ' ・ ' + esc(scopeName) + '</span>';

    if (!hits.length) {
      // 新改訳で旧約を探したときなど、収録範囲外が理由ならそう伝える
      var outside = (S.scope === 'ot' && !has(tr, 1)) ||
        (S.scope === 'book' && !has(tr, S.book));
      $('results').innerHTML = '<p class="results-empty">' +
        (outside
          ? esc(TR[tr].full) + 'はこの範囲を収録していません。<br>検索範囲を変えてお試しください。'
          : '見つかりませんでした。<br>別の語句や検索範囲でお試しください。') +
        '</p>';
      return;
    }

    var end = Math.min(hits.length, LAST.shown + PAGE_HITS);
    var html = hits.slice(LAST.shown, end).map(function (h) {
      return '<button class="hit" data-book="' + h.b + '" data-chap="' + h.c + '" data-verse="' + h.v + '">' +
        '<div class="hit-ref">' + esc(refLabel(h.b, h.c, h.v, tr)) + '</div>' +
        '<div class="hit-text' + (isEn(tr) ? ' en' : '') + '">' + mark(h.text, q, isEn(tr)) + '</div></button>';
    }).join('');

    if (LAST.shown === 0) $('results').innerHTML = html;
    else {
      var more = $('results').querySelector('.hit-more');
      if (more) more.remove();
      $('results').insertAdjacentHTML('beforeend', html);
    }
    LAST.shown = end;

    if (end < hits.length) {
      $('results').insertAdjacentHTML('beforeend',
        '<div class="hit-more"><button class="btn" id="btn-more">' +
        'さらに ' + Math.min(PAGE_HITS, hits.length - end) + ' 件を表示（残り ' +
        (hits.length - end).toLocaleString() + ' 件）</button></div>');
      $('btn-more').onclick = renderResults;
    }
  }

  // ci: 大文字小文字を区別しないで探すか
  function mark(text, query, ci) {
    var needle = query.normalize('NFKC');
    var hay = ci ? text.toLowerCase() : text;
    var find = ci ? needle.toLowerCase() : needle;
    var out = '', at = 0;
    while (true) {
      var i = hay.indexOf(find, at);
      if (i < 0 || !find) break;
      out += esc(text.slice(at, i)) + '<mark>' + esc(text.slice(i, i + find.length)) + '</mark>';
      at = i + find.length;
    }
    return out + esc(text.slice(at));
  }

  /* ------------------------------------------------------ 読書記録 */

  var MAX_LOG = 6000;
  var autoTimer = null;
  var AUTO_MS = 60000;          // 1 分開いていたら読んだとみなす

  function dayKey(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' +
      ('0' + (d.getMonth() + 1)).slice(-2) + '-' +
      ('0' + d.getDate()).slice(-2);
  }

  function readSet() {
    var set = {};
    S.log.forEach(function (e) { set[e.b + '/' + e.c] = true; });
    return set;
  }

  function isRead(b, c) {
    for (var i = S.log.length - 1; i >= 0; i--) {
      if (S.log[i].b === b && S.log[i].c === c) return true;
    }
    return false;
  }

  function markRead(b, c) {
    var today = dayKey(Date.now());
    // 同じ日に同じ章を何度も数えない
    for (var i = S.log.length - 1; i >= 0; i--) {
      var e = S.log[i];
      if (e.b === b && e.c === c && dayKey(e.t) === today) {
        S.log.splice(i, 1);
        save();
        syncReadBtn();
        if (document.body.dataset.view === 'stats') renderStats();
        toast('今日の記録から外しました — ' + refLabel(b, c, 0, 'ja'));
        return;
      }
    }
    S.log.push({ b: b, c: c, t: Date.now() });
    if (S.log.length > MAX_LOG) S.log.splice(0, S.log.length - MAX_LOG);
    save();
    syncReadBtn();
    if (document.body.dataset.view === 'stats') renderStats();
    toast('読んだ記録に残しました — ' + refLabel(b, c, 0, 'ja'));
  }

  function readToday(b, c) {
    var today = dayKey(Date.now());
    return S.log.some(function (e) {
      return e.b === b && e.c === c && dayKey(e.t) === today;
    });
  }

  function syncReadBtn() {
    var btn = $('btn-read');
    var today = readToday(S.book, S.chap);
    var ever = today || isRead(S.book, S.chap);
    btn.classList.toggle('is-on', today);
    btn.textContent = today ? '✓ 今日読んだ' : (ever ? '✓ 読んだ（既読）' : '✓ 読んだ');
    btn.title = today ? '今日の記録から外す' : 'この章を読んだ記録に残す';
  }

  function scheduleAutoRead() {
    clearTimeout(autoTimer);
    if (!S.autoread) return;
    var b = S.book, c = S.chap;
    autoTimer = setTimeout(function () {
      if (S.book === b && S.chap === c && !readToday(b, c)) {
        S.log.push({ b: b, c: c, t: Date.now() });
        save();
        syncReadBtn();
      }
    }, AUTO_MS);
  }

  /* ------- 通読プラン ------- */

  /* 日割り表は持たず、範囲と日数から毎回計算する。
     同じ条件なら必ず同じ割り当てになるので、保存するのは 3 つだけでよい。 */

  var PLAN_KIND = {
    all:      { label: '聖書全巻', from: 1,  to: 66 },
    ot:       { label: '旧約聖書', from: 1,  to: 39 },
    nt:       { label: '新約聖書', from: 40, to: 66 },
    parallel: { label: '旧約と新約を並行' }
  };

  function chapterList(from, to) {
    var list = [];
    for (var b = from; b <= to; b++) {
      for (var c = 1; c <= canonChapters(b); c++) list.push({ b: b, c: c });
    }
    return list;
  }

  // i 日目（0 始まり）に割り当てる範囲
  function slice(list, days, i) {
    var a = Math.floor(i * list.length / days);
    var z = Math.floor((i + 1) * list.length / days);
    return list.slice(a, z);
  }

  function planDay(plan, i) {
    if (!plan || i < 0 || i >= plan.days) return [];
    if (plan.kind === 'parallel') {
      return slice(chapterList(1, 39), plan.days, i)
        .concat(slice(chapterList(40, 66), plan.days, i));
    }
    var k = PLAN_KIND[plan.kind] || PLAN_KIND.all;
    return slice(chapterList(k.from, k.to), plan.days, i);
  }

  function planTotal(plan) {
    if (!plan) return 0;
    if (plan.kind === 'parallel') return 929 + 260;
    var k = PLAN_KIND[plan.kind] || PLAN_KIND.all;
    return chapterList(k.from, k.to).length;
  }

  function midnight(key) {
    var p = key.split('-');
    return new Date(+p[0], +p[1] - 1, +p[2]).getTime();
  }

  // 開始日から数えて今日は何日目か（0 始まり）
  function planIndex(plan) {
    if (!plan) return -1;
    return Math.floor((midnight(dayKey(Date.now())) - midnight(plan.start)) / 86400000);
  }

  function planStats(plan) {
    if (!plan) return null;
    var set = readSet();
    var idx = planIndex(plan);
    var doneDays = 0, firstUndone = -1;

    for (var i = 0; i < plan.days; i++) {
      var day = planDay(plan, i);
      var ok = day.length > 0 && day.every(function (x) { return set[x.b + '/' + x.c]; });
      if (ok) doneDays++;
      else if (firstUndone < 0) firstUndone = i;
    }

    var today = planDay(plan, idx);
    var todayLeft = today.filter(function (x) { return !set[x.b + '/' + x.c]; });

    return {
      idx: idx,
      today: today,
      todayLeft: todayLeft,
      doneDays: doneDays,
      firstUndone: firstUndone,
      // 予定より何日進んでいるか（負なら遅れ）
      diff: doneDays - Math.min(Math.max(idx + 1, 0), plan.days),
      finished: doneDays >= plan.days,
      over: idx >= plan.days
    };
  }

  function planRangeLabel(list) {
    if (!list.length) return '—';
    var out = [];
    var i = 0;
    while (i < list.length) {
      var b = list[i].b, a = list[i].c, z = a;
      while (i + 1 < list.length && list[i + 1].b === b && list[i + 1].c === z + 1) {
        i++; z = list[i].c;
      }
      out.push(BOOK[b].ja + ' ' + (a === z ? a : a + '-' + z));
      i++;
    }
    return out.join('、');
  }

  /* ------- プランの設定画面 ------- */

  function openPlan() {
    var p = S.plan;
    $('plan-kind').value = p ? p.kind : 'all';
    $('plan-days').value = p ? p.days : 365;
    $('plan-start').value = p ? p.start : dayKey(Date.now());
    $('btn-plan-stop').hidden = !p;
    $('btn-plan-save').textContent = p ? '変更する' : 'はじめる';
    planPreview();
    $('plan').hidden = false;
  }

  function planPreview() {
    var days = Math.max(parseInt($('plan-days').value, 10) || 1, 1);
    var kind = $('plan-kind').value;
    var total = planTotal({ kind: kind, days: days });
    var per = (total / days).toFixed(1);
    $('plan-preview').innerHTML =
      '<b>' + esc(PLAN_KIND[kind].label) + '</b> ' + total + '章を ' + days + '日で読みます。' +
      '<br>1日およそ <b>' + per + '章</b>です。';
  }

  function savePlan() {
    var days = Math.min(Math.max(parseInt($('plan-days').value, 10) || 1, 1), 3650);
    S.plan = {
      kind: $('plan-kind').value,
      days: days,
      start: $('plan-start').value || dayKey(Date.now())
    };
    save();
    $('plan').hidden = true;
    toast('通読プランをはじめました');
    if (document.body.dataset.view === 'stats') renderStats(); else openStats();
  }

  function stopPlan() {
    if (!window.confirm('通読プランをやめますか？\n読んだ記録はそのまま残ります。')) return;
    S.plan = null;
    save();
    $('plan').hidden = true;
    toast('通読プランをやめました');
    renderStats();
  }

  /* ------- 集計 ------- */

  function canonChapters(book) { return (BOOK[book].vc.ja || []).length; }

  function computeStats() {
    var set = readSet();
    var done = { all: 0, ot: 0, nt: 0 };
    var total = { all: 0, ot: 0, nt: 0 };
    var perBook = {};

    META.books.forEach(function (bk) {
      var n = canonChapters(bk.id);
      var r = 0;
      for (var c = 1; c <= n; c++) if (set[bk.id + '/' + c]) r++;
      perBook[bk.id] = { read: r, total: n };
      total.all += n; done.all += r;
      total[bk.t] += n; done[bk.t] += r;
    });

    // 日ごとの章数
    var byDay = {};
    S.log.forEach(function (e) {
      var k = dayKey(e.t);
      byDay[k] = (byDay[k] || 0) + 1;
    });

    // 連続日数（今日か昨日から遡る）
    var streak = 0, best = 0, run = 0;
    var days = Object.keys(byDay).sort();
    var prev = null;
    days.forEach(function (k) {
      if (prev && (new Date(k) - new Date(prev)) === 86400000) run++; else run = 1;
      if (run > best) best = run;
      prev = k;
    });
    var today = dayKey(Date.now());
    var yest = dayKey(Date.now() - 86400000);
    if (byDay[today] || byDay[yest]) {
      var cur = byDay[today] ? today : yest;
      streak = 0;
      while (byDay[cur]) {
        streak++;
        cur = dayKey(new Date(cur).getTime() - 86400000);
      }
    }

    var now = Date.now();
    var within = function (ms) {
      return S.log.filter(function (e) { return now - e.t < ms; }).length;
    };

    return {
      done: done, total: total, perBook: perBook, byDay: byDay,
      streak: streak, best: best,
      today: byDay[today] || 0,
      week: within(7 * 86400000),
      month: within(30 * 86400000),
      events: S.log.length,
      days: days.length,
      first: S.log.length ? Math.min.apply(null, S.log.map(function (e) { return e.t; })) : 0
    };
  }

  /* ------- 画面 ------- */

  function pct(a, b) { return b ? Math.round(a / b * 100) : 0; }

  function barHtml(read, total, cls) {
    return '<div class="prog"><div class="prog-bar"><span class="' + (cls || '') +
      '" style="width:' + pct(read, total) + '%"></span></div>' +
      '<span class="prog-num">' + read + ' / ' + total + '　' + pct(read, total) + '%</span></div>';
  }

  function heatHtml(byDay) {
    var WEEKS = 18;
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    // 直近の土曜までを右端にする
    var end = new Date(today.getTime() + (6 - today.getDay()) * 86400000);
    var cells = [];
    for (var w = WEEKS - 1; w >= 0; w--) {
      var col = [];
      for (var d = 0; d < 7; d++) {
        var day = new Date(end.getTime() - (w * 7 + (6 - d)) * 86400000);
        var k = dayKey(day.getTime());
        var n = byDay[k] || 0;
        var lv = n === 0 ? 0 : n < 2 ? 1 : n < 4 ? 2 : n < 8 ? 3 : 4;
        var future = day.getTime() > today.getTime();
        col.push('<i class="heat l' + lv + (future ? ' future' : '') + '" title="' +
          k + ' ' + n + '章"></i>');
      }
      cells.push('<div class="heat-col">' + col.join('') + '</div>');
    }
    return '<div class="heat-grid">' + cells.join('') + '</div>';
  }

  function bookGridHtml(perBook, test) {
    return META.books.filter(function (b) { return b.t === test; }).map(function (b) {
      var p = perBook[b.id];
      var lv = p.read === 0 ? 0 : p.read >= p.total ? 4 : p.read / p.total > .66 ? 3 :
        p.read / p.total > .33 ? 2 : 1;
      return '<button class="bk l' + lv + '" data-book="' + b.id + '" title="' +
        esc(b.ja) + ' ' + p.read + '/' + p.total + '章">' +
        '<span class="bk-name">' + esc(b.abja) + '</span>' +
        '<span class="bk-num">' + p.read + '/' + p.total + '</span></button>';
    }).join('');
  }

  function planHtml() {
    var p = S.plan;
    if (!p) {
      return '<div class="plan-card plan-empty">' +
        '<div><b>通読プランを立てる</b><br>' +
        '<span class="note dim">読む範囲と日数を決めると、今日読む箇所を示します。</span></div>' +
        '<button class="btn primary" id="plan-start-btn">はじめる</button></div>';
    }

    var ps = planStats(p);
    var set = readSet();
    var h = [];

    h.push('<div class="plan-card">');
    h.push('<div class="plan-top">' +
      '<span class="plan-name">' + esc(PLAN_KIND[p.kind].label) + ' ' + p.days + '日</span>' +
      '<button class="btn ghost" id="plan-edit-btn">変更</button></div>');

    if (ps.idx < 0) {
      h.push('<p class="note">' + esc(p.start) + ' から始まります。</p>');
    } else if (ps.finished) {
      h.push('<p class="note"><b>通読を終えました。</b>おつかれさまでした。</p>');
    } else {
      var dayNo = Math.min(ps.idx + 1, p.days);
      var state = ps.diff > 0 ? '予定より ' + ps.diff + '日 進んでいます'
        : ps.diff < 0 ? '予定より ' + (-ps.diff) + '日 遅れています'
        : '予定どおりです';

      h.push('<div class="plan-meta">' +
        '<span>第 <b>' + dayNo + '</b> / ' + p.days + ' 日</span>' +
        '<span class="plan-diff ' + (ps.diff < 0 ? 'late' : ps.diff > 0 ? 'ahead' : '') + '">' +
        esc(state) + '</span></div>');
      h.push(barHtml(ps.doneDays, p.days));

      if (ps.over) {
        h.push('<p class="note">期間を過ぎています。残りは ' +
          (p.days - ps.doneDays) + '日分です。</p>');
      }

      h.push('<h4 class="plan-sub">今日の分</h4>');
      if (!ps.today.length) {
        h.push('<p class="note dim">今日の割り当てはありません。</p>');
      } else {
        h.push('<p class="plan-range">' + esc(planRangeLabel(ps.today)) + '</p>');
        h.push('<div class="chips">' + ps.today.map(function (x) {
          var done = !!set[x.b + '/' + x.c];
          return '<button class="chip plan-ch' + (done ? ' done' : '') +
            '" data-book="' + x.b + '" data-chap="' + x.c + '">' +
            (done ? '✓ ' : '') + esc(BOOK[x.b].abja) + ' ' + x.c + '</button>';
        }).join('') + '</div>');
        h.push(ps.todayLeft.length
          ? '<p class="note dim">残り ' + ps.todayLeft.length + '章</p>'
          : '<p class="note"><b>今日の分は読み終わりました。</b></p>');
      }

      if (ps.firstUndone >= 0 && ps.firstUndone < ps.idx) {
        var back = planDay(p, ps.firstUndone);
        h.push('<h4 class="plan-sub">まだ読んでいない一番古い日（第' + (ps.firstUndone + 1) + '日）</h4>');
        h.push('<p class="plan-range">' + esc(planRangeLabel(back)) + '</p>');
        h.push('<div class="chips">' + back.slice(0, 12).map(function (x) {
          return '<button class="chip" data-book="' + x.b + '" data-chap="' + x.c + '">' +
            esc(BOOK[x.b].abja) + ' ' + x.c + '</button>';
        }).join('') + '</div>');
      }
    }
    h.push('</div>');
    return h.join('');
  }

  function renderStats() {
    var st = computeStats();
    var h = [];

    h.push(planHtml());

    h.push('<div class="stat-cards">' +
      statCard('読んだ章', st.done.all, '/ ' + st.total.all) +
      statCard('達成率', pct(st.done.all, st.total.all) + '%', '') +
      statCard('連続', st.streak, '日') +
      statCard('最長', st.best, '日') +
      statCard('今日', st.today, '章') +
      statCard('今週', st.week, '章') +
      '</div>');

    h.push('<h3 class="stat-head">進みぐあい</h3>');
    h.push('<div class="stat-rows">' +
      '<div class="stat-row"><span class="stat-key">聖書全体</span>' + barHtml(st.done.all, st.total.all) + '</div>' +
      '<div class="stat-row"><span class="stat-key">旧約聖書</span>' + barHtml(st.done.ot, st.total.ot, 'ot') + '</div>' +
      '<div class="stat-row"><span class="stat-key">新約聖書</span>' + barHtml(st.done.nt, st.total.nt, 'nt') + '</div>' +
      '</div>');

    h.push('<h3 class="stat-head">読んだ日（直近18週）</h3>');
    h.push(heatHtml(st.byDay));
    h.push('<p class="note dim">記録のある日は ' + st.days + ' 日、のべ ' + st.events + ' 章' +
      (st.first ? '（' + dayKey(st.first) + ' から）' : '') + '</p>');

    h.push('<h3 class="stat-head">旧約聖書</h3>');
    h.push('<div class="bk-grid">' + bookGridHtml(st.perBook, 'ot') + '</div>');
    h.push('<h3 class="stat-head">新約聖書</h3>');
    h.push('<div class="bk-grid">' + bookGridHtml(st.perBook, 'nt') + '</div>');

    var recent = S.log.slice(-15).reverse();
    h.push('<h3 class="stat-head">最近読んだ章</h3>');
    h.push(recent.length
      ? '<div class="chips">' + recent.map(function (e) {
          return '<button class="chip" data-book="' + e.b + '" data-chap="' + e.c + '">' +
            esc(BOOK[e.b].ja + ' ' + e.c) + '<small>' + dayKey(e.t).slice(5) + '</small></button>';
        }).join('') + '</div>'
      : '<p class="note dim">まだ記録がありません。本文の「✓ 読んだ」で残せます。</p>');

    $('stats').innerHTML = h.join('');
  }

  function statCard(label, value, unit) {
    return '<div class="stat-card"><span class="stat-v">' + value +
      (unit ? '<small>' + esc(unit) + '</small>' : '') + '</span>' +
      '<span class="stat-l">' + esc(label) + '</span></div>';
  }

  function statsText() {
    var st = computeStats();
    var L = [];
    L.push('聖書 読書記録  ' + dayKey(Date.now()));
    L.push('');
    L.push('読んだ章	' + st.done.all + ' / ' + st.total.all + '	' + pct(st.done.all, st.total.all) + '%');
    L.push('旧約聖書	' + st.done.ot + ' / ' + st.total.ot + '	' + pct(st.done.ot, st.total.ot) + '%');
    L.push('新約聖書	' + st.done.nt + ' / ' + st.total.nt + '	' + pct(st.done.nt, st.total.nt) + '%');
    L.push('連続	' + st.streak + '日	最長 ' + st.best + '日');
    L.push('のべ	' + st.events + '章	' + st.days + '日');
    L.push('');
    L.push('書名	読んだ章	全章	達成率');
    META.books.forEach(function (b) {
      var p = st.perBook[b.id];
      L.push(b.ja + '	' + p.read + '	' + p.total + '	' + pct(p.read, p.total) + '%');
    });
    return L.join('\n');
  }

  function copyStats() {
    copyText(statsText(), '読書記録をコピーしました');
  }

  /* -------------------------------------------- アプリとして使う */

  var installPrompt = null;    // beforeinstallprompt の控え
  var swReg = null;

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true;
  }

  function syncPwa() {
    var note = $('pwa-note');
    var btn = $('btn-install');

    if (location.protocol === 'file:') {
      btn.disabled = true;
      note.textContent = 'ファイルを直接開いているため、アプリとして追加できません。' +
        'start.command（Windows は start.bat）から開くと追加できるようになります。';
      $('btn-offline').disabled = true;
      $('offline-note').textContent = 'オフライン保存も start.command から開いたときに使えます。';
      return;
    }
    if (isStandalone()) {
      btn.disabled = true;
      btn.textContent = '追加済み';
      note.textContent = 'アプリとして開いています。';
      return;
    }
    if (installPrompt) {
      btn.disabled = false;
      btn.textContent = 'インストール';
      note.textContent = 'ホーム画面やDockに追加すると、ブラウザの枠なしで開けます。';
    } else {
      btn.disabled = true;
      note.textContent = 'ホーム画面やDockに追加すると、ブラウザの枠なしで開けます。' +
        'Safari では共有メニューの「ホーム画面に追加」から行えます。';
    }
  }

  function doInstall() {
    if (!installPrompt) return;
    installPrompt.prompt();
    installPrompt.userChoice.then(function (res) {
      if (res && res.outcome === 'accepted') toast('ホーム画面に追加しました');
      installPrompt = null;
      syncPwa();
    });
  }

  // オフライン用に全巻を取り寄せる。Service Worker が受け取って貯める。
  function dataUrls() {
    var urls = ['data/meta.js?v=12'];
    META.translations.forEach(function (t) {
      for (var b = 1; b <= 66; b++) if (has(t.id, b)) urls.push('data/' + t.id + '/' + b + '.js');
    });
    return urls;
  }

  function saveOffline() {
    var urls = dataUrls();
    var done = 0;
    var failed = 0;
    var btn = $('btn-offline');

    btn.disabled = true;
    $('offline-bar').hidden = false;
    $('offline-note').textContent = '保存しています… 0 / ' + urls.length;

    function tick() {
      done++;
      $('offline-fill').style.width = (done / urls.length * 100) + '%';
      $('offline-note').textContent = '保存しています… ' + done + ' / ' + urls.length;
    }

    function batch(i) {
      if (i >= urls.length) return Promise.resolve();
      return Promise.all(urls.slice(i, i + 8).map(function (u) {
        return fetch(u, { cache: 'no-cache' })
          .then(function (r) { if (!r.ok) failed++; }, function () { failed++; })
          .then(tick);
      })).then(function () { return batch(i + 8); });
    }

    batch(0).then(function () {
      btn.disabled = false;
      $('offline-bar').hidden = true;
      syncStorage();
      if (failed) {
        toast(failed + ' 件を保存できませんでした');
        $('offline-note').textContent = failed + ' 件を保存できませんでした。通信を確かめてもう一度お試しください。';
      } else {
        toast('オフラインで全文を読めるようになりました');
        $('offline-note').textContent = '保存しました。通信がなくても全巻を読めます。';
      }
    });
  }

  function syncStorage() {
    var out = $('offline-size');
    if (!navigator.storage || !navigator.storage.estimate) { out.textContent = ''; return; }
    navigator.storage.estimate().then(function (e) {
      var mb = (e.usage || 0) / 1048576;
      out.textContent = mb > 0.5 ? '（現在 ' + mb.toFixed(0) + 'MB）' : '';
    }, function () { out.textContent = ''; });
  }

  function watchUpdates(reg) {
    swReg = reg;
    if (reg.waiting && navigator.serviceWorker.controller) $('update-bar').hidden = false;

    reg.addEventListener('updatefound', function () {
      var sw = reg.installing;
      if (!sw) return;
      sw.addEventListener('statechange', function () {
        if (sw.state === 'installed' && navigator.serviceWorker.controller) {
          $('update-bar').hidden = false;
        }
      });
    });
  }

  function applyUpdate() {
    if (swReg && swReg.waiting) swReg.waiting.postMessage({ type: 'skip-waiting' });
    $('update-bar').hidden = true;
  }

  function setupPwa() {
    window.addEventListener('beforeinstallprompt', function (e) {
      e.preventDefault();
      installPrompt = e;
      syncPwa();
    });
    window.addEventListener('appinstalled', function () {
      installPrompt = null;
      syncPwa();
      toast('ホーム画面に追加しました');
    });

    window.addEventListener('offline', function () { toast('オフラインです（保存済みの範囲で読めます）'); });
    window.addEventListener('online', function () { toast('オンラインに戻りました'); });

    if (location.protocol !== 'http:' && location.protocol !== 'https:') return;
    if (!('serviceWorker' in navigator)) return;

    navigator.serviceWorker.register('sw.js').then(watchUpdates, function () { /* 無視 */ });

    var reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      location.reload();
    });
  }

  /* ---------------------------------------------------------- 賛美歌 */

  /* 讃美歌の訳詞と録音は曲集ごとに著作権があるため収録していない。
     番号から YouTube / Google の検索を開くだけにとどめる。 */

  var HYMN_SEARCH = {
    sing:  { site: 'youtube', words: '賛美歌 歌', label: '歌入り' },
    play:  { site: 'youtube', words: 'オルガン演奏', label: '演奏のみ' },
    lyric: { site: 'google',  words: '歌詞', label: '歌詞' }
  };

  function hymnalName() {
    return (S.hymnal || '').trim() || '賛美歌';
  }

  function hymnUrl(kind, no) {
    var k = HYMN_SEARCH[kind];
    var q = hymnalName() + ' ' + no + '番 ' + k.words;
    return k.site === 'youtube'
      ? 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q)
      : 'https://www.google.com/search?q=' + encodeURIComponent(q);
  }

  function openHymnSearch(kind, no) {
    if (!(no > 0)) { toast('番号を入れてください'); return; }
    S.hymnNos = S.hymnNos.filter(function (n) { return n !== no; });
    S.hymnNos.unshift(no);
    if (S.hymnNos.length > 12) S.hymnNos.length = 12;
    save();
    renderHymnRecent();
    window.open(hymnUrl(kind, no), '_blank', 'noopener,noreferrer');
    toast(hymnalName() + ' ' + no + '番の' + HYMN_SEARCH[kind].label + 'をさがします');
  }

  function openHymn(no) {
    var sel = $('hymn-book');
    var known = [].some.call(sel.options, function (o) { return o.value === S.hymnal; });
    sel.value = known ? S.hymnal : '';
    $('hymn-custom-row').hidden = !!sel.value;
    $('hymn-custom').value = known ? '' : (S.hymnal || '');
    if (no > 0) $('hymn-no').value = no;
    renderHymnRecent();
    $('hymn').hidden = false;
    $('hymn-no').focus();
    $('hymn-no').select();
  }

  function renderHymnRecent() {
    $('hymn-recent-wrap').hidden = !S.hymnNos.length;
    $('hymn-recent').innerHTML = S.hymnNos.map(function (n) {
      return '<button class="chip" data-hymn="' + n + '">' + n + '番</button>';
    }).join('');
  }

  function syncHymnal() {
    var sel = $('hymn-book');
    S.hymnal = sel.value || $('hymn-custom').value.trim();
    $('hymn-custom-row').hidden = !!sel.value;
    save();
  }

  // 「賛美歌312」「讃美歌21 312」「さんびか21」「hymn 100」などを拾う。
  // 曲集名に付く 21 / 第二編 は、うしろに空白があるときだけ曲集の一部とみなす。
  // そうしないと「讃美歌215」が「讃美歌21 の 5番」になってしまう。
  var HYMN_RE = new RegExp(
    '^(賛美歌|讃美歌|さんびか|サンビカ|新聖歌|聖歌|こどもさんびか|カトリック聖歌|hymn)' +
    '(?:\\s*(21|第二編)\\s+)?\\s*(\\d+)\\s*番?$', 'i');

  function parseHymn(raw) {
    var m = raw.normalize('NFKC').trim().match(HYMN_RE);
    if (!m) return null;

    var book = '';
    if (/^(新聖歌|聖歌|こどもさんびか|カトリック聖歌)$/.test(m[1])) book = m[1];
    else if (m[2] === '21') book = '讃美歌21';
    else if (m[2] === '第二編') book = '讃美歌第二編';

    var no = parseInt(m[3], 10);
    return no > 0 ? { no: no, hymnal: book } : null;
  }

  /* ------------------------------------------ 紙の聖書のページ対応 */

  /* お手元の聖書の目次から各書の開始ページを入れてもらい、
     書の中は節数で比例配分して推定する。
     S.pages = { njb: { s: { 40: 1, 41: 58, … }, last: 520 } } */

  function pageBookList(tr) {
    var t = S.pages[tr];
    if (!t || !t.s) return [];
    return Object.keys(t.s)
      .map(Number)
      .filter(function (b) { return has(tr, b) && t.s[b] > 0; })
      .sort(function (a, b) { return a - b; });
  }

  function hasPages(tr) { return pageBookList(tr).length > 1; }

  // その巻の総節数
  function bookVerses(tr, b) {
    var vc = (BOOK[b] && BOOK[b].vc[tr]) || [];
    var n = 0;
    for (var i = 0; i < vc.length; i++) n += vc[i];
    return n;
  }

  // 巻の先頭から数えて何節目か（0 始まり）
  function verseIndex(tr, b, c, v) {
    var vc = (BOOK[b] && BOOK[b].vc[tr]) || [];
    var n = 0;
    for (var i = 0; i < c - 1 && i < vc.length; i++) n += vc[i];
    return n + (v > 0 ? v - 1 : 0);
  }

  function indexToRef(tr, b, idx) {
    var vc = (BOOK[b] && BOOK[b].vc[tr]) || [];
    for (var c = 0; c < vc.length; c++) {
      if (idx < vc[c]) return { c: c + 1, v: idx + 1 };
      idx -= vc[c];
    }
    return { c: vc.length || 1, v: 1 };
  }

  // その巻が占めるページ範囲
  function bookSpan(tr, b) {
    var t = S.pages[tr];
    var list = pageBookList(tr);
    var i = list.indexOf(b);
    if (i < 0) return null;
    var from = t.s[b];
    var to = i + 1 < list.length ? t.s[list[i + 1]] : (t.last || from + 1);
    return { from: from, span: Math.max(to - from, 1) };
  }

  function pageToRef(tr, page) {
    var t = S.pages[tr];
    var list = pageBookList(tr);
    if (!t || !list.length) return null;

    for (var i = list.length - 1; i >= 0; i--) {
      var b = list[i];
      if (page < t.s[b]) continue;
      var sp = bookSpan(tr, b);
      var f = Math.min(Math.max((page - sp.from) / sp.span, 0), 0.9999);
      var at = indexToRef(tr, b, Math.floor(f * bookVerses(tr, b)));
      return { b: b, c: at.c, v: at.v };
    }
    return null;
  }

  function refToPage(tr, b, c, v) {
    var sp = bookSpan(tr, b);
    if (!sp) return 0;
    var total = bookVerses(tr, b) || 1;
    return sp.from + Math.floor(verseIndex(tr, b, c, v) / total * sp.span);
  }

  // 「p123」「123ページ」「123頁」などを拾う
  function parsePage(raw) {
    var q = raw.normalize('NFKC').trim().toLowerCase();
    var m = q.match(/^p\.?\s*(\d+)$/) || q.match(/^(\d+)\s*(?:ページ|ぺーじ|頁|p)$/);
    return m ? parseInt(m[1], 10) : 0;
  }

  function openPages(tr) {
    var sel = $('pages-tr');
    sel.innerHTML = META.translations.map(function (t) {
      return '<option value="' + t.id + '"' + (t.id === tr ? ' selected' : '') + '>' +
        esc(t.full) + '</option>';
    }).join('');
    renderPagesGrid();
    $('pages').hidden = false;
  }

  function renderPagesGrid() {
    var tr = $('pages-tr').value;
    var t = S.pages[tr] || { s: {}, last: 0 };
    $('pages-grid').innerHTML = META.books
      .filter(function (b) { return has(tr, b.id); })
      .map(function (b) {
        return '<label class="page-cell"><span>' + esc(b.ja) + '</span>' +
          '<input type="number" min="1" inputmode="numeric" data-page="' + b.id + '" value="' +
          (t.s[b.id] || '') + '"></label>';
      }).join('');
    $('pages-last').value = t.last || '';
  }

  function savePages() {
    var tr = $('pages-tr').value;
    var map = {};
    [].forEach.call($('pages-grid').querySelectorAll('[data-page]'), function (inp) {
      var n = parseInt(inp.value, 10);
      if (n > 0) map[inp.dataset.page] = n;
    });
    var last = parseInt($('pages-last').value, 10) || 0;

    if (Object.keys(map).length) S.pages[tr] = { s: map, last: last };
    else delete S.pages[tr];

    save();
    syncPageState();
    $('pages').hidden = true;
    toast(Object.keys(map).length
      ? Object.keys(map).length + ' 書のページを登録しました'
      : 'ページの登録を消しました');
    if (document.body.dataset.view === 'read') renderChapter(S.verse);
  }

  function clearPages() {
    [].forEach.call($('pages-grid').querySelectorAll('[data-page]'), function (inp) {
      inp.value = '';
    });
    $('pages-last').value = '';
  }

  function syncPageState() {
    var done = META.translations.filter(function (t) { return hasPages(t.id); });
    $('page-state').textContent = done.length
      ? done.map(function (t) { return t.name; }).join('・') + ' を登録済み'
      : '未登録';
  }

  /* -------------------------------------------------------- メモの検索 */

  // メモ・本文の抜粋・参照のどれかに当たればヒットとする
  function noteHits(query) {
    var q = query.normalize('NFKC').toLowerCase();
    if (!q) return [];
    return S.marks.filter(function (m) {
      if (!m.n) return false;
      var b = BOOK[m.b];
      var ref = b ? b.ja + ' ' + b.en + ' ' + m.c + (m.v ? ':' + m.v : '') : '';
      return (m.n + ' ' + (m.t || '') + ' ' + ref)
        .normalize('NFKC').toLowerCase().indexOf(q) >= 0;
    });
  }

  function startNoteSearch(query) {
    LAST.query = query;
    LAST.kind = 'note';
    showView('search');
    renderNoteResults(query, noteHits(query));
  }

  function renderNoteResults(q, hits) {
    $('scope-seg').hidden = true;
    $('result-title').innerHTML = 'メモの検索結果 ' + hits.length + ' 件' +
      '<span class="omni-sub"> 「' + esc(q) + '」</span>';

    if (!hits.length) {
      $('results').innerHTML = '<p class="results-empty">当てはまるメモがありませんでした。</p>';
      return;
    }

    $('results').innerHTML = hits.map(function (m) {
      var v = m.v || 0;
      return '<button class="hit" data-book="' + m.b + '" data-chap="' + m.c +
        '" data-verse="' + v + '">' +
        '<div class="hit-ref">' +
        esc(refLabel(m.b, m.c, v, isEn(primaryTr()) ? 'kjv' : 'ja')) + '</div>' +
        (m.t ? '<div class="hit-text">' + esc(m.t) + '</div>' : '') +
        '<div class="hit-note">📝 ' + mark(m.n, q, true) + '</div>' +
        '</button>';
    }).join('');
  }

  function showView(name) {
    document.body.dataset.view = name;
    $('view-read').classList.toggle('is-on', name === 'read');
    $('view-search').classList.toggle('is-on', name === 'search');
    $('view-stats').classList.toggle('is-on', name === 'stats');
  }

  function openStats() {
    renderStats();
    showView('stats');
    $('view-stats').scrollTop = 0;
  }

  /* --------------------------------------------- しおり・履歴・読み上げ */

  // しおりは章（verse = 0）と節（verse >= 1）の 2 種類
  function findMark(b, c, v) {
    v = v || 0;
    for (var i = 0; i < S.marks.length; i++) {
      var m = S.marks[i];
      if (m.b === b && m.c === c && (m.v || 0) === v) return m;
    }
    return null;
  }

  function isMarked(b, c, v) { return !!findMark(b, c, v); }

  // 巻・章・節の順に並べ替える（追加順より探しやすい）
  function sortMarks() {
    S.marks.sort(function (x, y) {
      return x.b - y.b || x.c - y.c || (x.v || 0) - (y.v || 0);
    });
  }

  function toggleMark(v) {
    var b = S.book, c = S.chap;
    v = v || 0;
    var found = findMark(b, c, v);
    var on = !!found;

    if (on) {
      // 書いたメモを黙って消さない
      if (found.n && !window.confirm(
          refLabel(b, c, v, isEn(primaryTr()) ? 'kjv' : 'ja') +
          ' のしおりにはメモがあります。\nしおりごとメモも削除しますか？')) {
        return;
      }
      S.marks = S.marks.filter(function (m) {
        return !(m.b === b && m.c === c && (m.v || 0) === v);
      });
    } else {
      var mark = { b: b, c: c, v: v };
      if (v) mark.t = verseSnippet(b, c, v);
      S.marks.push(mark);
      sortMarks();
    }
    save();

    toast((on ? 'しおりを削除しました — ' : 'しおりに追加しました — ') +
      refLabel(b, c, v, isEn(primaryTr()) ? 'kjv' : 'ja'));

    if (v) {
      var row = $('v' + v);
      if (row) {
        row.classList.toggle('is-marked', !on);
        renderNoteRow(row, on ? null : findMark(b, c, v));
      }
    } else {
      $('btn-mark').classList.toggle('is-on', !on);
      renderChapterNote();
    }
    if (S.test === 'mark') renderSidebar();
  }

  // しおり一覧に出す短い本文。付けた時点の訳から取る。
  function verseSnippet(b, c, v) {
    var tr = primaryTr();
    var raw = ((DATA[tr] || {})[b] || [])[c - 1];
    var text = raw && raw[v - 1];
    if (!text) return '';
    if (TR[tr].ruby) text = toPlain(text);
    text = text.replace(/^【[^】]*】/, '');
    return text.length > 52 ? text.slice(0, 52) + '…' : text;
  }

  /* ------------------------------------------------------------ メモ */

  var noteAt = null;

  function openNote(b, c, v) {
    var m = findMark(b, c, v);
    if (!m) return;
    noteAt = { b: b, c: c, v: v || 0 };

    $('note-ref').textContent = refLabel(b, c, v, isEn(primaryTr()) ? 'kjv' : 'ja');
    var body = v ? (m.t || verseSnippet(b, c, v)) : '';
    $('note-verse').textContent = body;
    $('note-verse').hidden = !body;
    $('note-input').value = m.n || '';
    $('btn-note-del').disabled = !m.n;

    $('note').hidden = false;
    $('note-input').focus();
  }

  function closeNote() {
    $('note').hidden = true;
    noteAt = null;
  }

  function saveNote() {
    if (!noteAt) return;
    var m = findMark(noteAt.b, noteAt.c, noteAt.v);
    if (m) {
      var text = $('note-input').value.trim();
      if (text) m.n = text; else delete m.n;
      save();
      toast(text ? 'メモを保存しました' : 'メモを消しました');
    }
    var at = noteAt;
    closeNote();
    refreshNotes(at);
  }

  function clearNote() {
    $('note-input').value = '';
    saveNote();
  }

  // メモを書き換えたあと、本文と一覧の表示を合わせる
  function refreshNotes(at) {
    if (at && at.b === S.book && at.c === S.chap) {
      if (at.v) {
        var row = $('v' + at.v);
        if (row) renderNoteRow(row, findMark(at.b, at.c, at.v));
      } else {
        renderChapterNote();
      }
    }
    if (S.test === 'mark') renderSidebar();
  }

  // 節の下に出すメモ。しおりが付いている節にだけ出す。
  function renderNoteRow(row, mark) {
    var old = row.nextElementSibling;
    if (old && old.classList.contains('note-row')) old.remove();
    if (!mark) return;

    var el = document.createElement('div');
    el.className = 'note-row' + (mark.n ? '' : ' is-empty');
    el.dataset.note = mark.v || 0;
    el.innerHTML = '<span class="note-pen">📝</span><span class="note-body">' +
      (mark.n ? esc(mark.n) : 'メモを書く') + '</span>';
    row.insertAdjacentElement('afterend', el);
  }

  function renderChapterNote() {
    var box = $('chapter-note');
    var mark = findMark(S.book, S.chap, 0);
    if (!mark) { box.hidden = true; box.innerHTML = ''; return; }
    box.hidden = false;
    box.className = 'note-row' + (mark.n ? '' : ' is-empty');
    box.dataset.note = '0';
    box.innerHTML = '<span class="note-pen">📝</span><span class="note-body">' +
      (mark.n ? esc(mark.n) : 'この章にメモを書く') + '</span>';
  }

  function pushHistory(b, c) {
    S.history = S.history.filter(function (h) { return !(h.b === b && h.c === c); });
    S.history.unshift({ b: b, c: c });
    if (S.history.length > MAX_HISTORY) S.history.length = MAX_HISTORY;
  }

  function renderHistory() {
    var box = $('history');
    if (!S.history.length) { box.innerHTML = '<span class="chips-empty">まだありません</span>'; return; }
    box.innerHTML = S.history.map(function (h) {
      return '<button class="chip" data-book="' + h.b + '" data-chap="' + h.c + '">' +
        esc(BOOK[h.b].ja + ' ' + h.c) + '</button>';
    }).join('');
  }

  function chapterText() {
    var b = BOOK[S.book], lines = [];
    var tr = primaryTr();
    var vs = ((DATA[tr] || {})[S.book] || [])[S.chap - 1] || [];
    lines.push((isEn(tr) ? b.en + ' ' + S.chap : b.ja + ' ' + S.chap + '章') + '（' + TR[tr].full + '）');
    vs.forEach(function (v, i) {
      if (v) lines.push((i + 1) + ' ' + (TR[tr].ruby ? toPlain(v) : v));
    });
    return lines.join('\n');
  }

  function copyText(text, msg) {
    var done = function () { toast(msg); };

    function fallback() {
      var ta = el('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { toast('コピーできませんでした'); }
      ta.remove();
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, fallback);
    } else fallback();
  }

  function copyChapter() {
    copyText(chapterText(), 'この章をコピーしました');
  }

  var speaking = false;

  function stopSpeak() {
    if (!window.speechSynthesis) return;
    speechSynthesis.cancel();
    speaking = false;
    $('btn-speak').classList.remove('is-on');
    $('btn-speak').textContent = '🔊 読み上げ';
  }

  function toggleSpeak() {
    if (!window.speechSynthesis) { toast('この環境では読み上げを使えません'); return; }
    if (speaking) { stopSpeak(); return; }

    var tr = primaryTr();
    var vs = ((DATA[tr] || {})[S.book] || [])[S.chap - 1] || [];
    vs = vs.filter(function (v) { return !!v; });
    if (!vs.length) return;

    speaking = true;
    $('btn-speak').classList.add('is-on');
    $('btn-speak').textContent = '⏹ 停止';

    vs.forEach(function (v, i) {
      var u = new SpeechSynthesisUtterance(
        (TR[tr].ruby ? toPlain(v) : v).replace(/[【】]/g, ' '));
      u.lang = isEn(tr) ? 'en-US' : 'ja-JP';
      u.rate = S.rate;
      if (i === vs.length - 1) u.onend = stopSpeak;
      speechSynthesis.speak(u);
    });
  }

  /* ---------------------------------------------------------- 設定反映 */

  function setSize(px) {
    S.size = Math.min(Math.max(Math.round(px), SIZE_MIN), SIZE_MAX);
    applySettings();
    save();
  }

  function applySettings() {
    document.documentElement.dataset.theme = S.theme;
    document.body.dataset.ruby = S.ruby ? 'on' : 'off';
    document.body.dataset.break = S.brk ? 'on' : 'off';
    document.documentElement.style.setProperty('--verse-size', S.size + 'px');

    $('opt-size').value = S.size;
    $('opt-size-out').textContent = S.size + 'px';
    $('size-now').textContent = S.size;
    $('btn-size-down').disabled = S.size <= SIZE_MIN;
    $('btn-size-up').disabled = S.size >= SIZE_MAX;
    $('opt-ruby').checked = S.ruby;
    $('opt-break').checked = S.brk;
    $('opt-autoread').checked = S.autoread;
    $('opt-theme').value = S.theme;
    $('opt-rate').value = S.rate;
    $('opt-rate-out').textContent = Number(S.rate).toFixed(1);

    [].forEach.call(document.querySelectorAll('[data-tr]'), function (btn) {
      btn.classList.toggle('is-on', btn.dataset.tr === S.tr);
    });
    $('btn-pair').setAttribute('aria-pressed', String(S.pair));
    syncPartnerSelect();
    [].forEach.call(document.querySelectorAll('[data-test]'), function (btn) {
      btn.classList.toggle('is-on', btn.dataset.test === S.test);
    });
    [].forEach.call(document.querySelectorAll('[data-scope]'), function (btn) {
      btn.classList.toggle('is-on', btn.dataset.scope === S.scope);
    });
  }

  // 対訳の相手は表示中の訳と重ならないようにする
  function otherTr(not) {
    var ids = META.translations.map(function (t) { return t.id; });
    for (var i = 0; i < ids.length; i++) {
      if (ids[i] !== not && isEn(ids[i]) !== isEn(not)) return ids[i];
    }
    for (var j = 0; j < ids.length; j++) if (ids[j] !== not) return ids[j];
    return not;
  }

  function refresh() {
    applySettings();
    save();
    if (document.body.dataset.view === 'search' && LAST.query) {
      if (LAST.kind === 'note') startNoteSearch(LAST.query);
      else startSearch(LAST.query);
    } else {
      openChapter(S.book, S.chap, S.verse);
    }
  }

  function setTr(id) {
    if (!TR[id] || S.tr === id) return;
    S.tr = id;
    if (S.tr2 === id) S.tr2 = otherTr(id);
    refresh();
  }

  function setPartner(id) {
    if (!TR[id] || id === S.tr || S.tr2 === id) return;
    S.tr2 = id;
    if (S.pair) refresh(); else { applySettings(); save(); }
  }

  function setPair(on) {
    if (S.pair === on) return;
    S.pair = on;
    if (on && (S.tr2 === S.tr || !TR[S.tr2])) S.tr2 = otherTr(S.tr);
    refresh();
  }

  /* ------------------------------------------------------------ ハッシュ */

  function setHash(b, c, v) {
    hashLock = true;
    location.replace('#' + b + '/' + c + (v ? '/' + v : ''));
    setTimeout(function () { hashLock = false; }, 0);
  }

  function readHash() {
    var m = location.hash.match(/^#(\d+)\/(\d+)(?:\/(\d+))?$/);
    if (!m) return null;
    return { b: +m[1], c: +m[2], v: +(m[3] || 0) };
  }

  /* ------------------------------------------------------------ 初期化 */

  function wire() {
    // 検索ボックス
    var omni = $('omni');
    omni.addEventListener('input', buildOmni);
    omni.addEventListener('focus', function () { if (omni.value.trim()) buildOmni(); });
    omni.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveOmni(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveOmni(-1); }
      else if (e.key === 'Enter') { e.preventDefault(); runOmni(); }
      else if (e.key === 'Escape') { closeOmni(); omni.blur(); }
    });
    $('omni-list').addEventListener('mousedown', function (e) {
      var li = e.target.closest('.omni-item');
      if (!li) return;
      e.preventDefault();
      omniIndex = +li.dataset.i;
      runOmni();
    });
    $('omni-clear').addEventListener('click', function () {
      omni.value = ''; closeOmni(); omni.focus(); $('omni-clear').hidden = true;
    });
    document.addEventListener('mousedown', function (e) {
      if (!e.target.closest('.omni')) closeOmni();
    });

    // 訳の切替
    $('tr-seg').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-tr]');
      if (btn) setTr(btn.dataset.tr);
    });
    $('btn-pair').addEventListener('click', function () { setPair(!S.pair); });
    $('sel-pair').addEventListener('change', function () { setPartner(this.value); });

    // 旧約・新約・しおり
    [].forEach.call(document.querySelectorAll('[data-test]'), function (btn) {
      btn.addEventListener('click', function () {
        S.test = btn.dataset.test;
        applySettings();
        renderSidebar();
        save();
      });
    });

    $('book-filter').addEventListener('input', renderSidebar);

    $('book-list').addEventListener('click', function (e) {
      var ed = e.target.closest('[data-edit]');
      if (ed) {
        var at = ed.dataset.edit.split('.');
        openNote(+at[0], +at[1], +at[2]);
        return;
      }
      var it = e.target.closest('[data-book]');
      if (!it) return;
      go(+it.dataset.book, +(it.dataset.chap || 1), +(it.dataset.verse || 0));
      if (window.innerWidth <= 720) drawer(false);
    });

    // 書名・章・節
    $('sel-book').addEventListener('change', function () { go(+this.value, 1, 0); });
    $('sel-chap').addEventListener('change', function () { go(S.book, +this.value, 0); });
    $('sel-verse').addEventListener('change', function () { go(S.book, S.chap, +this.value); });

    ['btn-prev', 'btn-prev2'].forEach(function (id) { $(id).addEventListener('click', function () { step(-1); }); });
    ['btn-next', 'btn-next2'].forEach(function (id) { $(id).addEventListener('click', function () { step(1); }); });

    // 本文の節をクリックしたら参照を選択状態にする
    $('verses').addEventListener('click', function (e) {
      var sw = e.target.closest('[data-switch]');
      if (sw) { setTr(sw.dataset.switch); return; }

      var mk = e.target.closest('[data-mark]');
      if (mk) { toggleMark(+mk.dataset.mark); return; }

      var nt = e.target.closest('[data-note]');
      if (nt) { openNote(S.book, S.chap, +nt.dataset.note); return; }

      var v = e.target.closest('.verse');
      if (!v) return;
      [].forEach.call($('verses').querySelectorAll('.is-target'), function (x) { x.classList.remove('is-target'); });
      v.classList.add('is-target');
      S.verse = +v.dataset.v;
      $('sel-verse').value = String(S.verse);
      setHash(S.book, S.chap, S.verse);
    });

    $('btn-size-down').addEventListener('click', function () { setSize(S.size - 1); });
    $('btn-size-up').addEventListener('click', function () { setSize(S.size + 1); });

    $('btn-speak').addEventListener('click', toggleSpeak);
    $('btn-copy').addEventListener('click', copyChapter);
    $('btn-mark').addEventListener('click', function () { toggleMark(0); });
    $('btn-read').addEventListener('click', function () { markRead(S.book, S.chap); });

    $('btn-stats').addEventListener('click', openStats);
    $('btn-stats-back').addEventListener('click', function () { showView('read'); });
    $('btn-stats-copy').addEventListener('click', copyStats);

    $('stats').addEventListener('click', function (e) {
      if (e.target.closest('#plan-start-btn, #plan-edit-btn')) openPlan();
    });
    $('btn-plan-close').addEventListener('click', function () { $('plan').hidden = true; });
    $('plan').addEventListener('click', function (e) {
      if (e.target === $('plan')) $('plan').hidden = true;
    });
    $('btn-plan-save').addEventListener('click', savePlan);
    $('btn-plan-stop').addEventListener('click', stopPlan);
    $('plan-kind').addEventListener('change', planPreview);
    $('plan-days').addEventListener('input', planPreview);
    document.querySelector('.plan-presets').addEventListener('click', function (e) {
      var c = e.target.closest('[data-days]');
      if (!c) return;
      $('plan-days').value = c.dataset.days;
      planPreview();
    });
    $('stats').addEventListener('click', function (e) {
      var it = e.target.closest('[data-book]');
      if (it) go(+it.dataset.book, +(it.dataset.chap || 1), 0);
    });
    $('chapter-note').addEventListener('click', function () { openNote(S.book, S.chap, 0); });

    $('btn-note-close').addEventListener('click', closeNote);
    $('btn-note-save').addEventListener('click', saveNote);
    $('btn-note-del').addEventListener('click', clearNote);
    $('note').addEventListener('click', function (e) { if (e.target === $('note')) closeNote(); });
    $('note-input').addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); saveNote(); }
    });

    // 検索結果
    $('results').addEventListener('click', function (e) {
      var hit = e.target.closest('.hit');
      if (!hit) return;
      go(+hit.dataset.book, +hit.dataset.chap, +hit.dataset.verse);
    });
    [].forEach.call(document.querySelectorAll('[data-scope]'), function (btn) {
      btn.addEventListener('click', function () {
        S.scope = btn.dataset.scope;
        applySettings();
        save();
        if (LAST.query && LAST.kind !== 'note') startSearch(LAST.query);
      });
    });
    $('btn-back').addEventListener('click', function () { showView('read'); });

    // サイドバー（狭い画面）
    $('btn-menu').addEventListener('click', function () {
      drawer(document.body.dataset.drawer !== 'on');
    });
    $('scrim').addEventListener('click', function () { drawer(false); });

    // 設定
    $('btn-settings').addEventListener('click', function () {
      renderHistory();
      syncPageState();
      syncPwa();
      syncStorage();
      $('settings').hidden = false;
    });

    $('btn-install').addEventListener('click', doInstall);
    $('btn-offline').addEventListener('click', saveOffline);
    $('btn-update').addEventListener('click', applyUpdate);
    $('btn-update-skip').addEventListener('click', function () { $('update-bar').hidden = true; });

    $('btn-hymn').addEventListener('click', function () { openHymn(0); });
    $('btn-hymn-close').addEventListener('click', function () { $('hymn').hidden = true; });
    $('hymn').addEventListener('click', function (e) {
      if (e.target === $('hymn')) $('hymn').hidden = true;
    });
    $('hymn-book').addEventListener('change', function () {
      syncHymnal();
      if (!this.value) $('hymn-custom').focus();
    });
    $('hymn-custom').addEventListener('input', syncHymnal);
    [].forEach.call(document.querySelectorAll('.hymn-go'), function (btn) {
      btn.addEventListener('click', function () {
        openHymnSearch(btn.dataset.kind, parseInt($('hymn-no').value, 10) || 0);
      });
    });
    $('hymn-recent').addEventListener('click', function (e) {
      var c = e.target.closest('[data-hymn]');
      if (c) { $('hymn-no').value = c.dataset.hymn; $('hymn-no').focus(); }
    });
    $('hymn-no').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        openHymnSearch('sing', parseInt(this.value, 10) || 0);
      }
    });

    $('btn-pages').addEventListener('click', function () {
      $('settings').hidden = true;
      openPages(primaryTr());
    });
    $('pages-tr').addEventListener('change', renderPagesGrid);
    $('btn-pages-save').addEventListener('click', savePages);
    $('btn-pages-clear').addEventListener('click', clearPages);
    $('btn-pages-close').addEventListener('click', function () { $('pages').hidden = true; });
    $('pages').addEventListener('click', function (e) {
      if (e.target === $('pages')) $('pages').hidden = true;
    });
    $('btn-settings-close').addEventListener('click', function () { $('settings').hidden = true; });
    $('settings').addEventListener('click', function (e) {
      if (e.target === $('settings')) $('settings').hidden = true;
    });
    $('history').addEventListener('click', function (e) {
      var c = e.target.closest('[data-book]');
      if (!c) return;
      $('settings').hidden = true;
      go(+c.dataset.book, +c.dataset.chap, 0);
    });

    $('opt-size').min = SIZE_MIN;
    $('opt-size').max = SIZE_MAX;
    $('opt-size').addEventListener('input', function () { setSize(+this.value); });
    $('opt-ruby').addEventListener('change', function () {
      S.ruby = this.checked; applySettings(); save();
    });
    $('opt-break').addEventListener('change', function () {
      S.brk = this.checked; applySettings(); save();
    });
    $('opt-autoread').addEventListener('change', function () {
      S.autoread = this.checked; save();
      if (this.checked) scheduleAutoRead(); else clearTimeout(autoTimer);
      toast(this.checked ? '開いた章を自動で記録します' : '自動記録をやめました');
    });
    $('opt-theme').addEventListener('change', function () {
      S.theme = this.value; applySettings(); save();
    });
    $('opt-rate').addEventListener('input', function () {
      S.rate = +this.value; applySettings(); save();
    });

    // キーボード
    document.addEventListener('keydown', function (e) {
      var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === 'Escape') {
        if (!$('plan').hidden) { $('plan').hidden = true; return; }
        if (!$('hymn').hidden) { $('hymn').hidden = true; return; }
        if (!$('pages').hidden) { $('pages').hidden = true; return; }
        if (!$('note').hidden) { closeNote(); return; }
        if (!$('settings').hidden) { $('settings').hidden = true; return; }
        if (document.body.dataset.drawer === 'on') { drawer(false); return; }
        if (document.body.dataset.view !== 'read') { showView('read'); return; }
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); $('omni').focus(); $('omni').select(); }
      else if (e.key === '-' || e.key === '_') { setSize(S.size - 1); }
      else if (e.key === '+' || e.key === '=') { setSize(S.size + 1); }
      else if (e.key === 'ArrowLeft') { step(-1); }
      else if (e.key === 'ArrowRight') { step(1); }
      else if (e.key === 'b' || e.key === 'B') { drawer(document.body.dataset.drawer !== 'on'); }
      else if (e.key === 'h' || e.key === 'H') { openHymn(0); }
      else if (e.key === 'r' || e.key === 'R') { openStats(); }
      else if (e.key >= '1' && e.key <= '9') {
        var n = +e.key - 1;
        if (n < META.translations.length) setTr(META.translations[n].id);
        else if (n === META.translations.length) setPair(!S.pair);
      }
    });

    window.addEventListener('hashchange', function () {
      if (hashLock) return;
      var h = readHash();
      if (!h) return;
      if (h.b === S.book && h.c === S.chap && h.v === S.verse) return;
      openChapter(h.b, h.c, h.v);
    });

    window.addEventListener('resize', function () {
      if (window.innerWidth > 720) { $('scrim').hidden = true; }
    });
  }

  function start() {
    META.books.forEach(function (b) { BOOK[b.id] = b; });
    META.translations.forEach(function (t) { TR[t.id] = t; });

    if (!S.pages || typeof S.pages !== 'object') S.pages = {};
    if (!Array.isArray(S.hymnNos)) S.hymnNos = [];
    if (!Array.isArray(S.log)) S.log = [];
    if (S.plan && (!PLAN_KIND[S.plan.kind] || !S.plan.days || !S.plan.start)) S.plan = null;
    S.log = S.log.filter(function (e) { return e && e.b && e.c && e.t; });
    if (!TR[S.tr]) S.tr = TR_JA_DEFAULT;
    if (!TR[S.tr2] || S.tr2 === S.tr) S.tr2 = otherTr(S.tr);
    buildTrControls();
    buildBookSelect();
    applySettings();
    wire();
    renderSidebar();

    var h = readHash();
    openChapter(h ? h.b : S.book, h ? h.c : S.chap, h ? h.v : S.verse);

    setupPwa();
  }

  load();
  document.documentElement.dataset.theme = S.theme;
  busy('聖書データを準備しています…');
  loadScript('data/meta.js?v=12').then(function () {
    idle();
    start();
  }, function () {
    idle();
    document.body.innerHTML = '<div style="padding:40px;font-family:sans-serif;line-height:1.9">' +
      '<h1>データを読み込めませんでした</h1>' +
      '<p><code>data/meta.js</code> が見つかりません。<br>' +
      'index.html と data フォルダを同じ場所に置いてから開き直してください。</p></div>';
  });
})();
