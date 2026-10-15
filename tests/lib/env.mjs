/* 테스트 공통 환경.
 * 테스트마다 playwright 경로와 서버 주소를 하드코딩하고 있었는데, 그러면 다른 기계에서
 * 통째로 못 돌린다. 여기 한 곳에서만 찾는다. */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PORT = +(process.env.CF_TEST_PORT || 8199);
export const BASE = process.env.CF_TEST_BASE || `http://127.0.0.1:${PORT}`;
export const APP = `${BASE}/index.html`;

/* 설치 위치가 환경마다 달라서 순서대로 찾는다 */
function resolveModule(name, fallbacks) {
  try { return require.resolve(name); } catch (_) {}
  for (const f of fallbacks) { if (fs.existsSync(f)) return f; }
  throw new Error(
    `${name} 를 찾지 못했습니다. npm i -D ${name} 하거나 경로를 lib/env.mjs 에 추가하세요.`);
}
const asUrl = (p) => (p.startsWith('file:') ? p : `file://${p}`);

/* ── playwright 불러오기 ──────────────────────────────────────────────
 * require.resolve 는 환경에 따라 CJS 진입점(index.js)을 준다. 그걸 import 하면
 * 노드가 이름 있는 export 를 찾아내지 못해 **chromium 이 조용히 undefined** 가 되고,
 * 테스트는 `Cannot read properties of undefined (reading 'launch')` 로 전부 죽는다.
 * (실제로 컨테이너가 바뀌자 26개 묶음이 한꺼번에 '실행 실패' 가 됐다.)
 * 그래서 .mjs 짝을 먼저 보고, 없으면 default 에서 꺼내고, 그래도 없으면
 * 무엇이 잘못됐는지 말하고 멈춘다 — undefined 를 들고 더 가지 않는다. */
const pwPath = resolveModule('playwright', [
  '/opt/node-tools/node_modules/playwright/index.mjs',
  '/opt/node22/lib/node_modules/playwright/index.mjs',
  '/usr/lib/node_modules/playwright/index.mjs',
]);
const pwMjs = pwPath.replace(/index\.js$/, 'index.mjs');
const pwMod = await import(asUrl(pwMjs !== pwPath && fs.existsSync(pwMjs) ? pwMjs : pwPath));
export const chromium = pwMod.chromium || (pwMod.default && pwMod.default.chromium);
if (!chromium || typeof chromium.launch !== 'function') {
  throw new Error(`playwright 를 불러왔지만 chromium 이 없습니다 (${pwPath}). `
    + `export: ${Object.keys(pwMod).join(',') || '(없음)'}`);
}

/* digest 엣지 함수는 TypeScript 라, 타입만 지워서 불러오려고 쓴다 */
export async function loadTypeScript() {
  const p = resolveModule('typescript', [
    '/opt/node-tools/node_modules/typescript/lib/typescript.js',
    '/opt/node22/lib/node_modules/typescript/lib/typescript.js',
    '/usr/lib/node_modules/typescript/lib/typescript.js',
  ]);
  const m = await import(asUrl(p));
  return m.default || m;
}

/* 생성 파일(타입 지운 .mjs 등)을 둘 곳 — 저장소를 더럽히지 않는다 */
export const TMP = path.join(ROOT, 'tests', '.tmp');
fs.mkdirSync(TMP, { recursive: true });

export const readRepo = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/* 판정 헬퍼 — 실패하면 exitCode 를 세워 러너가 알아챈다 */
export const makeOk = () => (name, pass, extra = '') => {
  console.log(`${pass ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!pass) process.exitCode = 1;
};
