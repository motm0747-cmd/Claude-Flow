/* 앱이 죽지 않아야 하는 상황들.
 *
 * 기능 테스트는 '정상적인 데이터로 맞게 계산하는가'를 본다. 여기서는 그 반대를 본다 —
 * 아무것도 없는 새 기기, 반쯤 깨진 저장소, 오프라인, 큰 데이터.
 * 이 중 하나라도 흰 화면이 되면 사용자는 앱을 열 방법이 없다. */
import fs from 'node:fs';
import path from 'node:path';
import { chromium, BASE, ROOT, readRepo, makeOk } from './lib/env.mjs';

const ok = makeOk();
const b = await chromium.launch();

/* 한 판 돌리고 무엇이 깨졌는지 돌려준다 */
async function boot(seed, { viewport = { width: 390, height: 844 }, mobile = true } = {}) {
  const p = await b.newPage({ viewport, isMobile: mobile, hasTouch: mobile });
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  p.on('console', (m) => {
    const t = m.text();
    if (m.type() === 'error' && !/net::|ERR_|Failed to load|favicon/.test(t)) errs.push(t);
  });
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  if (seed) { await p.evaluate(seed); await p.reload({ waitUntil: 'domcontentloaded' }); }
  await p.waitForTimeout(600);
  return { p, errs };
}

/* 다섯 탭을 모두 열어보고 내용이 실제로 그려졌는지 본다 */
async function walkTabs(p) {
  const out = [];
  for (const v of ['home', 'cal', 'assets', 'cards', 'report']) {
    // 앱이 죽은 상태면 evaluate 자체가 던진다 — 그것도 '이 탭은 안 그려졌다'로 기록한다
    let n = 0;
    try {
      await p.evaluate((x) => switchView(x), v);
      await p.waitForTimeout(160);
      n = await p.evaluate(() => {
        const el = document.querySelector('.view.on') || document.getElementById('app');
        return el ? (el.innerText || '').trim().length : 0;
      });
    } catch (e) { n = 0; }
    out.push({ v, n });
  }
  return out;
}

/* ══════ ① 방금 산 폰 — 저장된 것이 하나도 없는 상태 ══════ */
{
  const { p, errs } = await boot(() => { localStorage.clear(); });
  const tabs = await walkTabs(p);
  const empty = tabs.filter((t) => t.n < 40);
  ok('새 기기에서 앱이 뜬다 (오류 없음)', errs.length === 0, errs.slice(0, 3).join(' | ') || '없음');
  ok('  다섯 탭이 모두 내용을 그린다', empty.length === 0, empty.map((t) => `${t.v}:${t.n}`).join(' ') || '전부 정상');
  const start = await p.evaluate(() => ({
    banner: !!document.querySelector('#setup-banner, .setup-banner'),
    accs: S.accounts.length,
    cats: (EXP_CATS || []).length,
  }));
  ok('  기본 카테고리가 준비돼 있다', start.cats > 20, String(start.cats));
  ok('  계좌는 비어 있다 (지어내지 않는다)', start.accs === 0, String(start.accs));
  await p.close();
}

/* ══════ ② 저장소가 깨져 있어도 흰 화면이 되지 않는다 ══════ */
const BROKEN = [
  ['아예 못 읽는 글자', () => localStorage.setItem('claudeflow_v1', '{이건 JSON 이 아니다')],
  ['중간에 잘린 JSON', () => localStorage.setItem('claudeflow_v1', '{"accounts":[{"id":"a","bal')],
  ['배열이어야 할 곳이 숫자', () => localStorage.setItem('claudeflow_v1', JSON.stringify({ accounts: 5, cards: 'x', tx: null }))],
  ['통째로 null', () => localStorage.setItem('claudeflow_v1', 'null')],
  ['빈 문자열', () => localStorage.setItem('claudeflow_v1', '')],
  ['거래에 필수 값이 없음', () => localStorage.setItem('claudeflow_v1', JSON.stringify({
    accounts: [{ id: 'a', type: 'checking', name: '통장' }],
    cards: [{ id: 'c', type: 'credit', name: '카드' }],
    tx: [{ id: 't' }, { id: 't2', amount: 'abc', date: 'zzz' }],
  }))],
];
for (const [label, seed] of BROKEN) {
  const { p, errs } = await boot(seed);
  const tabs = await walkTabs(p);
  const dead = tabs.filter((t) => t.n < 40);
  ok(`깨진 저장소 — ${label}`, errs.length === 0 && dead.length === 0,
    [errs[0], dead.map((t) => t.v).join(',')].filter(Boolean).join(' | ') || '정상');
  await p.close();
}

