#!/usr/bin/env node
// ShopBuddy CLI — drives the Chrome opened with --remote-debugging-port=9222.
// Every action prints the new page snapshot, so one command = one round trip.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { listPages, newPage, Session } from './cdp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORE = join(HERE, '..', 'extension', 'shopbuddy.js');
const STATE_DIR = join(homedir(), '.shopbuddy');
const STATE = join(STATE_DIR, 'state.json');
const SITE_HOME = {
  ml: 'https://www.mercadolivre.com.br',
  amazon: 'https://www.amazon.com.br',
  shopee: 'https://shopee.com.br',
  ali: 'https://pt.aliexpress.com',
};

const HELP = `ShopBuddy CLI — uso: node sb.mjs <comando> [args] [--tab X] [--json]

  tabs                         lista abas (* = aba atual do buddy)
  open <ml|amazon|shopee|ali|url>  abre nova aba e vira a aba atual
  use <n|trecho-da-url>        escolhe a aba atual
  snap [--all] [--n 20] [--from 0]   página → JSON compacto
  search <texto> [--site ml]   busca no site (atual ou --site)
  click <id> [--js]            clique real (mouse CDP); --js = clique via JS
  type <id> <texto> [--enter]  digita (substitui) no campo
  select <id> <valor|texto>    escolhe opção de <select>
  add [itemId]                 adicionar ao carrinho (produto atual ou card da busca)
  cart [--site ml]             abre o carrinho
  qty <itemId> <n>             muda a quantidade de um item do carrinho
  orders [--site ml]           abre "minhas compras" (pedidos já feitos)
  orderinfo [ids...]           valores/pagamento dos pedidos listados (ML)
  find <texto> [--any]         acha ids pelo texto
  read <id>                    texto completo de um bloco
  scroll <down|up|top|bottom|id>
  go <url>                     navega
  back                         volta uma página
  wait-user [--timeout 600]    espera o usuário resolver captcha/login
  eval <js>                    avalia JS na página (ShopBuddy disponível)

Captcha/login: qualquer comando que cair numa verificação mostra um aviso na página,
traz a aba para frente e espera o usuário resolver (até 5 min; --no-wait para não esperar).`;

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const flags = {};
const pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const nxt = argv[i + 1];
    if (['tab', 'site', 'n', 'from', 'timeout'].includes(k) && nxt !== undefined) { flags[k] = nxt; i++; }
    else flags[k] = true;
  } else pos.push(a);
}
const cmd = pos.shift();

// ------------------------------------------------------------------ state / tab choice
const loadState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const saveState = st => { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE, JSON.stringify(st)); };

// The buddy works in its own tab: never grab one of the user's tabs unless --tab says so.
async function pickTab() {
  const pages = await listPages();
  const st = loadState();
  let p;
  if (flags.tab) {
    p = /^\d+$/.test(flags.tab) && Number(flags.tab) < pages.length ? pages[Number(flags.tab)]
      : pages.find(x => x.id === flags.tab || x.url.includes(flags.tab));
    if (!p) throw new Error(`aba não encontrada: ${flags.tab}`);
  }
  p ||= pages.find(x => x.id === st.tab);
  if (!p) {
    const t = await newPage('about:blank');
    p = { id: t.id, url: t.url, webSocketDebuggerUrl: t.webSocketDebuggerUrl };
  }
  if (st.tab !== p.id) saveState({ ...st, tab: p.id });
  return p;
}

// ------------------------------------------------------------------ page session helpers
async function connect(p) {
  const s = await new Session(p.webSocketDebuggerUrl).open();
  await s.send('Page.enable');
  return s;
}

let coreSrc;
async function ensureCore(s) {
  coreSrc ||= readFileSync(CORE, 'utf8');
  // The extension's copy and this file can drift while developing: compare content, not version.
  const want = createHash('sha1').update(coreSrc).digest('hex').slice(0, 10);
  for (let i = 0; i < 3; i++) {
    try {
      const has = await s.eval('!!window.ShopBuddy && window.ShopBuddy.v ? (window.__sbHash || "ext") : ""');
      if (has === want || (has === 'ext' && !flags.reinject)) return has;
      flags.reinject = false;
      await s.eval('delete window.ShopBuddy');
      await s.eval(coreSrc);
      await s.eval(`window.__sbHash = ${JSON.stringify(want)}`);
      return want;
    } catch (e) {
      // Context destroyed mid-navigation: wait and retry.
      await new Promise(r => setTimeout(r, 800));
    }
  }
  throw new Error('não consegui injetar o ShopBuddy na página');
}

