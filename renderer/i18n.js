/* Live Studio — interface language.
 * The interface is written in English in the code. When another language is chosen, every text that appears on
 * screen (and every tooltip and placeholder) is swapped for its translation the moment it appears — so new panels,
 * windows and messages are translated too, and switching back to English puts the English back.
 * Things that are not interface text — names you typed, device names, numbers — are left alone (built-in names
 * such as "Color Bars" or "Camera 1" are translated, since they come from the program).
 * Mark an element translate="no" to leave everything inside it as it is.
 */
(function () {
  'use strict';
  const DICTS = { ru: () => window.I18N_RU };
  const ATTRS = ['title', 'placeholder', 'aria-label'];
  let lang = 'en', dict = null, pats = [], cache = new Map(), mo = null;
  const misses = window.I18N_DEBUG ? new Set() : null; // (tests: texts on screen that have no translation)
  const textRec = new WeakMap(); // text node → { en, out }
  const attrRec = new WeakMap(); // element → { attr: { en, out } }
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function compile(d) {
    pats = d.tpl.map(([en, out]) => {
      const order = [];
      const src = en.split(/(\{\d\})/).map(p => {
        const m = /^\{(\d)\}$/.exec(p);
        if (m) { order.push(+m[1]); return '([\\s\\S]*?)'; }
        return esc(p);
      }).join('');
      return { rx: new RegExp('^' + src + '$'), order, out, lit: en.replace(/\{\d\}/g, '').length };
    }).sort((a, b) => b.lit - a.lit); // the most specific first
  }
  function core(s, depth = 0) {
    let t = dict.exact[s];
    if (t !== undefined) return t;
    // the pattern that explains most of the text (the most fixed words, the least left over)
    let best = null;
    for (const p of pats) {
      if (best && p.lit < best.p.lit) break;
      const m = p.rx.exec(s);
      if (!m) continue;
      const free = m.slice(1).reduce((a, v) => a + v.length, 0);
      if (!best || free < best.free) best = { p, m, free };
    }
    if (best) {
      const vals = {};
      best.p.order.forEach((k, i) => { vals[k] = best.m[i + 1]; });
      return best.p.out.replace(/\{(\d)\}/g, (_, k) => {
        const v = vals[k] ?? '';
        return depth < 3 && /[A-Za-z]/.test(v) ? withSpaces(v, depth + 1) : v; // e.g. “Camera 1” inside “Camera 1 — wide”
      });
    }
    // "a · b · c", "a → b → c": each piece on its own
    for (const sep of [' · ', ' → ']) {
      if (!s.includes(sep)) continue;
      const parts = s.split(sep), tp = parts.map(x => withSpaces(x, depth + 1));
      if (tp.some((x, i) => x !== parts[i])) return tp.join(sep);
    }
    return undefined;
  }
  // spaces and " · " separators around a text stay where they are
  function withSpaces(x, depth = 0) {
    const m = /^([\s·]*)([\s\S]*?)([\s·]*)$/.exec(x);
    if (!m[2]) return x;
    const t = core(m[2], depth);
    return t === undefined ? x : m[1] + t + m[3];
  }
  // the translation of one English text (the same text back when there is none)
  function tr(s) {
    if (!dict || typeof s !== 'string' || !s || !/[A-Za-z]/.test(s)) return s;
    let t = cache.get(s);
    if (t === undefined) {
      t = withSpaces(s);
      if (t === s && misses) misses.add(s);
      if (cache.size > 20000) cache.clear();
      cache.set(s, t);
    }
    return t;
  }

  const skip = el => !!(el && el.closest && el.closest('script,style,textarea,[translate="no"]'));
  function doText(n) {
    const cur = n.data, rec = textRec.get(n);
    const en = rec && cur === rec.out ? rec.en : cur; // our own translation → its English; anything else is new English
    const out = tr(en);
    if (out !== en || rec) textRec.set(n, { en, out });
    if (out !== cur) n.data = out;
  }
  function doAttr(el, a) {
    if (!el.hasAttribute(a)) return;
    const cur = el.getAttribute(a);
    let r = attrRec.get(el);
    const rec = r && r[a];
    const en = rec && cur === rec.out ? rec.en : cur;
    const out = tr(en);
    if (out !== en || rec) { if (!r) attrRec.set(el, r = {}); r[a] = { en, out }; }
    if (out !== cur) el.setAttribute(a, out);
  }
  function walk(root) {
    if (!root) return;
    if (root.nodeType === 3) { if (!skip(root.parentElement)) doText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1 && skip(root)) return;
    if (root.nodeType === 1) for (const a of ATTRS) doAttr(root, a);
    const w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: n => n.nodeType === 1 && /^(SCRIPT|STYLE|TEXTAREA)$/.test(n.tagName) || n.nodeType === 1 && n.getAttribute('translate') === 'no' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
    });
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      if (n.nodeType === 3) doText(n);
      else for (const a of ATTRS) doAttr(n, a);
    }
  }
  function observe(on) {
    if (on && !mo) {
      mo = new MutationObserver(list => {
        for (const m of list) {
          if (m.type === 'characterData') { if (!skip(m.target.parentElement)) doText(m.target); }
          else if (m.type === 'attributes') { if (!skip(m.target)) doAttr(m.target, m.attributeName); }
          else for (const a of m.addedNodes) walk(a);
        }
      });
      mo.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    } else if (!on && mo) { mo.disconnect(); mo = null; }
  }

  function setLang(l) {
    l = DICTS[l] && DICTS[l]() ? l : 'en';
    lang = l;
    dict = l === 'en' ? null : DICTS[l]();
    cache = new Map();
    if (dict) compile(dict);
    document.documentElement.lang = l;
    if (document.body) walk(document.body); // what is already on screen (back to English too)
    observe(!!dict);
  }

  window.I18N = {
    tr, setLang,
    get lang() { return lang; },
    languages: [['en', 'English'], ['ru', 'Русский']],
    misses
  };
})();
