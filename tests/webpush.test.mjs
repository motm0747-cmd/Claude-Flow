/* 브라우저(구독자) 입장에서 복호화해 보고, 원문이 그대로 나오는지 검증한다.
   이게 통과하면 실제 푸시 서비스가 받아들이는 형식이라고 볼 수 있다. */
import { encryptPayload, importVapid, vapidKeysMatch, vapidAuthHeader,
         b64uToBytes, bytesToB64u, cat, te } from './webpush.mjs';

const ok = (n, v, x='') => { console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v) process.exitCode = 1; };

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, {name:'HMAC',hash:'SHA-256'}, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
const expand = async (prk, info, len) => (await hmac(prk, cat(info, new Uint8Array([1])))).slice(0,len);

// ── 브라우저가 만드는 구독 키쌍 흉내 ──
async function fakeSubscription() {
  const kp = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'}, true, ['deriveBits']);
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return { kp, p256dh: bytesToB64u(pub), auth: bytesToB64u(auth), pubRaw: pub, authRaw: auth };
}

// ── 구독자가 받은 본문을 푸는 과정 (RFC 8291 역방향) ──
async function decrypt(body, sub) {
  const salt = body.slice(0,16);
  const idlen = body[20];
  const asPub = body.slice(21, 21+idlen);
  const ct = body.slice(21+idlen);

  const asKey = await crypto.subtle.importKey('raw', asPub, {name:'ECDH',namedCurve:'P-256'}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name:'ECDH',public:asKey}, sub.kp.privateKey, 256));

  const prkKey = await hmac(sub.authRaw, shared);
  const keyInfo = cat(te('WebPush: info\0'), sub.pubRaw, asPub);
  const ikm = await expand(prkKey, keyInfo, 32);
  const prk = await hmac(salt, ikm);
  const cek = await expand(prk, te('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await expand(prk, te('Content-Encoding: nonce\0'), 12);

  const k = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM',iv:nonce,tagLength:128}, k, ct));
  const end = pt.lastIndexOf(2);                       // 마지막 레코드 구분자
  return new TextDecoder().decode(pt.slice(0, end));
}

// ═══ 1. 암호화 왕복 ═══
const sub = await fakeSubscription();
const msg = JSON.stringify({title:'🌅 오늘의 리마인더', body:'신한 체크 결제일이 2일 남았어요 · 312,000원', url:'./', tag:'daily-digest'});
const body = await encryptPayload(sub.p256dh, sub.auth, msg);
ok('본문 헤더 길이(salt16+rs4+idlen1+key65)', body.length > 86, `${body.length}바이트`);
ok('레코드 크기 필드 = 4096', new DataView(body.buffer, body.byteOffset).getUint32(16,false) === 4096);
ok('키 길이 필드 = 65', body[20] === 65);
const round = await decrypt(body, sub);
ok('복호화 결과가 원문과 일치', round === msg, round.slice(0,40)+'…');

// ═══ 2. 한글·긴 문자열 ═══
const long = JSON.stringify({title:'테스트', body:'가나다라마바사'.repeat(50)});
ok('긴 한글 메시지 왕복', await decrypt(await encryptPayload(sub.p256dh, sub.auth, long), sub) === long);

// ═══ 3. 매번 다른 salt/ephemeral 키 ═══
const b1 = await encryptPayload(sub.p256dh, sub.auth, msg);
const b2 = await encryptPayload(sub.p256dh, sub.auth, msg);
ok('매 발송마다 암호문이 달라짐', bytesToB64u(b1) !== bytesToB64u(b2));

// ═══ 4. VAPID 키쌍 ═══
const vkp = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
const vPub = bytesToB64u(new Uint8Array(await crypto.subtle.exportKey('raw', vkp.publicKey)));
const vJwk = await crypto.subtle.exportKey('jwk', vkp.privateKey);
const vPriv = vJwk.d;

const { priv, pubKey } = await importVapid(vPub, vPriv);
ok('VAPID 키 가져오기', !!priv && !!pubKey);
ok('공개/비밀 키 짝 확인 통과', await vapidKeysMatch(priv, pubKey));

// 짝이 아닌 키를 넣으면 잡아내야 한다
const other = await crypto.subtle.generateKey({name:'ECDSA',namedCurve:'P-256'}, true, ['sign','verify']);
const otherPub = bytesToB64u(new Uint8Array(await crypto.subtle.exportKey('raw', other.publicKey)));
let mismatchDetected = false;
try {
  const m = await importVapid(otherPub, vPriv);
  mismatchDetected = !(await vapidKeysMatch(m.priv, m.pubKey));
} catch { mismatchDetected = true; }   // 웹크립토가 아예 거부해도 '탐지'로 본다
ok('짝이 아닌 VAPID 키쌍 탐지', mismatchDetected);

// ═══ 5. Authorization 헤더 형식 ═══
const auth = await vapidAuthHeader('https://fcm.googleapis.com/fcm/send/abc123', vPub, priv, 'mailto:me@example.com');
ok('헤더 접두어 vapid t=…, k=…', /^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(auth), auth.slice(0,30)+'…');
const [, jwt] = auth.match(/t=([^,]+)/);
const [jh, jc, js] = jwt.split('.');
const hdr = JSON.parse(new TextDecoder().decode(b64uToBytes(jh)));
const clm = JSON.parse(new TextDecoder().decode(b64uToBytes(jc)));
ok('  JWT 헤더 alg=ES256', hdr.alg === 'ES256' && hdr.typ === 'JWT');
ok('  aud = 푸시 서비스 origin', clm.aud === 'https://fcm.googleapis.com', clm.aud);
ok('  sub = mailto', clm.sub === 'mailto:me@example.com');
ok('  exp 12시간 이내', clm.exp > Date.now()/1000 && clm.exp <= Date.now()/1000 + 12*3600 + 5);
ok('  서명 64바이트 (r||s)', b64uToBytes(js).length === 64);
const sigOk = await crypto.subtle.verify({name:'ECDSA',hash:'SHA-256'}, vkp.publicKey, b64uToBytes(js), te(jh+'.'+jc));
ok('  서명 검증 통과', sigOk);

// ═══ 6. 잘못된 입력 방어 ═══
const rejects = async (fn) => { try { await fn(); return false; } catch { return true; } };
ok('잘못된 p256dh 거부', await rejects(()=>encryptPayload(bytesToB64u(new Uint8Array(10)), sub.auth, 'x')));
ok('잘못된 auth 길이 거부', await rejects(()=>encryptPayload(sub.p256dh, bytesToB64u(new Uint8Array(5)), 'x')));
ok('잘못된 VAPID 공개키 거부', await rejects(()=>importVapid(bytesToB64u(new Uint8Array(10)), vPriv)));
ok('잘못된 VAPID 비밀키 거부', await rejects(()=>importVapid(vPub, bytesToB64u(new Uint8Array(10)))));