async function call(s, expr) {
  for (let i = 0; ; i++) {
    try {
      await ensureCore(s);
      return await s.eval(expr);
    } catch (e) {
      // Page navigated between injection and the call: wait for the new document and retry.
      if (i >= 3 || !/context|navigated|closed|not find/i.test(e.message)) throw e;
      await waitLoad(s, 10000);
    }
  }
}

async function waitLoad(s, ms) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const st = await s.eval('document.readyState').catch(() => 'loading');
    if (st === 'complete') return;
    await new Promise(r => setTimeout(r, 300));
  }
}

// Waits for a navigation the last action may have triggered, then for load.
async function afterAction(s, beforeUrl) {
  const started = await s.waitEvent('Page.frameStartedLoading', 1200);
  if (started) await s.waitEvent('Page.loadEventFired', 20000);
  else {
    const now = await s.eval('location.href').catch(() => beforeUrl);
    if (now !== beforeUrl) await s.waitEvent('Page.loadEventFired', 8000);
  }
}

function beep() {
  if (process.platform === 'win32') execFile('powershell', ['-NoProfile', '-c', '[console]::beep(880,250);[console]::beep(660,250)'], () => {});
  else process.stderr.write('\x07');
}

async function snapshot(s, p, opts = {}) {
  const o = JSON.stringify({ n: flags.n ? Number(flags.n) : undefined, from: flags.from ? Number(flags.from) : undefined, all: !!flags.all, ...opts });
  let snap = await call(s, `ShopBuddy.snap(${o})`);
  if ((snap.page === 'captcha' || snap.page === 'login') && !flags['no-wait'] && cmd !== 'wait-user') {
    snap = await waitUser(s, p, Number(flags.timeout || 300));
  }
  return snap;
}

async function waitUser(s, p, timeoutSec) {
  await s.send('Page.bringToFront');
  beep();
  process.stderr.write(`[shopbuddy] verificação/login na página — aguardando o usuário (até ${timeoutSec}s)...\n`);
  const t0 = Date.now();
  let snap;
  while (Date.now() - t0 < timeoutSec * 1000) {
    try { snap = await call(s, 'ShopBuddy.snap({wait:800})'); } catch { snap = null; }
    if (snap && snap.page !== 'captcha' && snap.page !== 'login') {
      process.stderr.write('[shopbuddy] liberado, continuando.\n');
      return call(s, 'ShopBuddy.snap()');
    }
    await new Promise(r => setTimeout(r, 2500));
  }
  return snap || { page: 'captcha', need: 'timeout esperando o usuário' };
}

const show = async (s, v) => {
  if (flags.json || typeof v !== 'object' || v === null) console.log(typeof v === 'string' ? v : JSON.stringify(v));
  else console.log(await s.eval(`ShopBuddy.toText(${JSON.stringify(v)})`));
};

async function trustedClick(s, id) {
  const r = await call(s, `ShopBuddy.rect(${JSON.stringify(id)})`);
  if (!r) return { ok: false, err: `id ${id} não encontrado — rode snap de novo` };
  await new Promise(res => setTimeout(res, 120)); // let scrollIntoView finish
  const r2 = await s.eval(`ShopBuddy.rect(${JSON.stringify(id)})`);
  const { x, y } = r2 || r;
  // Is our element actually the top-most thing at that point? If not (overlay), fall back to JS click.
  const hit = await s.eval(`(() => { const el = document.elementFromPoint(${x}, ${y}); const t = document.querySelector('[data-sb="${id}"]'); return !!(el && t && (t === el || t.contains(el) || el.contains(t))); })()`);
  if (!hit) return call(s, `ShopBuddy.click(${JSON.stringify(id)})`);
  const base = { x, y, button: 'left', clickCount: 1 };
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  return { ok: true, clicked: r.label };
}

