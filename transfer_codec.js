// 仕様書: docs/IP/20261108-1959_W-LIST・設定・HOMEのエクスポートとインポート.md 2-7（QR だけのダウンロード: 中身の URL・分け方・つなぎ方）
// 書き出しの JSON を縮め（deflate-raw）、800 バイトずつに分けて、受け取り用のページの URL の # の後ろに入れる。受け取り用のページは逆をたどる。
// TV のページ（assets）と受け取り用のページ（web/receiver/）の両方で読む。web/receiver/transfer_codec.js はこのファイルの写し（Vitest で同じことを確かめる）。
// DOM に触らない。globalThis.FtvTransferCodec に置く
(() => {
  /** 1 枚の QR に入れる縮めたバイトの数 */
  const CHUNK_BYTES = 800;
  /** QR の枚数の上限 */
  const MAX_CHUNKS = 60;
  /** 中身の形の頭（版） */
  const PREFIX = 'f1';
  /** 種類の 1 文字 */
  const KINDS = Object.freeze({ wlist: 'w', settings: 's', home: 'h' });
  const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const ID_PATTERN = /^[A-Za-z0-9]{6}$/;
  const B64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
  const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

  /**
   * バイトを base64url（+ / = を使わない）にする
   * @param {Uint8Array} bytes バイト
   * @returns {string} 文字
   */
  function toBase64Url(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 3) {
      const n = (bytes[i] << 16) | ((bytes[i + 1] || 0) << 8) | (bytes[i + 2] || 0);
      out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63];
      if (i + 1 < bytes.length) out += B64_CHARS[(n >> 6) & 63];
      if (i + 2 < bytes.length) out += B64_CHARS[n & 63];
    }
    return out;
  }

  /**
   * base64url をバイトに戻す
   * @param {unknown} text 文字
   * @returns {Uint8Array|null} バイト（形が違えば null）
   */
  function fromBase64Url(text) {
    if (typeof text !== 'string' || !B64URL_PATTERN.test(text) || text.length % 4 === 1) return null;
    const out = new Uint8Array(Math.floor((text.length * 3) / 4));
    let o = 0;
    for (let i = 0; i < text.length; i += 4) {
      const c = [0, 1, 2, 3].map((k) => (i + k < text.length ? B64_CHARS.indexOf(text[i + k]) : 0));
      const n = (c[0] << 18) | (c[1] << 12) | (c[2] << 6) | c[3];
      out[o++] = (n >> 16) & 255;
      if (i + 2 < text.length) out[o++] = (n >> 8) & 255;
      if (i + 3 < text.length) out[o++] = n & 255;
    }
    return out.slice(0, o);
  }

  /**
   * 書き出しの番号（英数 6 文字）
   * @param {() => number} rand 0 以上 1 未満の数を返す
   * @returns {string} 番号
   */
  function newExportId(rand) {
    let id = '';
    for (let i = 0; i < 6; i += 1) id += ID_CHARS[Math.floor(rand() * ID_CHARS.length) % ID_CHARS.length];
    return id;
  }

  /**
   * ストリームを通したバイトを集める
   * @param {Uint8Array} bytes 入れるバイト
   * @param {TransformStream} stream 通すストリーム
   * @returns {Promise<Uint8Array>} 出てきたバイト
   */
  async function pipe(bytes, stream) {
    // Blob・Response に頼らず、書き口と読み口で直に流す（TV の WebView・スマホのブラウザー・テストの環境で同じに動く）
    const writer = stream.writable.getWriter();
    const writing = writer.write(bytes).then(() => writer.close());
    // 壊れたバイトで書き口が失敗しても、読み口の失敗として扱う（拾われない失敗を残さない）
    writing.catch(() => {});
    const reader = stream.readable.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
    await writing;
    const out = new Uint8Array(total);
    let o = 0;
    chunks.forEach((c) => {
      out.set(c, o);
      o += c.length;
    });
    return out;
  }

  /**
   * 文字を UTF-8 にして縮める（deflate-raw）
   * @param {string} text 文字
   * @returns {Promise<Uint8Array>} 縮めたバイト
   */
  function compress(text) {
    return pipe(new TextEncoder().encode(text), new CompressionStream('deflate-raw'));
  }

  /**
   * 縮めたバイトをほどいて文字にする
   * @param {Uint8Array} bytes 縮めたバイト
   * @returns {Promise<string|null>} 文字（ほどけなければ null）
   */
  async function decompress(bytes) {
    try {
      const out = await pipe(bytes, new DecompressionStream('deflate-raw'));
      return new TextDecoder('utf-8', { fatal: true }).decode(out);
    } catch {
      return null;
    }
  }

  /**
   * 縮めたバイトを分けて、QR に入れる URL にする
   * @param {string} receiverUrl 受け取り用のページの URL
   * @param {string} exportId 書き出しの番号
   * @param {string} kind 'wlist'・'settings'・'home'
   * @param {Uint8Array} bytes 縮めたバイト
   * @returns {{ok: true, urls: string[]}|{ok: false, reason: 'tooMany'|'invalid'}} 結果
   */
  function makeUrls(receiverUrl, exportId, kind, bytes) {
    const letter = KINDS[kind];
    if (!letter || !ID_PATTERN.test(exportId)) return { ok: false, reason: 'invalid' };
    const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    if (total > MAX_CHUNKS) return { ok: false, reason: 'tooMany' };
    const urls = [];
    for (let i = 0; i < total; i += 1) {
      const part = bytes.subarray(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES);
      urls.push(`${receiverUrl}#${PREFIX}.${exportId}.${i + 1}.${total}.${letter}.${toBase64Url(part)}`);
    }
    return { ok: true, urls };
  }

  /**
   * URL の # の後ろ（# を含んでよい）を読む
   * @param {unknown} hash # の後ろ
   * @returns {{ok: true, exportId: string, index: number, total: number, kind: string, bytes: Uint8Array}|{ok: false}} 結果
   */
  function parseFragment(hash) {
    if (typeof hash !== 'string') return { ok: false };
    const parts = (hash.startsWith('#') ? hash.slice(1) : hash).split('.');
    if (parts.length !== 6 || parts[0] !== PREFIX || !ID_PATTERN.test(parts[1])) return { ok: false };
    if (!/^[0-9]{1,2}$/.test(parts[2]) || !/^[0-9]{1,2}$/.test(parts[3])) return { ok: false };
    const index = Number(parts[2]);
    const total = Number(parts[3]);
    if (total < 1 || total > MAX_CHUNKS || index < 1 || index > total) return { ok: false };
    const kind = Object.keys(KINDS).find((k) => KINDS[k] === parts[4]);
    if (!kind) return { ok: false };
    const bytes = fromBase64Url(parts[5]);
    if (!bytes) return { ok: false };
    return { ok: true, exportId: parts[1], index, total, kind, bytes };
  }

  /**
   * 足りない番号
   * @param {Map<number, Uint8Array>} parts 何枚目 → バイト
   * @param {number} total 全部で何枚
   * @returns {number[]} 足りない番号（小さい順）
   */
  function missing(parts, total) {
    const out = [];
    for (let i = 1; i <= total; i += 1) if (!parts.has(i)) out.push(i);
    return out;
  }

  /**
   * そろっていればつなぐ
   * @param {Map<number, Uint8Array>} parts 何枚目 → バイト
   * @param {number} total 全部で何枚
   * @returns {Uint8Array|null} つないだバイト（足りなければ null）
   */
  function joinChunks(parts, total) {
    if (missing(parts, total).length > 0) return null;
    const list = [];
    for (let i = 1; i <= total; i += 1) list.push(parts.get(i));
    const out = new Uint8Array(list.reduce((sum, p) => sum + p.length, 0));
    let o = 0;
    list.forEach((p) => {
      out.set(p, o);
      o += p.length;
    });
    return out;
  }

  globalThis.FtvTransferCodec = Object.freeze({
    CHUNK_BYTES,
    MAX_CHUNKS,
    PREFIX,
    KINDS,
    toBase64Url,
    fromBase64Url,
    newExportId,
    compress,
    decompress,
    makeUrls,
    parseFragment,
    missing,
    joinChunks
  });
})();
