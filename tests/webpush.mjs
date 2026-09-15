/* RFC 8291(aes128gcm) + RFC 8292(VAPID) — Web Crypto 만 사용.
   digest/index.ts 에 그대로 들어갈 코드의 원본. 여기서 왕복 검증한다. */

export const te = (s) => new TextEncoder().encode(s);
export function b64uToBytes(s) {
  const t = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(t + "=".repeat((4 - (t.length % 4)) % 4));
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}
export function bytesToB64u(b) {
  let s = "";
  const a = new Uint8Array(b);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
export function cat(...arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n);
  let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
// HKDF-Expand 는 한 블록(≤32바이트)만 필요하다
async function hkdfExpand(prk, info, len) {
  return (await hmac(prk, cat(info, new Uint8Array([1])))).slice(0, len);
}

/** 구독 정보로 aes128gcm 본문을 만든다. 반환값을 그대로 POST 하면 된다. */
export async function encryptPayload(p256dhB64u, authB64u, plaintextStr) {
  const uaPub = b64uToBytes(p256dhB64u);            // 65바이트 비압축 점
  const authSecret = b64uToBytes(authB64u);         // 16바이트
  if (uaPub.length !== 65 || uaPub[0] !== 4) throw new Error("p256dh 형식이 올바르지 않아요");
  if (authSecret.length !== 16) throw new Error("auth 형식이 올바르지 않아요");

  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const eph = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", eph.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, eph.privateKey, 256));

  // RFC 8291 §3.4
  const prkKey = await hmac(authSecret, shared);
  const keyInfo = cat(te("WebPush: info\0"), uaPub, asPub);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = await hkdfExpand(prk, te("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdfExpand(prk, te("Content-Encoding: nonce\0"), 12);

  const payload = te(plaintextStr);
  if (payload.length > 3800) throw new Error("알림 내용이 너무 길어요");
  const padded = cat(payload, new Uint8Array([2]));   // 0x02 = 마지막 레코드 구분자

  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, cekKey, padded));

  const rs = 4096;
  const header = new Uint8Array(21 + 65);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = 65;
  header.set(asPub, 21);
  return cat(header, ct);
}

/** VAPID 키쌍을 Web Crypto 키로. 공개키의 x,y 와 비밀키 d 를 합쳐 JWK 로 넣는다. */
export async function importVapid(publicB64u, privateB64u) {
  const pub = b64uToBytes(publicB64u);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY 형식이 올바르지 않아요 (65바이트 비압축 키여야 해요)");
  const d = b64uToBytes(privateB64u);
  if (d.length !== 32) throw new Error("VAPID_PRIVATE_KEY 형식이 올바르지 않아요 (32바이트여야 해요)");
  const jwk = {
    kty: "EC", crv: "P-256", ext: true,
    x: bytesToB64u(pub.slice(1, 33)), y: bytesToB64u(pub.slice(33, 65)), d: bytesToB64u(d),
  };
  const priv = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const pubKey = await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  return { priv, pubKey };
}

/** 공개키와 비밀키가 실제로 한 쌍인지 확인 (서명 후 검증) */
export async function vapidKeysMatch(priv, pubKey) {
  const msg = te("claude-flow-vapid-selftest");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, priv, msg);
  return crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pubKey, sig, msg);
}

export async function vapidAuthHeader(endpoint, publicB64u, priv, subject) {
  const aud = new URL(endpoint).origin;
  const h = bytesToB64u(te(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const c = bytesToB64u(te(JSON.stringify({
    aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" }, priv, te(h + "." + c)));
  return `vapid t=${h}.${c}.${bytesToB64u(sig)}, k=${publicB64u}`;
}
