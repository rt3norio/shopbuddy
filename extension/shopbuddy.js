/*
 * ShopBuddy — turns shopping pages into compact JSON for an LLM agent.
 * Runs in the page's MAIN world (content script or injected via CDP) and exposes
 * window.ShopBuddy. Every element the agent may touch gets a short id (data-sb).
 */
(() => {
  'use strict';
  if (window.ShopBuddy && window.ShopBuddy.v) return;
  const V = '0.1.0';

  // ---------------------------------------------------------------- utils
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const ENT = { nbsp: ' ', ndash: '–', mdash: '—', amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', '#39': "'" };
  const norm = s => (s || '').replace(/&(nbsp|ndash|mdash|amp|quot|apos|lt|gt|#39);/g, (_, k) => ENT[k])
    .replace(/[\s\u00a0\u200b]+/g, ' ').trim();
  const clip = (s, n = 80) => (s && s.length > n ? s.slice(0, n - 1) + '…' : s);
  const fold = s => norm(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const cls = el => (typeof el.className === 'string' ? el.className : el.getAttribute('class') || '');
  const prune = o => {
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (v == null || v === '' || v === false || (Array.isArray(v) && !v.length)) delete o[k];
    }
    return o;
  };
  const visible = el => {
    if (!el || !el.isConnected) return false;
    if (el.checkVisibility) return el.checkVisibility({ checkVisibilityCSS: true });
    return el.getClientRects().length > 0;
  };
  const sized = el => {
    if (!visible(el)) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
  };
  const EMPTY = document.createElement('i');

  // ---------------------------------------------------------------- text
  // Accessibility-flavoured text: skips aria-hidden subtrees (sites duplicate
  // visual text there) and keeps screen-reader-only text, which is usually the
  // cleanest description. Old/struck prices are wrapped in \u0001…\u0002.
  const SKIP = /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|SVG|IFRAME|CANVAS|VIDEO|AUDIO|PICTURE|IMG|INPUT|TEXTAREA|SELECT|OPTION|LINK|META)$/i;
  const BLOCK = /^(DIV|P|LI|UL|OL|H[1-6]|TR|TD|TH|TABLE|SECTION|ARTICLE|ASIDE|HEADER|FOOTER|NAV|MAIN|FORM|DL|DT|DD|BR|FIGURE|FIGCAPTION|BUTTON|LABEL|FIELDSET)$/;
  const STRIKE_CLS = /(^|[\s_-])(original|old-?price|strike|strikethrough|before|list-?price|a-text-price|price--original|price-original|del)([\s_-]|$)/i;

  function andesMoney(el) {
    const f = $('.andes-money-amount__fraction', el);
    const aria = el.getAttribute('aria-label') || '';
    if (!f) return norm(aria);
    const c = $('.andes-money-amount__cents', el);
    const sym = norm($('.andes-money-amount__currency-symbol', el)?.textContent) || 'R$';
    const s = `${sym} ${norm(f.textContent)}${c ? ',' + norm(c.textContent) : ''}`;
    return /^antes/i.test(aria) ? `\u0001${s}\u0002` : s;
  }

  function rawText(root, max = 6000, keepHidden = false) {
    const out = [];
    let len = 0;
    const walk = n => {
      if (len > max) return;
      if (n.nodeType === 3) {
        const t = n.nodeValue;
        if (t.trim()) { out.push(t); len += t.length; }
        return;
      }
      if (n.nodeType !== 1 && n.nodeType !== 11) return;
      if (n.nodeType === 1) {
        const tag = n.tagName;
        if (SKIP.test(tag)) return;
        if ((!keepHidden && n.getAttribute('aria-hidden') === 'true') || n.hidden || n.hasAttribute('data-sb-ui')) return;
        if (n.matches('.andes-money-amount')) { out.push(' ' + andesMoney(n) + ' '); return; }
        if (n.getAttribute('role') === 'img' && n.getAttribute('aria-label')) { out.push(' ' + n.getAttribute('aria-label') + ' '); return; }
        const blk = BLOCK.test(tag);
        const strike = tag === 'S' || tag === 'DEL' || STRIKE_CLS.test(cls(n));
        if (blk) out.push('\n');
        if (strike) out.push('\u0001');
        for (const c of n.childNodes) walk(c);
        if (n.shadowRoot) walk(n.shadowRoot);
        if (strike) out.push('\u0002');
        if (blk) out.push('\n');
        return;
      }
      for (const c of n.childNodes) walk(c);
    };
    walk(root);
    return out.join('');
  }

  const strip = s => s.replace(/[\u0001\u0002]/g, '');
  function lines(root, max) {
    const res = [];
    for (const l of rawText(root, max).split('\n')) {
      const t = norm(strip(l));
      if (t && t !== res[res.length - 1]) res.push(t);
    }
    return res;
  }
  const textOf = (root, max) => norm(strip(rawText(root, max)));
  const tx = (sel, root) => { const e = $(sel, root); return e ? textOf(e, 2000) : ''; };
  // Unlike a comma selector (document order), returns the first visible match in priority order.
  const first = (...sels) => { for (const s of sels) { const e = $$(s).find(visible); if (e) return e; } };

  // ---------------------------------------------------------------- money
  const PRICE_RE = /(R\$|US\s?\$|€|£|\$)\s?(\d{1,3}(?:[.,\s]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)/g;
  const HAS_PRICE = new RegExp(PRICE_RE.source);

  function priceNum(s) {
    if (s == null) return null;
    if (typeof s === 'number') return s;
    let d = String(s).replace(/[^\d.,]/g, '');
    if (!d) return null;
    if (/,\d{1,2}$/.test(d)) d = d.replace(/[.\s]/g, '').replace(',', '.');
    else if (/\.\d{1,2}$/.test(d)) d = d.replace(/,/g, '');
    else d = d.replace(/[.,]/g, '');
    const n = parseFloat(d);
    return Number.isFinite(n) ? n : null;
  }

  // Returns {price, old} from raw text (with strike markers).
  function prices(raw) {
    let cur = null, old = null;
    for (const m of raw.matchAll(PRICE_RE)) {
      const before = raw.slice(0, m.index);
      const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 20);
      const ctx = strip(before.slice(-24));
      const struck = (before.split('\u0001').length - before.split('\u0002').length) > 0;
      const isOld = struck || /(antes|de|was|list price|pre[cç]o original)\s*:?\s*$/i.test(ctx);
      if (/(\d\s?x\s*(de)?|parcelas? de|economize|save|frete|envio|shipping|cupom)\s*:?\s*$/i.test(ctx)) continue;
      if (/^\s*(off|de desconto|sem juros|\/m[eê]s)/i.test(after)) continue;
      const n = priceNum(m[2]);
      if (n == null) continue;
      if (isOld) { if (old == null) old = n; }
      else if (cur == null) cur = n;
      if (cur != null && old != null) break;
    }
    if (old != null && cur != null && old <= cur) old = null;
    return { price: cur, old };
  }

  // ---------------------------------------------------------------- ids
  const reg = new Map();
  let seq = 0;
  for (const el of document.querySelectorAll('[data-sb]')) {
    const n = parseInt(el.getAttribute('data-sb').slice(1), 10);
    if (n > seq) seq = n;
  }

  function label(el) {
    if (!el) return '';
    let t = el.getAttribute('aria-label') || '';
    // aria-labelledby (on the element or on its inner control) may point at aria-hidden text; ARIA reads it anyway.
    const lb = !t && (el.hasAttribute('aria-labelledby') ? el : $('[aria-labelledby]', el));
    if (lb) {
      t = lb.getAttribute('aria-labelledby').split(/\s+/)
        .map(i => { const r = document.getElementById(i); return r ? strip(rawText(r, 400, true)) : ''; }).join(' ');
    }
    if (!t && /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) {
      t = (el.id && $(`label[for="${CSS.escape(el.id)}"]`)?.textContent) || el.placeholder || el.name || '';
      if (el.type === 'submit' || el.type === 'button') t = el.value || t;
    }
    if (!t) t = textOf(el, 300);
    if (!t) t = el.title || el.getAttribute('alt') || $('img[alt]', el)?.alt || '';
    if (!t) {
      const hint = `${el.id} ${cls(el)} ${el.getAttribute('data-testid') || ''}`;
      if (/increment|plus|add-one|increase/i.test(hint)) t = '+';
      else if (/decrement|minus|decrease/i.test(hint)) t = '−';
      else if (/remove|delete|trash|excluir/i.test(hint)) t = 'remover';
      else if (/close|fechar/i.test(hint)) t = 'fechar';
    }
    t = String(t).replace(/R\$\s?([\d.,]+)\s*\(?R\$\s?\1(?!\d)/g, 'R$ $1').replace(/R\$\s?([\d.,]+)\s*\(?R\$\s?\1(?!\d)/g, 'R$ $1');
    return clip(norm(String(t).replace(/\/\*[\s\S]*?(\*\/|$)/g, '').replace(/[.#]?[\w-]+\s*\{[^}]*\}/g, '')), 70);
  }

  const sigOf = el => ({ tag: el.tagName, t: label(el), href: el.getAttribute('href') || '' });

  function tag(el, p = 'a') {
    if (!el) return undefined;
    let id = el.getAttribute('data-sb');
    if (id && reg.get(id)?.el === el) return id;
    if (!id || reg.has(id)) id = p + (++seq);
    el.setAttribute('data-sb', id);
    reg.set(id, { el, sig: sigOf(el) });
    return id;
  }

  function get(id) {
    const e = reg.get(id);
    if (e && e.el.isConnected) return e.el;
    const byAttr = $(`[data-sb="${CSS.escape(id)}"]`);
    if (byAttr) return byAttr;
    if (!e) return null;
    // React re-rendered the node: find the same thing again by signature.
    const { tag: tg, t, href } = e.sig;
    const cand = $$(tg).find(x => visible(x) && (x.getAttribute('href') || '') === href && label(x) === t);
    if (cand) { cand.setAttribute('data-sb', id); e.el = cand; }
    return cand || null;
  }

  // ---------------------------------------------------------------- page helpers
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=tab],[role=option],[role=radio],[role=checkbox],[role=menuitem],[role=combobox],[role=spinbutton],[contenteditable=true]';
  const CART_RE = /(adicionar (ao|à|a) (carrinho|sacola)|colocar no carrinho|add to (cart|basket)|agregar al carrito)/i;
  const BUY_RE = /^(comprar( agora)?|buy now|comprar ahora)$/i;
  const SHIP_RE = /(frete|entrega|chega|receba|envio|enviado|retire|shipping|delivery|arrives|ship)/i;
  const CAPTCHA_URL = /captcha|\/verify\/|validatecaptcha|punish|_____tmd_____|\/challenge|errorcaptcha|\/sorry\//i;
  const CAPTCHA_TXT = /(n[aã]o sou um rob[oô]|i'?m not a robot|verify you are human|verifique se voc[eê] [eé] humano|digite os caracteres|type the characters|arraste (o controle|para)|slide to (verify|complete)|deslize para|security check|verifica[cç][aã]o de seguran[cç]a|confirme que voc[eê] n[aã]o [eé] um rob[oô])/i;
  const LOGIN_URL = /\/(login|signin|sign-in|ap\/signin|entrar|jms\/mlb\/lgz|buyer\/login)/i;

  const ancestor = (a, b) => {
    if (!a || !b) return a || b;
    const set = new Set();
    for (let x = a; x; x = x.parentElement) set.add(x);
    for (let x = b; x; x = x.parentElement) if (set.has(x)) return x;
    return document.body;
  };

  function byText(re, root = document, sel = INTERACTIVE) {
    return $$(sel, root).find(el => sized(el) && re.test(label(el)));
  }

  // A real popup floats above the page; sidebars that merely carry role=dialog do not.
  function overlay(d) {
    if (d.matches('dialog[open],[aria-modal=true]')) return true;
    for (let x = d, i = 0; x && i < 6; x = x.parentElement, i++) {
      const pos = getComputedStyle(x).position;
      if (pos === 'fixed' || pos === 'absolute') return true;
    }
    return false;
  }

  function dialogs() {
    return $$('[role=dialog],[aria-modal=true],dialog[open],.andes-modal,.a-popover[aria-hidden=false],.andes-popper,[role=listbox],' +
      '[class*=sidecart],[class*=side-cart],[class*=mini-cart],[class*=minicart],[class*=cart-drawer],#attach-desktop-sideSheet')
      .filter(d => sized(d) && !d.closest('[data-sb-ui]') && overlay(d));
  }

  function fmtAction(el, t = label(el)) {
    const p = /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable ? 'f' : 'a';
    let s = `${tag(el, p)}:${t}`;
    if (el.tagName === 'SELECT') s += `=${clip(norm(el.selectedOptions[0]?.textContent), 30)}`;
    else if (/^(INPUT|TEXTAREA)$/.test(el.tagName) && !/^(checkbox|radio|submit|button)$/.test(el.type)) s += `="${clip(el.value, 40)}"`;
    else if (el.type === 'checkbox' || el.type === 'radio') s += el.checked ? ' [x]' : ' [ ]';
    return s;
  }

  function actionsIn(root, limit = 25, opts = {}) {
    const out = [];
    const seen = new Set();
    const vh = innerHeight;
    for (const el of $$(INTERACTIVE, root)) {
      if (out.length >= limit) break;
      if (!sized(el) || el.closest('[data-sb-ui]')) continue;
      if (opts.near) {
        const r = el.getBoundingClientRect();
        if (r.bottom < -vh || r.top > vh * 2) continue;
      }
      if (opts.skipChrome && el.closest('header,footer,nav,#nav-main,.nav-header,#navFooter')) continue;
      const t = label(el);
      if (!t) continue;
      const key = t + '|' + (el.getAttribute('href') || '');
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(fmtAction(el, t));
    }
    return out;
  }

  function searchBox() {
    return $$('input[type=search],input[name=q],input[name=k],input[name=keyword],input[name=as_word],input[name=SearchText],input#cb1-edit,input#twotabsearchtextbox,input[placeholder*="usca" i],input[placeholder*="search" i]')
      .find(sized);
  }

  function nextPage() {
    return $$('a[rel=next],.andes-pagination__button--next a,a.s-pagination-next,[aria-label*="próxima" i],[aria-label*="seguinte" i],[aria-label="Next" i],[class*=pagination] [class*=next]')
      .find(el => sized(el) && !el.matches('[aria-disabled=true],.s-pagination-disabled'));
  }

  function jsonLd() {
    const out = [];
    const visit = o => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach(visit);
      const t = [].concat(o['@type'] || []);
      if (t.includes('Product')) out.push(o);
      if (o['@graph']) visit(o['@graph']);
    };
    for (const s of $$('script[type="application/ld+json"]')) {
      try { visit(JSON.parse(s.textContent)); } catch { /* malformed ld+json is common */ }
    }
    return out[0] || null;
  }

  // ---------------------------------------------------------------- generic extractors
  // Groups product links by key and climbs to the largest ancestor that still
  // refers to a single product: works on hashed-class SPAs (Shopee) too.
  function linkCards(keyFn, root = document.body, max = 80) {
    const groups = new Map();
    for (const a of $$('a[href]', root)) {
      const k = keyFn(a.href);
      if (!k || !visible(a) || a.closest('[data-sb-ui]')) continue;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(a);
      if (groups.size > max) break;
    }
    const cards = [];
    for (const [key, as] of groups) {
      let el = as[0];
      while (el.parentElement && el.parentElement !== root && el.parentElement !== document.body) {
        const p = el.parentElement;
        const keys = new Set($$('a[href]', p).map(x => keyFn(x.href)).filter(Boolean));
        if (keys.size > 1 || p.textContent.length > 2500) break;
        el = p;
      }
      if (!HAS_PRICE.test(el.textContent)) continue;
      const link = as.slice().sort((x, y) => norm(y.textContent).length - norm(x.textContent).length)[0];
      cards.push({ key, card: el, link });
    }
    return cards;
  }

  function cardInfo(card, o = {}) {
    const raw = rawText(card, 3000);
    const ls = lines(card, 3000);
    const all = strip(raw);
    const pr = o.price != null ? { price: o.price, old: o.old } : prices(raw);
    if (pr.old != null && !(pr.old > pr.price)) pr.old = undefined; // unit prices ("R$ 5,24/un") are not list prices
    const link = o.link || $('a[href]', card);
    const name = norm(o.name) || norm($('[title]', card)?.getAttribute('title') || $('h2,h3', card)?.textContent) ||
      label(link) || $('img[alt]', card)?.alt;
    const ship = o.ship != null ? o.ship : ls.filter(l => SHIP_RE.test(l) && l.length < 90).slice(0, 2).join(' · ');
    const rating = o.rating || all.match(/(\d[.,]\d)\s*(?:de 5|out of 5|estrelas|stars)/i)?.[1];
    const sold = o.sold || all.match(/((?:mais de\s*|\+\s?)?[\d.,]+\s?(?:mil|k)?)\s*(?:produtos\s+)?(?:vendid|compras|sold)/i)?.[1];
    return prune({
      id: tag(link, 'p'),
      name: clip(norm(name).replace(/^(an[uú]ncio patrocinado|sponsored ad)\s*[–—-]\s*/i, ''), 90),
      price: pr.price,
      old: pr.old,
      ship: clip(norm(ship), 90),
      full: o.full,
      prime: o.prime,
      rating: rating && String(rating).replace(',', '.'),
      sold: sold && norm(sold),
      seller: clip(norm(o.seller), 40),
      ad: o.ad,
      intl: o.intl,
      add: o.add ? tag(o.add) : undefined,
      alt: o.alt,
    });
  }

  function variants(root = document.body, groupSel) {
    const groups = [];
    if (groupSel) {
      for (const g of $$(groupSel.group, root).filter(visible)) {
        const opts = $$(groupSel.opt, g).filter(sized);
        if (opts.length) groups.push({ g, name: groupSel.name ? norm($(groupSel.name, g)?.textContent) : '', opts });
      }
    } else {
      const sel = '[aria-checked],[aria-pressed],[role=radio],[role=option],[aria-selected]';
      const byParent = new Map();
      for (const el of $$(sel, root)) {
        if (!sized(el) || el.closest('[role=tablist],[class*=carousel],[class*=thumbnail],[class*=gallery],nav,header,footer,[data-sb-ui]')) continue;
        if (el.matches('input[type=checkbox]')) continue;
        const p = el.closest('[role=radiogroup],[role=listbox]') || el.parentElement;
        if (!byParent.has(p)) byParent.set(p, []);
        byParent.get(p).push(el);
      }
      for (const [g, opts] of byParent) {
        if (opts.length < 2) continue;
        let name = g.getAttribute('aria-label') || '';
        for (let x = g; !name && x && x !== root; x = x.parentElement) {
          const prev = x.previousElementSibling;
          if (prev && norm(prev.textContent).length < 40) name = norm(prev.textContent);
        }
        groups.push({ g, name, opts });
      }
    }
    return groups.slice(0, 6).map(({ name, opts }) => prune({
      name: clip(name, 40),
      opts: opts.slice(0, 24).map(el => {
        const on = ['aria-checked', 'aria-pressed', 'aria-selected'].some(a => el.getAttribute(a) === 'true') ||
          /(^|[\s_-])(selected|active|checked|is-selected)([\s_-]|$)/i.test(cls(el)) ||
          !!$('[aria-checked=true],[aria-pressed=true],[aria-selected=true],.a-button-selected', el);
        const off = el.disabled || el.getAttribute('aria-disabled') === 'true' || /disabled|unavailable|indispon/i.test(cls(el));
        return `${tag(el, 'v')}:${label(el) || $('img[alt]', el)?.alt || '?'}${on ? ' [x]' : ''}${off ? ' (indisp.)' : ''}`;
      }),
    }));
  }

  function genericProduct(o = {}) {
    const ld = jsonLd();
    const h1 = o.title || $$('h1').find(visible);
    const add = o.add || byText(CART_RE);
    const buy = o.buy || $$(INTERACTIVE).find(el => sized(el) && BUY_RE.test(label(el)));
    const region = o.region || ancestor(h1, add || buy) || document.body;
    const raw = o.priceEl ? rawText(o.priceEl) : rawText(region, 8000);
    const pr = prices(raw);
    const offer = ld && [].concat(ld.offers || [])[0];
    const keep = /(R\$|US\$|frete|entrega|chega|receba|envio|enviado|estoque|dispon|unidade|vendido|vendedor|loja|garantia|devolu|full|prime|cupom|desconto|restam|[uú]ltim)/i;
    const info = (o.infoEl ? lines(o.infoEl, 4000) : lines(region, 8000))
      .filter((l, i, a) => keep.test(l) && l.length < 140 && !CART_RE.test(l) && !BUY_RE.test(l) && a.indexOf(l) === i && l !== o.ship)
      .slice(0, o.infoMax || 10);
    const qty = o.qty || $$('input[type=number],[role=spinbutton],select[name*=quant i],select#quantity,input[name*=quant i]', region).find(sized);
    return prune({
      name: clip(norm(o.name || h1?.textContent || ld?.name || document.title), 140),
      price: o.price ?? pr.price ?? priceNum(offer?.price ?? offer?.lowPrice),
      old: o.old ?? pr.old,
      rating: o.rating || (ld?.aggregateRating ? `${ld.aggregateRating.ratingValue} (${ld.aggregateRating.ratingCount || ld.aggregateRating.reviewCount || '?'})` : undefined),
      seller: clip(norm(o.seller), 50),
      ship: clip(norm(o.ship), 160),
      full: o.full,
      stock: clip(norm(o.stock), 60),
      info,
      variants: o.variants || variants(region),
      qty: qty ? fmtAction(qty) : undefined,
      add: add ? tag(add) : undefined,
      buy: buy ? tag(buy) : undefined,
      offers: o.offers,
    });
  }

  function genericCart(keyFn) {
    const cards = linkCards(keyFn || (h => h.split(/[?#]/)[0]), $('main') || document.body);
    let items = cards.map(({ card, link }) => {
      const qtyEl = $$('input[type=number],input[type=text],[role=spinbutton],select', card).find(sized);
      const inc = $$(INTERACTIVE, card).find(el => sized(el) && /^\+$|aumentar|increase|increment/i.test(label(el)));
      const dec = $$(INTERACTIVE, card).find(el => sized(el) && /^[−-]$|diminuir|decrease|decrement/i.test(label(el)));
      const del = $$(`${INTERACTIVE},[class*=trash],[class*=delete],[title]`, card)
        .find(el => sized(el) && /excluir|remover|delete|remove|^lixeira/i.test(label(el) + ' ' + (el.title || '') + ' ' + cls(el)));
      const pr = prices(rawText(card));
      return prune({
        id: tag(link, 'p'),
        name: clip(label(link), 90),
        price: pr.price,
        qty: qtyEl ? (qtyEl.value || norm(qtyEl.textContent)) : undefined,
        qtyId: qtyEl ? tag(qtyEl, 'f') : undefined,
        inc: inc && tag(inc), dec: dec && tag(dec), del: del && tag(del),
      });
    });
    // Cart rows have quantity/remove controls; recommendation carousels below the cart do not.
    if (items.some(i => i.qtyId || i.inc || i.del)) items = items.filter(i => i.qtyId || i.inc || i.del);
    const all = lines(document.body, 30000);
    const summary = [];
    all.forEach((l, i) => {
      if (summary.length >= 4 || !/(subtotal|total|frete|envio|shipping)/i.test(l) || l.length > 80) return;
      // label and value often sit in sibling blocks: "Total" / "R$ 10,00"
      const v = HAS_PRICE.test(l) ? l : (all[i + 1] && HAS_PRICE.test(all[i + 1]) && all[i + 1].length < 30 ? `${l} ${all[i + 1]}` : '');
      if (v && !summary.includes(v)) summary.push(v);
    });
    const checkout = byText(/(finalizar|fechar pedido|continuar|checkout|prosseguir|comprar)/i);
    return { items, summary, checkout: checkout && tag(checkout) };
  }

  // ---------------------------------------------------------------- site adapters
  const ML_FULL = 'use[href*="full" i]:not([href*="bookmark" i]), [aria-label="FULL" i], [aria-label*="enviado pelo full" i], .ui-pdp-icon--full, svg[class*="full" i]:not([class*="bookmark" i])';
  const SITES = {
    ml: {
      host: /mercadoli[bv]re\.com/,
      cartUrl: () => 'https://www.mercadolivre.com.br/gz/cart',
      searchUrl: q => `https://lista.mercadolivre.com.br/${encodeURIComponent(norm(q).replace(/\s+/g, '-'))}`,
      key: h => (h.match(/MLB-?U?\d{6,}/) || [])[0]?.replace('-', ''),
      page() {
        const p = location.pathname;
        if (/\/gz\/cart|\/carrinho/.test(p)) return 'cart';
        if (/checkout/.test(p)) return 'checkout';
        if ($('.ui-pdp-title') || /\/p\/MLB|\/up\/MLBU|MLB-\d+/.test(p)) return 'product';
        if ($$('.ui-search-layout .poly-card, .ui-search-result').length || /^lista\./.test(location.hostname)) return 'search';
      },
      search() {
        const cards = $$('.ui-search-layout .poly-card').length ? $$('.ui-search-layout .poly-card') : $$('.poly-card');
        const items = cards.filter(visible).map(card => {
          const link = $('a.poly-component__title, .poly-component__title a, h3 a, a', card);
          const altA = $('.poly-buy-box__alternative-option', card);
          return cardInfo(card, {
            link,
            name: link && link.textContent,
            seller: tx('.poly-component__seller', card).replace(/^por\s+/i, ''),
            ad: !!$('.poly-component__ads-promotions', card),
            intl: !!$('.poly-component__cbt', card),
            full: !!$(ML_FULL, card) || /\bFULL\b/.test(textOf(card)),
            ship: lines($('.poly-component__shipping-v2, .poly-component__shipping', card) || EMPTY).join(' · '),
            alt: altA ? `${tag(altA, 'p')}:${clip(lines(altA.closest('.poly-component__buy-box') || altA).join(' '), 60)}` : undefined,
          });
        });
        const total = tx('.ui-search-search-result__quantity-results');
        return { items, total };
      },
      product() {
        const right = $('.ui-pdp-container--column-right') || document.body;
        const add = byText(/adicionar ao carrinho/i, right);
        const buy = byText(/^comprar agora$/i, right);
        const qty = $('.ui-pdp-buybox__quantity__trigger, [class*=quantity__trigger]', right);
        const ship = lines(right).filter(l => SHIP_RE.test(l) && !/mais detalhes|monte um carrinho/i.test(l)).slice(0, 3).join(' · ');
        const sellerEl = $('.ui-pdp-seller__link-trigger, .ui-pdp-seller-summary__title, [class*=seller-summary] [class*=title]', right);
        const otherOffers = $$('a', document.body).find(a => sized(a) && /(op[cç][oõ]es de compra|outras op[cç][oõ]es|ver op[cç][oõ]es)/i.test(label(a)));
        // "outside_variations" is the picker ML uses on "Escolha valor/cor" listings.
        const PICKER = '.ui-pdp-variations__picker, .ui-pdp-outside_variations__picker';
        const vgroups = $$(PICKER).length
          ? variants(document.body, { group: PICKER, name: '[class*="variations__label"], [class*="__title"]', opt: 'a, button, [role=radio], .andes-dropdown__trigger' })
          : undefined;
        return {
          product: genericProduct({
            title: $('.ui-pdp-title'),
            priceEl: $('.ui-pdp-price__main-container') || $('.ui-pdp-price') || undefined,
            infoEl: right,
            region: right,
            add, buy, qty,
            ship,
            full: !!$(ML_FULL, right),
            stock: tx('.ui-pdp-stock-information, .ui-pdp-buybox__quantity__available', right),
            seller: sellerEl && sellerEl.textContent,
            rating: tx('.ui-pdp-review__rating') || undefined,
            variants: vgroups,
            offers: otherOffers ? `${tag(otherOffers)}:${label(otherOffers)}` : undefined,
          }),
        };
      },
      cart() {
        const items = $$('.cl-item-card').filter(visible).map(card => {
          const link = $('a[href*="MLB"], a[href]', card);
          const name = tx('[class*=title]', card) || label(link);
          const qtyTxt = norm($('[class*=stepper] input, [class*=quantity-selector] input', card)?.value ||
            $('.andes-input-stepper__value, [class*=stepper__value]', card)?.textContent);
          const inc = $('[id$="stepper-increment"]', card);
          const dec = $('[id$="stepper-decrement"]', card);
          const del = $('.cl-item-card__remove', card);
          const chk = $('input[type=checkbox]', card);
          const pr = prices(rawText($('.cl-price', card) || card));
          return prune({
            id: tag(link, 'p'), name: clip(name, 90), price: pr.price, old: pr.old,
            qty: qtyTxt || undefined, inc: inc && tag(inc), dec: dec && tag(dec), del: del && tag(del),
            sel: chk ? `${tag(chk, 'f')}${chk.checked ? ' [x]' : ' [ ]'}` : undefined,
          });
        });
        const sumEl = $('[class*=cl-summary]');
        const summary = sumEl ? lines(sumEl).filter(l => /\d/.test(l) || /total/i.test(l)).slice(0, 8) : [];
        const checkout = $('.cl-summary__button') || byText(/^continuar/i);
        return { cart: { items, summary, checkout: checkout && tag(checkout) } };
      },
    },

    amazon: {
      host: /(^|\.)amazon\.[a-z.]+$/,
      cartUrl: () => `${location.hostname.includes('amazon') ? location.origin : 'https://www.amazon.com.br'}/gp/cart/view.html`,
      searchUrl: q => `${location.hostname.includes('amazon') ? location.origin : 'https://www.amazon.com.br'}/s?k=${encodeURIComponent(norm(q))}`,
      key: h => (h.match(/\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})/) || [])[1],
      page() {
        const p = location.pathname;
        if ($('form[action*="validateCaptcha"]')) return 'captcha';
        if (/\/ap\/signin/.test(p)) return 'login';
        if (/\/gp\/cart|\/cart\//.test(p)) return 'cart';
        if (/\/gp\/buy|\/checkout/.test(p)) return 'checkout';
        if ($('#productTitle')) return 'product';
        if ($('[data-component-type="s-search-result"]')) return 'search';
      },
      search() {
        const cards = $$('[data-component-type="s-search-result"][data-asin]').filter(c => c.dataset.asin && visible(c));
        const items = cards.map(card => {
          const link = $('a[href*="/dp/"]:not([href*="#customerReviews"])', card) || $('h2 a, a.a-link-normal', card);
          return cardInfo(card, {
            link,
            name: $('h2', card)?.getAttribute('aria-label') || $('h2', card)?.textContent,
            price: priceNum($('.a-price:not(.a-text-price) .a-offscreen', card)?.textContent),
            old: priceNum($('.a-text-price .a-offscreen', card)?.textContent) ?? undefined,
            ship: lines($('[data-cy="delivery-recipe"]', card) || EMPTY).join(' · '),
            rating: $('[data-cy="reviews-ratings-slot"], .a-icon-alt', card)?.textContent.match(/\d[.,]\d/)?.[0],
            prime: !!$('.a-icon-prime, [aria-label*="Prime"]', card),
            ad: !!$('.puis-sponsored-label-text, [aria-label*="Patrocinado"], [aria-label*="Sponsored"]', card),
            add: $('button[name="submit.addToCart"], [data-cy="add-to-cart"] button, [data-cy="add-to-cart"] input', card),
          });
        });
        const total = clip(tx('[data-component-type="s-result-info-bar"] h1, .s-desktop-toolbar h1'), 80);
        return { items, total };
      },
      product() {
        const right = $('#desktop_buybox, #buybox, #rightCol') || document.body;
        const vgroups = $$('#twister > div[id^="variation_"], [id^="inline-twister-row-"]').length
          ? variants(document.body, {
            group: '#twister > div[id^="variation_"], [id^="inline-twister-row-"]',
            name: '.a-form-label, .inline-twister-dim-title-label, [class*=dimension-text], [class*=dim-title]',
            opt: 'li[data-asin], li[data-defaultasin], li[data-csa-c-item-id], select',
          })
          : undefined;
        return {
          product: genericProduct({
            title: $('#productTitle'),
            priceEl: $('#corePrice_feature_div, #corePriceDisplay_desktop_feature_div, #apex_desktop, #price_inside_buybox, #newBuyBoxPrice') || undefined,
            infoEl: right,
            region: right,
            add: $('#add-to-cart-button'),
            buy: $('#buy-now-button'),
            qty: $('#quantity, select[name="quantity"]'),
            ship: lines($('#mir-layout-DELIVERY_BLOCK, #deliveryBlockMessage') || EMPTY).join(' · '),
            stock: tx('#availability'),
            seller: tx('#sellerProfileTriggerId, #merchantInfoFeature_feature_div .offer-display-feature-text, #merchant-info'),
            rating: [$('#acrPopover')?.getAttribute('title'), tx('#acrCustomerReviewText')].filter(Boolean).join(' ') || undefined,
            variants: vgroups,
            offers: (() => {
              const a = $('#aod-ingress-link, a[href*="/gp/offer-listing/"], #olpLinkWidget_feature_div a');
              return a && sized(a) ? `${tag(a)}:${label(a)}` : undefined;
            })(),
          }),
        };
      },
      cart() {
        const rows = $$('#sc-active-cart [data-asin], [data-name="Active Items"] [data-asin], .sc-list-item[data-asin]')
          .filter(r => r.dataset.asin && visible(r) && !r.parentElement.closest('[data-asin]') &&
            !/foi removido|was removed/i.test(textOf(r, 600)));
        const items = rows.map(row => {
          const link = $('a[href*="/dp/"], a[href*="/gp/product/"], .sc-product-link', row);
          const name = tx('.sc-product-title .a-truncate-full, .sc-product-title, .a-truncate-full', row) || label(link);
          const qtySel = $('select[name="quantity"]', row);
          const qtyVal = qtySel ? qtySel.value : tx('[data-a-selector="value"], .sc-quantity-stepper [aria-live]', row);
          const inc = $('[data-a-selector="increment"], button[aria-label*="Aumentar"], button[aria-label*="Increase"]', row);
          const dec = $('[data-a-selector="decrement"], button[aria-label*="Diminuir"], button[aria-label*="Decrease"]', row);
          const del = $('input[data-action="delete"], [data-action="delete-active"] input, input[value="Excluir"], input[value="Delete"], [data-feature-id="delete"] input', row);
          return prune({
            id: tag(link, 'p'), name: clip(name, 90),
            price: priceNum($('.sc-product-price, .apex-price-to-pay-value .a-offscreen, .sc-badge-price-to-pay .a-offscreen', row)?.textContent),
            qty: qtyVal || undefined, qtyId: qtySel ? tag(qtySel, 'f') : undefined,
            inc: inc && tag(inc), dec: dec && tag(dec), del: del && tag(del),
          });
        });
        const sumEl = $('#sc-subtotal-label-buybox')?.closest('form, .a-box, div') || $('#sc-buy-box') || EMPTY;
        const summary = lines(sumEl).filter(l => /\d/.test(l)).slice(0, 4);
        const checkout = $('input[name="proceedToRetailCheckout"], [name="proceedToRetailCheckout"]');
        return { cart: { items, summary, checkout: checkout && tag(checkout) } };
      },
    },

    shopee: {
      host: /(^|\.)shopee\.[a-z.]+$/,
      cartUrl: () => `${location.hostname.includes('shopee') ? location.origin : 'https://shopee.com.br'}/cart`,
      searchUrl: q => `${location.hostname.includes('shopee') ? location.origin : 'https://shopee.com.br'}/search?keyword=${encodeURIComponent(norm(q))}`,
      key: h => { const m = h.match(/-i\.(\d+)\.(\d+)|\/product\/(\d+)\/(\d+)/); return m ? (m[1] ? `${m[1]}.${m[2]}` : `${m[3]}.${m[4]}`) : undefined; },
      page() {
        const p = location.pathname;
        if (/\/verify\//.test(p)) return 'captcha';
        if (/\/buyer\/login|\/buyer\/signup/.test(p)) return 'login';
        if (/^\/cart/.test(p)) return 'cart';
        if (/checkout/.test(p)) return 'checkout';
        if (/-i\.\d+\.\d+|\/product\/\d+\/\d+/.test(p)) return 'product';
        if (/\/search|\/mall\/search|\/shop\/|-cat\./.test(p) || $('[data-sqe="item"]')) return 'search';
      },
      search() {
        const cards = linkCards(this.key, $('[role=main], main, #main') || document.body);
        return {
          items: cards.map(({ card, link }) => cardInfo(card, {
            link,
            ad: /\b(Ad|Anúncio|Patrocinado)\b/.test(textOf(card)),
          })),
        };
      },
      product() {
        const sec = $('section[aria-label*="detalhes" i], .product-briefing, [class*=product-briefing]') || undefined;
        return { product: genericProduct({ region: sec, infoEl: sec }) };
      },
      cart() { return { cart: genericCart(this.key) }; },
    },

    ali: {
      host: /(^|\.)aliexpress\.[a-z.]+$/,
      cartUrl: () => `${location.hostname.includes('aliexpress') ? location.origin : 'https://pt.aliexpress.com'}/p/shoppingcart/index.html`,
      searchUrl: q => `${location.hostname.includes('aliexpress') ? location.origin : 'https://pt.aliexpress.com'}/w/wholesale-${encodeURIComponent(norm(q).replace(/\s+/g, '-'))}.html`,
      key: h => (h.match(/\/item\/(\d{6,})\.html/) || [])[1],
      page() {
        const p = location.pathname;
        if (/_____tmd_____|punish|\/captcha/.test(location.href) || $$('#nc_1_n1z, .nc_wrapper, #baxia-dialog-content, iframe[src*="punish"]').some(visible)) return 'captcha';
        if (/^login\./.test(location.hostname)) return 'login';
        if (/shoppingcart|\/cart/.test(p)) return 'cart';
        if (/checkout|\/trade\/confirm|\/order\/confirm/.test(p)) return 'checkout';
        if (/\/item\/\d+\.html/.test(p)) return 'product';
        if (/\/w\/wholesale|\/wholesale|\/af\/|\/category\//.test(p) || $('a.search-card-item')) return 'search';
      },
      search() {
        const anchors = $$('a.search-card-item').filter(visible);
        const items = anchors.length
          ? anchors.map(a => cardInfo(a, {
            link: a,
            name: $('h3', a)?.textContent || $('[title]', a)?.getAttribute('title'),
            rating: tx('[class*=starRating], [class*=evaluation]', a) || undefined,
            sold: tx('[class*=trade]', a).replace(/\s*vendido.*$/i, '').replace(/^\d[.,]\d\s+/, '') || undefined,
            ship: lines($('[class*=serviceTag], [class*=shipping]', a) || EMPTY).filter(l => SHIP_RE.test(l) || /gr[aá]tis|free/i.test(l)).join(' · '),
          }))
          : linkCards(this.key).map(({ card, link }) => cardInfo(card, { link }));
        return { items };
      },
      product() {
        const info = $('[class*="pdp-info-right"], [class*="pdp-body-top-right"], .pdp-info') || undefined;
        return {
          product: genericProduct({
            title: first('h1[data-pl="product-title"]', '[class*="title--wrap"] h1', '[class*="pdp-info"] h1'),
            name: first('h1[data-pl="product-title"]', '[class*="title--wrap"] h1', '[class*="pdp-info"] h1') ? undefined
              : document.title.replace(/\s*[-|]\s*AliExpress.*$/i, ''),
            priceEl: $('[class*="price-default--current"], [class*="price--current"], .product-price-current, [class*="price--wrap"]') || undefined,
            region: info,
            infoEl: info,
            ship: lines($('[class*="shipping--wrap"], [class*="dynamic-shipping"], [class*="delivery"]') || EMPTY).slice(0, 3).join(' · '),
            variants: $$('[class*="sku-item--property"]').length
              ? variants(document.body, {
                group: '[class*="sku-item--property"]',
                name: '[class*="sku-item--title"]',
                opt: '[class*="sku-item--image"], [class*="sku-item--text"], [data-sku-col]',
              })
              : undefined,
            qty: $('[class*="quantity--wrap"] input, [class*="comet-input-number"] input'),
            add: byText(/(adicionar (ao|à) carrinho|add to cart)/i),
            buy: byText(BUY_RE),
          }),
        };
      },
      cart() { return { cart: genericCart(this.key) }; },
    },
  };

  function site() {
    for (const [name, s] of Object.entries(SITES)) if (s.host.test(location.hostname)) return [name, s];
    return ['other', null];
  }

  // ---------------------------------------------------------------- need-user detection
  function needUser(s) {
    const pt = s && s.page && s.page();
    if (pt === 'captcha' || pt === 'login') return pt;
    if (CAPTCHA_URL.test(location.pathname + location.search)) return 'captcha';
    const frames = $$('iframe').filter(f => sized(f) && /captcha|recaptcha|hcaptcha|turnstile|challenges\.cloudflare|arkoselabs|geetest/i.test(f.src + f.title));
    if (frames.some(f => f.getBoundingClientRect().width > 60)) return 'captcha';
    const bodyTxt = textOf(document.body, 4000);
    if (CAPTCHA_TXT.test(bodyTxt) && bodyTxt.length < 3000) return 'captcha';
    if (LOGIN_URL.test(location.pathname) || /acesse a sua conta|fa[cç]a login|sign in to/i.test(document.title) ||
      $$('input[type=password]').some(sized)) return 'login';
    return null;
  }

  // ---------------------------------------------------------------- buddy banner (talks to the human)
  let banner;
  function notify(msg, kind = 'info') {
    if (!msg) { banner?.remove(); banner = null; return true; }
    if (!banner || !banner.isConnected) {
      banner = document.createElement('div');
      banner.setAttribute('data-sb-ui', '');
      banner.style.cssText = 'position:fixed;z-index:2147483647;top:12px;left:50%;transform:translateX(-50%);max-width:560px;padding:10px 16px;border-radius:10px;font:600 14px/1.35 system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.25);cursor:pointer';
      banner.title = 'clique para fechar';
      banner.onclick = () => notify(null);
      document.documentElement.appendChild(banner);
    }
    banner.style.background = kind === 'warn' ? '#ffe08a' : '#1f6feb';
    banner.style.color = kind === 'warn' ? '#3a2a00' : '#fff';
    banner.textContent = '🛒 ShopBuddy: ' + msg;
    return true;
  }

  function flash(el) {
    const prev = el.style.outline;
    el.style.outline = '3px solid #ff4d4f';
    setTimeout(() => { el.style.outline = prev; }, 900);
  }

  // ---------------------------------------------------------------- settle
  async function settle(max = 4000, quiet = 400) {
    const t0 = Date.now();
    while (document.readyState === 'loading' && Date.now() - t0 < max) await sleep(100);
    await new Promise(resolve => {
      let timer;
      const obs = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(done, quiet); });
      const hard = setTimeout(() => done(), Math.max(0, max - (Date.now() - t0)));
      function done() { obs.disconnect(); clearTimeout(timer); clearTimeout(hard); resolve(); }
      obs.observe(document.documentElement, { childList: true, subtree: true });
      timer = setTimeout(done, quiet);
    });
  }

  // ---------------------------------------------------------------- public API
  async function snap(opts = {}) {
    if (opts.wait !== false) await settle(opts.wait || 4000);
    const [name, s] = site();
    if (s && opts.wait !== false) {
      // SPAs hydrate after load: give the adapter a few seconds to see real content.
      const ready = () => {
        const t = s.page.call(s);
        return t && (t !== 'search' || s.search.call(s).items.length > 0);
      };
      for (const t0 = Date.now(); !ready() && !needUser(s) && Date.now() - t0 < 5000;) await sleep(400);
    }
    const url = clip(location.hostname.replace(/^www\./, '') + location.pathname + (location.search ? location.search.slice(0, 60) : ''), 140);
    const out = { v: V, site: name, page: 'other', url, title: clip(norm(document.title), 80) };
    if (document.visibilityState === 'hidden') out.warn = 'aba em segundo plano: o site pode não renderizar; traga a aba para frente';

    const need = needUser(s);
    if (need) {
      out.page = need;
      out.need = need === 'captcha'
        ? 'Captcha/verificação anti-robô. Peça ao usuário para resolver na janela do Chrome e depois rode snap() de novo.'
        : 'Login necessário. Peça ao usuário para entrar na conta na janela do Chrome e depois rode snap() de novo.';
      if (opts.banner !== false) notify(need === 'captcha' ? 'resolva o captcha/verificação, o Claude continua sozinho depois 🙂' : 'faça login, o Claude continua sozinho depois 🙂', 'warn');
      out.actions = actionsIn(document.body, 12, { near: true });
      return prune(out);
    }
    if (banner) notify(null);

    let type = s?.page?.call(s);
    if (!type) {
      if (jsonLd() || byText(CART_RE)) type = 'product';
      else if (/cart|carrinho|sacola|basket/i.test(location.pathname)) type = 'cart';
      else if (/checkout|pagamento|payment/i.test(location.pathname)) type = 'checkout';
      else if (linkCards(h => h.split(/[?#]/)[0]).length >= 6) type = 'search';
      else type = 'other';
    }
    out.page = type;

    try {
      if (type === 'search') {
        const r = s?.search ? s.search.call(s) : { items: linkCards(h => h.split(/[?#]/)[0]).map(({ card, link }) => cardInfo(card, { link })) };
        const from = opts.from || 0, n = opts.n || 20;
        out.total = r.total || undefined;
        out.count = r.items.length;
        out.items = r.items.slice(from, from + n);
        const nx = nextPage();
        if (nx) out.next = tag(nx);
        if (!r.items.length) { out.page = type = 'other'; delete out.count; delete out.next; }
      } else if (type === 'product') {
        Object.assign(out, s?.product ? s.product.call(s) : { product: genericProduct() });
      } else if (type === 'cart') {
        Object.assign(out, s?.cart ? s.cart.call(s) : { cart: genericCart(s?.key) });
      } else if (type === 'checkout') {
        out.note = 'Página de checkout/pagamento: NÃO finalize sem confirmação explícita do usuário.';
        out.info = lines($('main') || document.body, 12000).filter(l => /(R\$|total|frete|entrega|endere|pagamento|parcela|cart[aã]o|pix|boleto)/i.test(l) && l.length < 120).slice(0, 15);
        out.actions = actionsIn($('main') || document.body, 30, { skipChrome: true });
      }
    } catch (e) {
      out.err = `extractor ${name}/${type}: ${e.message}`;
    }

    const dlg = dialogs();
    if (dlg.length) {
      const d = dlg[dlg.length - 1];
      out.dialog = { text: clip(lines(d, 3000).join(' | '), 300), actions: actionsIn(d, 20) };
    }
    if (type === 'other' || opts.all) out.actions = actionsIn(document.body, opts.all ? 80 : 40, { near: !opts.all, skipChrome: !opts.all });
    const sb = searchBox();
    if (sb) out.searchBox = tag(sb, 'f');
    if (out.cart && !(out.cart.items || []).length) out.cart.empty = true;
    for (const k of ['product', 'cart', 'dialog']) if (out[k]) prune(out[k]);
    return prune(out);
  }

  // Compact text form: one top-level key per line, one array entry per line.
  function toText(o) {
    const parts = [];
    const arr = (v, pad) => `[\n${pad}${v.map(x => JSON.stringify(x)).join(`,\n${pad}`)}\n${pad.slice(1)}]`;
    for (const [k, v] of Object.entries(o)) {
      if (Array.isArray(v) && v.length && typeof v[0] === 'object') parts.push(`"${k}":${arr(v, ' ')}`);
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        const inner = Object.entries(v).map(([k2, v2]) =>
          Array.isArray(v2) && v2.length && typeof v2[0] === 'object' ? `  "${k2}":${arr(v2, '   ')}` : `  "${k2}":${JSON.stringify(v2)}`);
        parts.push(`"${k}":{\n${inner.join(',\n')}\n }`);
      } else parts.push(`"${k}":${JSON.stringify(v)}`);
    }
    return `{${parts.join(',\n')}}`;
  }

  const notFound = id => ({ ok: false, err: `id ${id} não encontrado — a página mudou; rode snap() de novo` });

  function prep(el) {
    // Keep the agent in the same tab: links that would open a new tab open here.
    const a = el.closest('a[target]');
    if (a && a.target !== '_self') a.target = '_self';
    el.scrollIntoView({ block: 'center', inline: 'center' });
  }

  function click(id) {
    const el = get(id);
    if (!el) return notFound(id);
    prep(el);
    flash(el);
    const r = el.getBoundingClientRect();
    const o = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, buttons: 1, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
    const ev = (t, extra = {}) => el.dispatchEvent(t.startsWith('pointer')
      ? new PointerEvent(t, { ...o, ...extra, pointerType: 'mouse', isPrimary: true })
      : new MouseEvent(t, { ...o, ...extra }));
    for (const t of ['pointerover', 'pointerenter', 'mouseover', 'pointerdown', 'mousedown']) ev(t);
    el.focus?.({ preventScroll: true });
    for (const t of ['pointerup', 'mouseup']) ev(t, { buttons: 0 });
    el.click();
    return { ok: true, clicked: label(el) };
  }

  // Center point (viewport CSS px) for a trusted click through CDP Input.dispatchMouseEvent.
  function rect(id) {
    const el = get(id);
    if (!el) return null;
    prep(el);
    flash(el);
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), w: Math.round(r.width), h: Math.round(r.height), label: label(el) };
  }

  function focus(id, selectAll = true) {
    const el = get(id);
    if (!el) return notFound(id);
    prep(el);
    el.focus();
    if (selectAll) el.select?.();
    return { ok: true };
  }

  function setValue(el, v) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v);
  }

  async function type(id, text, opts = {}) {
    const el = get(id);
    if (!el) return notFound(id);
    prep(el);
    el.focus();
    if (el.isContentEditable) {
      if (opts.clear !== false) document.execCommand('selectAll');
      document.execCommand('insertText', false, text);
    } else {
      setValue(el, opts.clear === false ? el.value + text : text);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, data: text, inputType: 'insertText' }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (opts.enter) {
      const href = location.href;
      const k = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      const go = el.dispatchEvent(new KeyboardEvent('keydown', k));
      el.dispatchEvent(new KeyboardEvent('keypress', k));
      el.dispatchEvent(new KeyboardEvent('keyup', k));
      await sleep(150);
      if (go && location.href === href && el.form) el.form.requestSubmit ? el.form.requestSubmit() : el.form.submit();
    }
    return { ok: true, value: el.value ?? el.textContent };
  }

  function select(id, want) {
    const el = get(id);
    if (!el) return notFound(id);
    if (el.tagName !== 'SELECT') return click(id);
    const w = fold(String(want));
    const opt = [...el.options].find(o => o.value === String(want)) || [...el.options].find(o => fold(o.textContent) === w) ||
      [...el.options].find(o => fold(o.textContent).includes(w));
    if (!opt) return { ok: false, err: 'opção não encontrada', options: [...el.options].slice(0, 30).map(o => norm(o.textContent)) };
    setValue(el, opt.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selected: norm(opt.textContent) };
  }

  function find(q, opts = {}) {
    const re = q instanceof RegExp ? q : null;
    const f = re ? null : fold(q);
    const hit = t => (re ? re.test(t) : fold(t).includes(f));
    const n = opts.n || 15;
    const out = [];
    if (!opts.any) {
      for (const el of $$(INTERACTIVE)) {
        if (out.length >= n) break;
        if (!sized(el) || el.closest('[data-sb-ui]')) continue;
        const t = label(el);
        if (t && hit(t)) out.push(fmtAction(el, t));
      }
      return out;
    }
    // any element: smallest visible element whose own text matches → its id (or its clickable ancestor's)
    for (const el of $$('body *')) {
      if (out.length >= n) break;
      if (SKIP.test(el.tagName) || el.closest('[data-sb-ui]')) continue;
      const own = [...el.childNodes].filter(x => x.nodeType === 3).map(x => x.nodeValue).join(' ');
      if (!own.trim() || !hit(own) || !visible(el)) continue;
      const act = el.closest(INTERACTIVE);
      out.push(`${tag(act || el, act ? 'a' : 't')}:${clip(textOf(el.parentElement || el, 400), 100)}`);
    }
    return out;
  }

  function read(id, max = 3000) {
    const el = id ? get(id) : document.body;
    if (!el) return notFound(id);
    return clip(lines(el, max * 2).join('\n'), max);
  }

  function scroll(where = 'down') {
    if (where === 'top') scrollTo(0, 0);
    else if (where === 'bottom') scrollTo(0, document.body.scrollHeight);
    else if (where === 'up') scrollBy(0, -innerHeight * 0.85);
    else if (where === 'down') scrollBy(0, innerHeight * 0.85);
    else { const el = get(where); if (!el) return notFound(where); prep(el); }
    return { ok: true, y: Math.round(scrollY), max: Math.round(document.body.scrollHeight - innerHeight) };
  }

  function go(url) { setTimeout(() => { location.href = url; }, 0); return { ok: true, url }; }

  function search(q, siteName) {
    const s = siteName ? SITES[siteName] : site()[1];
    if (siteName && !s) return { ok: false, err: `site desconhecido: ${siteName} (use ${Object.keys(SITES).join(', ')})` };
    if (s) return go(s.searchUrl(q));
    const box = searchBox();
    if (!box) return { ok: false, err: 'campo de busca não encontrado' };
    return type(tag(box, 'f'), q, { enter: true });
  }

  function cart(siteName) {
    const s = siteName ? SITES[siteName] : site()[1];
    if (!s) {
      const a = byText(/carrinho|cart|sacola/i, document, 'a[href],button,[role=button]');
      return a ? click(tag(a)) : { ok: false, err: 'site desconhecido e link do carrinho não encontrado' };
    }
    return go(s.cartUrl());
  }

  // On a product page: click "add to cart". With a search-result id: use the card's
  // own add button when there is one, otherwise open the product page.
  function addToCart(id) {
    if (id) {
      const el = get(id);
      if (!el) return notFound(id);
      const card = el.closest('[data-asin],.poly-card,a.search-card-item,li,article') || el.parentElement;
      const btn = card && $$(INTERACTIVE, card).find(b => sized(b) && CART_RE.test(label(b)));
      if (btn) return click(tag(btn));
      return { ...click(id), note: 'abrindo página do produto; depois rode snap() e addToCart()' };
    }
    const [, s] = site();
    const p = s?.product ? s.product.call(s).product : genericProduct();
    if (!p.add) return { ok: false, err: 'botão adicionar ao carrinho não encontrado (variação não escolhida? login?)' };
    return click(p.add);
  }

  async function waitFor(what, ms = 10000) {
    if (typeof what === 'number') { await sleep(what); return { ok: true }; }
    const t0 = Date.now();
    const isSel = /^[#.[]/.test(what);
    while (Date.now() - t0 < ms) {
      if (isSel ? $(what) : fold(textOf(document.body, 200000)).includes(fold(what))) return { ok: true };
      await sleep(250);
    }
    return { ok: false, err: 'timeout' };
  }

  async function snapText(opts) { return toText(await snap(opts)); }

  const help = () => [
    `ShopBuddy ${V} — API em window.ShopBuddy:`,
    'snap({n,from,all}) → JSON da página | s(opts) → mesmo conteúdo em texto compacto',
    'click(id) | type(id,texto,{enter}) | select(id,valorOuTexto) | focus(id) | rect(id)',
    'find("texto",{any}) → ids que contêm o texto | read(id) → texto completo de um bloco',
    'search(q,[site]) | cart([site]) | addToCart([itemId]) | go(url) | scroll(down|up|top|bottom|id)',
    'wait(ms|"texto"|"#sel") | notify("msg ao usuário") | sites: ' + Object.keys(SITES).join(', '),
  ].join('\n');

  window.ShopBuddy = Object.freeze({
    v: V, snap, s: snapText, toText, click, rect, focus, type, select, find, read, scroll, go,
    search, cart, addToCart, wait: waitFor, notify, help,
  });
})();