// ------------------------------------------------------------------ main
async function main() {
  if (!cmd || cmd === 'help' || flags.help) { console.log(HELP); return; }

  if (cmd === 'tabs') {
    const st = loadState();
    const pages = await listPages();
    pages.forEach((p, i) => console.log(`${p.id === st.tab ? '*' : ' '}${i} ${p.url.slice(0, 110)}`));
    return;
  }

  if (cmd === 'open') {
    const target = pos[0] || 'ml';
    const url = SITE_HOME[target] || (/^https?:/.test(target) ? target : `https://${target}`);
    const p = await newPage('about:blank');
    saveState({ ...loadState(), tab: p.id });
    const s = await connect({ webSocketDebuggerUrl: p.webSocketDebuggerUrl });
    await s.send('Page.bringToFront');
    const loaded = s.waitEvent('Page.loadEventFired', 20000);
    await s.send('Page.navigate', { url });
    await loaded;
    await show(s, await snapshot(s, p));
    s.close();
    return;
  }

  if (cmd === 'use') {
    flags.tab = pos[0];
    const p = await pickTab();
    console.log(`aba atual: ${p.url}`);
    return;
  }

  const p = await pickTab();
  const s = await connect(p);
  // Hidden/occluded tabs pause requestAnimationFrame, so SPAs (ML, Shopee) never render results there.
  if (!flags.bg) await s.send('Page.bringToFront');
  try {
    const before = await s.eval('location.href');
    const id = pos[0];
    const J = JSON.stringify;
    let res;

    switch (cmd) {
      case 'snap': break;
      case 'click':
        res = flags.js ? await call(s, `ShopBuddy.click(${J(id)})`) : await trustedClick(s, id);
        break;
      case 'type': {
        const text = pos.slice(1).join(' ');
        res = await call(s, `ShopBuddy.focus(${J(id)})`);
        if (res.ok) {
          await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
          await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65 });
          await s.send('Input.insertText', { text });
          const val = await s.eval(`(document.querySelector('[data-sb="${id}"]')||{}).value`);
          // React-controlled inputs sometimes ignore insertText; fall back to setter + events.
          if (val !== undefined && val !== text) res = await s.eval(`ShopBuddy.type(${J(id)}, ${J(text)})`);
          if (flags.enter) {
            const k = { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
            await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...k });
            await s.send('Input.dispatchKeyEvent', { type: 'char', text: '\r', ...k });
            await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...k });
          }
          res = { ok: true, typed: text };
        }
        break;
      }
      case 'select': res = await call(s, `ShopBuddy.select(${J(id)}, ${J(pos.slice(1).join(' '))})`); break;
      case 'add': {
        if (id) res = await call(s, `ShopBuddy.addToCart(${J(id)})`);
        else {
          const prod = await call(s, 'ShopBuddy.snap({wait:500})');
          const addId = prod.product && prod.product.add;
          res = addId ? await trustedClick(s, addId) : { ok: false, err: 'botão adicionar ao carrinho não encontrado nesta página (escolha variação/abra o produto)' };
        }
        break;
      }
      case 'search': res = await call(s, `ShopBuddy.search(${J(pos.join(' '))}${flags.site ? ', ' + J(flags.site) : ''})`); break;
      case 'cart': res = await call(s, `ShopBuddy.cart(${flags.site ? J(flags.site) : ''})`); break;
      case 'go': res = await call(s, `ShopBuddy.go(${J(id)})`); break;
      case 'back': res = await s.eval('history.back(), {ok:true}'); break;
      case 'scroll': res = await call(s, `ShopBuddy.scroll(${J(id || 'down')})`); break;
      case 'qty': res = await call(s, `ShopBuddy.setQty(${J(id)}, ${J(pos[1])})`); break;
      case 'orders': res = await call(s, `ShopBuddy.orders(${flags.site ? J(flags.site) : ''})`); break;
      case 'orderinfo': console.log(JSON.stringify(await call(s, `ShopBuddy.orderInfo(${pos.length ? J(pos) : ''})`))); return;
      case 'find': console.log((await call(s, `ShopBuddy.find(${J(pos.join(' '))}, {any: ${!!flags.any}})`)).join('\n') || '(nada)'); return;
      case 'read': console.log(await call(s, `ShopBuddy.read(${J(id)})`)); return;
      case 'eval': await show(s, await call(s, pos.join(' '))); return;
      case 'wait-user': await show(s, await waitUser(s, p, Number(flags.timeout || 600))); return;
      default: console.log(`comando desconhecido: ${cmd}\n\n${HELP}`); process.exitCode = 2; return;
    }

    if (res) {
      console.log(`# ${cmd} ${id || ''} → ${res.ok === false ? 'FALHOU: ' + res.err : 'ok'}${res.clicked ? ` (${res.clicked})` : ''}${res.note ? ' — ' + res.note : ''}`);
      if (res.ok === false && res.options) console.log('opções: ' + res.options.join(' | '));
      await afterAction(s, before);
    }
    await show(s, await snapshot(s, p));
  } finally {
    s.close();
  }
}

main().catch(e => { console.error('erro:', e.message); process.exitCode = 1; });
