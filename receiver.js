// 仕様書: docs/IP/20261108-1959_W-LIST・設定・HOMEのエクスポートとインポート.md 2-7（受け取り用のページ）・4-3 の 12・13
// Fire TV の「QR ⬇」の QR をスマホのカメラで撮ると開くページ。URL の # の後ろ（サーバーには送られない）を読み、
// 書き出しの番号ごとにブラウザーの localStorage に貯め、そろったらほどいてファイルにして保存する。外のものは読み込まない。
// transfer_codec.js（app/src/main/assets/transfer_codec.js の写し）の後に読み込む。globalThis.FtvReceiver に置く
(() => {
  /** 貯め置きのキーの頭 */
  const PREFIX = 'ftv-receiver:';
  /** これより古い貯め置きは消す */
  const MAX_AGE_MS = 24 * 60 * 60 * 1000;
  const TITLES = Object.freeze({ wlist: 'W-LIST', settings: '設定', home: 'HOME のリスト' });
  const FORMATS = Object.freeze({ wlist: 'w-list-export', settings: 'ftv-settings-export', home: 'ftv-home-export' });
  const FILE_PREFIX = Object.freeze({ wlist: 'w-list-export', settings: 'ftv-settings', home: 'ftv-home' });
  const TEXTS = Object.freeze({
    guide: 'TV の QR をカメラで撮ってください（TV の受け渡しの画面の「QR ⬇」）',
    bad: '読めない QR でした。もう一度撮ってください',
    failed: '読めませんでした。TV で「QR ⬇」を開き直し、1 枚目から撮り直してください',
    unsupported: 'このブラウザーでは受け取れません。新しい Chrome か Safari で開いてください',
    noStorage: 'このブラウザーに貯められません（プライベートモード等）。普通のモードで開き直してください',
    ready: 'そろいました。⬇ で保存してください',
    saved: '保存しました'
  });

  /**
   * 保存するファイルの名前（種類と端末の日付。TV の LAN のページと同じ）
   * @param {string} kind 種類
   * @param {number} at 時刻（ミリ秒）
   * @returns {string} 名前
   */
  function fileName(kind, at) {
    const d = new Date(at);
    const two = (n) => String(n).padStart(2, '0');
    return `${FILE_PREFIX[kind]}-${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}.json`;
  }

  /**
   * ブラウザーにファイルとして保存させる
   * @param {string} name 名前
   * @param {string} text 中身
   */
  function browserDownload(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /**
   * 受け取り用のページを作る
   * @param {{doc: Document, storage: Storage|null, now: () => number, download?: (name: string, text: string) => void, supported?: boolean}} deps
   *   文書・localStorage（使えなければ null）・時計・保存の口・DecompressionStream があるか
   * @returns {{handle: (hash: string) => Promise<object>}} 口
   */
  function createReceiver(deps) {
    const { doc, storage, now } = deps;
    const download = deps.download || browserDownload;
    const supported = deps.supported !== false;
    const C = globalThis.FtvTransferCodec;
    const titleEl = doc.getElementById('receiver-title');
    const progressEl = doc.getElementById('receiver-progress');
    const statusEl = doc.getElementById('receiver-status');
    const saveEl = doc.getElementById('receiver-save');
    /** 保存できるファイル（そろったとき） */
    let ready = null;

    /**
     * 様子の文を出す
     * @param {string} text 文
     */
    function setStatus(text) {
      if (statusEl) statusEl.textContent = text;
    }

    /**
     * 読み・書き・消しを、例外を出さずに行う
     * @param {() => unknown} fn 仕事
     * @returns {unknown} 答え（失敗なら undefined）
     */
    function safely(fn) {
      try {
        return fn();
      } catch {
        return undefined;
      }
    }

    /** 24 時間より古い貯め置き・壊れた貯め置きを消す */
    function cleanup() {
      if (!storage) return;
      const keys = [];
      for (let i = 0; i < (safely(() => storage.length) || 0); i += 1) {
        const key = safely(() => storage.key(i));
        if (typeof key === 'string' && key.startsWith(PREFIX)) keys.push(key);
      }
      keys.forEach((key) => {
        const rec = safely(() => JSON.parse(storage.getItem(key)));
        if (!rec || typeof rec.savedAt !== 'number' || now() - rec.savedAt > MAX_AGE_MS) safely(() => storage.removeItem(key));
      });
    }

    /**
     * 貯め置きを読む
     * @param {string} id 書き出しの番号
     * @returns {{kind: string, total: number, savedAt: number, parts: Record<string, string>}|null} 貯め置き
     */
    function load(id) {
      const rec = safely(() => JSON.parse(storage.getItem(PREFIX + id)));
      return rec && typeof rec === 'object' && rec.parts && typeof rec.parts === 'object' ? rec : null;
    }

    /**
     * 読んだ枚数の点を描く
     * @param {number} total 全部で何枚
     * @param {Map<number, Uint8Array>} parts 読んだもの
     */
    function renderProgress(total, parts) {
      if (!progressEl) return;
      const dots = [];
      for (let i = 1; i <= total; i += 1) {
        const dot = doc.createElement('i');
        if (parts.has(i)) dot.className = 'is-done';
        dots.push(dot);
      }
      progressEl.replaceChildren(...dots);
      progressEl.setAttribute('aria-label', `${total} 枚のうち ${parts.size} 枚を読みました`);
    }

    /**
     * うまくいかなかった
     * @param {string} text 文
     * @returns {{ok: false}} 答え
     */
    function fail(text) {
      setStatus(text);
      return { ok: false };
    }

    /**
     * URL の # の後ろを読む
     * @param {unknown} hash # の後ろ
     * @returns {Promise<{ok: boolean, complete?: boolean, have?: number, total?: number, kind?: string}>} 答え
     */
    async function handle(hash) {
      ready = null;
      if (saveEl) saveEl.hidden = true;
      if (!supported) return fail(TEXTS.unsupported);
      if (typeof hash !== 'string' || hash === '' || hash === '#') return fail(TEXTS.guide);
      const p = C.parseFragment(hash);
      if (!p.ok) return fail(TEXTS.bad);
      if (titleEl) titleEl.textContent = `${TITLES[p.kind]} を受け取り中`;
      cleanup();

      let parts;
      if (p.total === 1) {
        parts = new Map([[1, p.bytes]]);
      } else {
        if (!storage) return fail(TEXTS.noStorage);
        let rec = load(p.exportId);
        if (!rec || rec.kind !== p.kind || rec.total !== p.total) rec = { kind: p.kind, total: p.total, savedAt: now(), parts: {} };
        rec.parts[String(p.index)] = C.toBase64Url(p.bytes);
        rec.savedAt = now();
        const stored = safely(() => {
          storage.setItem(PREFIX + p.exportId, JSON.stringify(rec));
          return true;
        });
        if (!stored) return fail(TEXTS.noStorage);
        parts = new Map();
        Object.keys(rec.parts).forEach((k) => {
          const bytes = C.fromBase64Url(rec.parts[k]);
          if (bytes) parts.set(Number(k), bytes);
        });
      }

      renderProgress(p.total, parts);
      const joined = C.joinChunks(parts, p.total);
      if (!joined) {
        setStatus(`${parts.size} / ${p.total} を読みました。TV で ▶ を押し、次の QR をカメラで撮ってください（まだ: ${C.missing(parts, p.total).join('・')} 枚目）`);
        return { ok: true, complete: false, have: parts.size, total: p.total, kind: p.kind };
      }

      const text = await C.decompress(joined);
      const data = text === null ? null : safely(() => JSON.parse(text));
      if (!data || typeof data !== 'object' || data.format !== FORMATS[p.kind]) return fail(TEXTS.failed);
      ready = { id: p.exportId, name: fileName(p.kind, now()), text: JSON.stringify(data, null, 2) };
      if (titleEl) titleEl.textContent = `${TITLES[p.kind]} がそろいました`;
      if (saveEl) saveEl.hidden = false;
      setStatus(TEXTS.ready);
      return { ok: true, complete: true, have: parts.size, total: p.total, kind: p.kind };
    }

    /** ⬇: そろったファイルを保存し、貯め置きを消す */
    function save() {
      if (!ready) return;
      download(ready.name, ready.text);
      const id = ready.id;
      if (storage) safely(() => storage.removeItem(PREFIX + id));
      setStatus(TEXTS.saved);
    }

    if (saveEl) saveEl.addEventListener('click', save);

    return { handle };
  }

  globalThis.FtvReceiver = Object.freeze({ createReceiver, fileName });

  // index.html で開いたときだけ動かす（テストでは createReceiver を直に呼ぶ）
  if (typeof document !== 'undefined' && document.getElementById('receiver-status') && typeof window !== 'undefined') {
    let storage = null;
    try {
      storage = window.localStorage;
    } catch {
      // 使えなければ 1 枚で済むものだけ受け取れる
    }
    const receiver = createReceiver({ doc: document, storage, now: () => Date.now(), supported: typeof DecompressionStream === 'function' });
    receiver.handle(window.location.hash);
    window.addEventListener('hashchange', () => { receiver.handle(window.location.hash); });
  }
})();