/* ══════ ③ 깨진 값을 되살린 뒤 정상 저장까지 된다 ══════ */
{
  const { p } = await boot(() => localStorage.setItem('claudeflow_v1', JSON.stringify({
    accounts: [{ id: 'a', type: 'checking', name: '통장', balance: 'NaN', cur: 'KRW' }], cards: [], tx: [],
  })));
  const r = await p.evaluate(() => {
    const before = accById('a').balance;
    openAccModal('a');
    const shown = document.getElementById('ac-bal').value;
    document.getElementById('ac-bal').value = '450,000';
    saveAcc('a', 'checking');
    return { before, shown, after: accById('a').balance, total: totalAssets() };
  });
  ok('망가진 잔액이 숫자로 되살아나고', Number.isFinite(r.before), String(r.before));
  ok('  수정 화면에 값이 보이고', r.shown !== '', `"${r.shown}"`);
  ok('  고쳐서 저장이 된다', r.after === 450000 && r.total === 450000, `${r.after}/${r.total}`);
  await p.close();
}

/* ══════ ④ 서비스워커가 캐시하는 파일이 실제로 존재한다 ══════
   목록에 없는 파일은 오프라인에서 못 열리고, 없는 파일이 목록에 있으면 설치가 통째로 실패한다. */
{
  const sw = readRepo('sw.js');
  const shell = [...sw.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]).filter((s) => s !== '');
  const missing = shell.filter((f) => !fs.existsSync(path.join(ROOT, f)));
  ok('캐시 목록의 파일이 모두 존재한다', missing.length === 0, missing.join(', ') || shell.join(' '));

  // index.html 이 같은 출처에서 부르는 스크립트가 캐시 목록에 들어 있는지
  const html = readRepo('index.html');
  const srcs = [...html.matchAll(/<script[^>]+src="(?!https?:)([^"]+)"/g)].map((m) => m[1].replace(/^\.\//, ''));
  const uncached = srcs.filter((s) => !shell.includes(s) && !shell.includes('./' + s));
  ok('  앱이 부르는 스크립트가 전부 캐시된다', uncached.length === 0, uncached.join(', ') || srcs.join(' '));

  // 캐시 버전은 index 의 빌드 표시와 함께 올라가야 한다 (안 올리면 옛 화면이 남는다)
  const cache = (sw.match(/const CACHE = '([^']+)'/) || [])[1];
  const build = (html.match(/const APP_BUILD='([^']+)'/) || [])[1];
  ok('  캐시 버전·빌드 표시가 둘 다 있다', !!cache && !!build, `${cache} / ${build}`);

  const icons = JSON.parse(readRepo('manifest.webmanifest')).icons.map((i) => i.src);
  const noIcon = icons.filter((i) => !fs.existsSync(path.join(ROOT, i)));
  ok('  manifest 의 아이콘이 모두 존재한다', noIcon.length === 0, noIcon.join(', ') || `${icons.length}개`);
}

/* ══════ ⑤ 오프라인에서도 앱이 열린다 ══════ */
{
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForTimeout(1200);                      // 서비스워커 설치 대기
  const reg = await p.evaluate(() => navigator.serviceWorker.ready.then(() => true).catch(() => false));
  await ctx.setOffline(true);
  let opened = false, txt = 0;
  try {
    await p.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await p.waitForTimeout(600);
    txt = await p.evaluate(() => (document.body.innerText || '').trim().length);
    opened = txt > 200;
  } catch (e) { opened = false; }
  ok('서비스워커가 설치된다', reg);
  ok('  네트워크가 끊겨도 앱이 열린다', opened, `본문 ${txt}자`);
  await ctx.setOffline(false);
  await ctx.close();
}

