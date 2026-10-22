// Minimal Chrome DevTools Protocol client (zero deps, Node >= 22 native WebSocket).
const HOST = process.env.SB_CDP || 'http://127.0.0.1:9222';

export async function listPages() {
  const res = await fetch(`${HOST}/json/list`);
  if (res.status === 404) {
    // Chrome's chrome://inspect "remote debugging" toggle exposes only the browser websocket
    // and asks the user to approve every new client: unusable for a one-shot CLI.
    throw new Error('Chrome está no modo toggle (chrome://inspect) sem endpoints /json. Use o MCP chrome-devtools, ' +
      'ou abra um Chrome com --remote-debugging-port=9222 --user-data-dir=<pasta> para usar o CLI.');
  }
  const all = await res.json();
  return all.filter(t => t.type === 'page' && !t.url.startsWith('chrome-extension://') && !t.url.startsWith('devtools://'));
}

export async function newPage(url = 'about:blank') {
  const res = await fetch(`${HOST}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  return res.json();
}

export async function activate(id) {
  await fetch(`${HOST}/json/activate/${id}`);
}

export class Session {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.seq = 0;
    this.pending = new Map();
    this.listeners = new Set();
  }

  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = e => reject(new Error(`CDP websocket error: ${e.message || e.type}`));
      this.ws.onmessage = ev => {
        const msg = JSON.parse(ev.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
        } else if (msg.method) {
          for (const fn of this.listeners) fn(msg);
        }
      };
    });
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitEvent(method, timeoutMs) {
    return new Promise(resolve => {
      const t = setTimeout(() => { this.listeners.delete(fn); resolve(null); }, timeoutMs);
      const fn = msg => {
        if (msg.method === method) { clearTimeout(t); this.listeners.delete(fn); resolve(msg.params); }
      };
      this.listeners.add(fn);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text);
    }
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch {} }
}
