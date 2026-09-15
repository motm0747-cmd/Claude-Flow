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

const pwPath = resolveModule('playwright', [
  '/opt/node22/lib/node_modules/playwright/index.mjs',
  '/usr/lib/node_modules/playwright/index.mjs',
]);
export const { chromium } = await import(pwPath.startsWith('file:') ? pwPath : `file://${pwPath}`);

/* digest 엣지 함수는 TypeScript 라, 타입만 지워서 불러오려고 쓴다 */
export async function loadTypeScript() {
  const p = resolveModule('typescript', [
    '/opt/node22/lib/node_modules/typescript/lib/typescript.js',
    '/usr/lib/node_modules/typescript/lib/typescript.js',
  ]);
  return (await import(p.startsWith('file:') ? p : `file://${p}`)).default;
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