/* ══════ ⑥ 기록이 쌓여도 느려지지 않는다 ══════ */
{
  const { p, errs } = await boot(null, { viewport: { width: 390, height: 844 } });
  const r = await p.evaluate(() => {
    const CATS = ['식비', '카페/간식', '교통', '쇼핑', '구독', '통신', '의료'];
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' }];
    S.cards = [{ id: 'c1', type: 'credit', name: '카드', accountId: 'chk', payDay: 14, tiers: [], exclCats: [], perks: [] }];
    S.tx = [];
    const t0 = todayStr();
    for (let i = 0; i < 5000; i++) {
      S.tx.push({ id: 'g' + i, type: 'expense', date: addDays(t0, -(i % 900)), amount: 3000 + (i % 40) * 500,
        cat: CATS[i % CATS.length], memo: '가맹점' + (i % 60), payKind: i % 3 ? 'card' : 'account', payId: i % 3 ? 'c1' : 'chk' });
    }
    _discInvalidate(); save();
    const size = (localStorage.getItem('claudeflow_v1') || '').length;
    const t1 = performance.now(); renderAll(); const render = performance.now() - t1;
    const t2 = performance.now(); switchView('report'); const report = performance.now() - t2;
    const t3 = performance.now(); switchView('cal'); const cal = performance.now() - t3;
    switchView('home');
    return { size, render, report, cal, safe: safeSpend().ok };
  });
  ok('거래 5,000건에서도 홈이 빠르게 그려진다', r.render < 1500, `${r.render.toFixed(0)}ms`);
  ok('  리포트 탭', r.report < 2500, `${r.report.toFixed(0)}ms`);
  ok('  내역 탭', r.cal < 2500, `${r.cal.toFixed(0)}ms`);
  ok('  대표 숫자가 계속 계산된다', r.safe);
  ok('  저장 용량이 localStorage 한계 안에 있다', r.size < 4_000_000, `${(r.size / 1048576).toFixed(2)}MB`);
  ok('  이 과정에서 오류 없음', errs.length === 0, errs.slice(0, 2).join(' | ') || '없음');
  await p.close();
}

/* ══════ ⑦ 내보내기 → 가져오기 한 바퀴가 손실 없이 돈다 ══════
   폰을 바꿀 때 클라우드를 안 쓰는 사람이 쓰는 길이다. */
{
  const { p } = await boot(() => localStorage.clear());
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '하나 나라사랑', balance: 310000, cur: 'KRW' }];
    S.cards = [{ id: 'c1', type: 'credit', name: '하나 MOVING', accountId: 'chk', payDay: 14, tiers: [], exclCats: [], perks: [] }];
    S.tx = [{ id: 't1', type: 'expense', date: todayStr(), amount: 12000, cat: '식비', memo: '점심', payKind: 'card', payId: 'c1' }];
    S.settings.buffer = 200000;
    save();
    const dump = localStorage.getItem('claudeflow_v1');

    // 새 기기라고 치고 전부 지운 뒤 그 파일로 되살린다
    localStorage.removeItem('claudeflow_v1');
    localStorage.setItem('claudeflow_v1', dump);
    reloadStateFromStorage();
    return { accs: S.accounts.length, bal: S.accounts[0] && S.accounts[0].balance,
      cards: S.cards.length, tx: S.tx.length, buffer: S.settings.buffer, total: totalAssets() };
  });
  ok('내보낸 파일로 되살리면 그대로 돌아온다',
    r.accs === 1 && r.cards === 1 && r.tx === 1, `계좌${r.accs} 카드${r.cards} 거래${r.tx}`);
  ok('  잔액·설정도 그대로', r.bal === 310000 && r.buffer === 200000 && r.total === 310000,
    `${r.bal}/${r.buffer}/${r.total}`);
  await p.close();
}

await b.close();
