/* 화면 정리 검증 —
   ① 걷어낸 기능 3개(지출 게이지·소비 예측·What-if)가 정말 없는지, 그러면서 다른 화면이
      쓰던 계산은 살아 있는지
   ② 자산 탭: 안 쓰는 분류 숨김 + 그룹 접기
   ③ 리포트 탭: 세그먼트 3개
   ④ 내역 탭: 달력 + 날짜별 통합 */
import { chromium, APP, BASE } from './lib/env.mjs';
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { const t = m.text(); if (m.type() === 'error' && !/net::ERR|Failed to load resource|supabase/i.test(t)) errs.push(t); });
await p.goto(APP, { waitUntil: 'load' });
await p.waitForTimeout(1000);
const ok = (n, v, x = '') => { console.log(`${v ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!v) process.exitCode = 1; };
let r;

// 계좌 1개 + 카드 1개 + 한 달치 지출 (평범한 사용자)
const seed = async () => {
  await p.evaluate(() => {
    const d = todayStr(), day = n => addDays(d, -n);
    S.accounts = [{ id: 'chk', type: 'checking', name: '생활비 통장', balance: 1850000, cur: 'KRW' }];
    S.cards = [{ id: 'c1', type: 'credit', name: '하나 MOVING', accountId: 'chk', payDay: 14, tiers: [], exclCats: [], perks: [], prepays: [] }];
    S.tx = []; S.goals = []; S.debts = []; S.invLogs = []; S.recons = [];
    S.fixed = [{ id: 'f1', name: '월세', kind: 'expense', amount: 600000, day: 25, cat: '주거', active: true }];
    const memos = ['스타벅스', '배민', 'GS25'], cats = ['카페/간식', '배달', '편의점'];
    for (let i = 0; i < 30; i++) S.tx.push({ id: 't' + i, type: 'expense', date: day(i % 20),
      amount: 4000 + (i * 1300) % 20000, cat: cats[i % 3], memo: memos[i % 3], payKind: 'card', payId: 'c1', months: 1, paidPortions: 0 });
    S.settings.assetOpen = {}; delete S.settings.repView; delete S.settings.txView;
    _discInvalidate(); save(); renderAll();
  });
  await p.waitForTimeout(350);
};
await seed();

/* ══════ ① 걷어낸 기능 ══════ */
r = await p.evaluate(() => {
  const all = document.body.innerText;
  return { gauge: /오늘의 지출 게이지/.test(all), fc: /소비 예측/.test(all),
    ids: ['smart-gauge', 'forecast-card', 'whatif-card'].filter(i => !!document.getElementById(i)),
    fns: ['renderSmartGauge', 'renderForecast', 'renderWhatIf'].filter(f => typeof window[f] === 'function') };
});
ok('지출 게이지 사라짐', !r.gauge);
ok('소비 예측 사라짐', !r.fc);
ok('  빈 자리(div)도 안 남음', r.ids.length === 0, r.ids.join(','));
ok('  함수도 안 남음', r.fns.length === 0, r.fns.join(','));

r = await p.evaluate(() => { switchView('report'); setRepView('fore'); return document.body.innerText; });
ok('What-if 사라짐', !/What-if|지를까 말까/.test(r));

// 지운 카드가 쓰던 계산은 다른 화면이 여전히 쓴다 — 같이 지우면 안 된다
r = await p.evaluate(() => ({
  fm: typeof forecastMonth === 'function' && forecastMonth().predicted > 0,
  os: typeof overspendInfo === 'function' && typeof overspendInfo().avg === 'number',
  rms: typeof recentMonthlySaving === 'function',
}));
ok('리포트가 쓰는 소비 예상치는 살아 있음', r.fm);
ok('과소비 경고가 쓰는 계산도 살아 있음', r.os);
ok('시뮬레이터가 쓰는 저축 여력도 살아 있음', r.rms);

/* ══════ ② 자산 탭 ══════ */
r = await p.evaluate(() => {
  switchView('assets');
  const t = $('view-assets').innerText;
  // 섹션 제목만 본다 — '＋ 예금' 같은 추가 칩까지 세면 숨김 판정이 틀어진다
  const secs = [...document.querySelectorAll('#asset-groups .sec-title:not(.ag-head)')].map(e => e.innerText.split('\n')[0].trim());
  return { t, secs, heads: [...document.querySelectorAll('#asset-groups .ag-head')].map(e => e.innerText.split('\n')[0]),
    chips: [...document.querySelectorAll('.add-chip')].map(e => e.innerText.trim()),
    empties: [...document.querySelectorAll('#view-assets .empty')].map(e => e.innerText.slice(0, 20)) };
});
ok('묶음 3개로 정리', r.heads.length === 3, r.heads.join(' / '));
ok('  안 쓰는 분류는 제목이 안 보임',
   !r.secs.some(s => /^(예금|적금 · 묶인 돈|주택청약|저축 목표|받을 돈|고정 수입|투자)/.test(s)), r.secs.join(' / '));
ok('  남은 제목은 실제로 쓰는 것뿐', r.secs.join('/') === '입출금 · 현금성/고정비/잔액 대조', r.secs.join(' / '));
ok('  대신 추가 칩으로 남음', r.chips.some(c => c.includes('예금')) && r.chips.some(c => c.includes('적금')), r.chips.join(' '));
ok('  입출금은 비어 있어도 보임(쓸 수 있는 돈의 근거)', /입출금 · 현금성/.test(r.t));
ok('  "추가해보세요" 빈 상자 안 남음', r.empties.filter(e => /추가해보세요/.test(e)).length === 0, r.empties.join('|'));

// 하나 만들면 그 분류가 제 자리를 얻는다
r = await p.evaluate(() => {
  S.accounts.push({ id: 'dep1', type: 'deposit', name: '정기예금', balance: 5000000, cur: 'KRW' });
  save(); renderAssets();
  const secs = [...document.querySelectorAll('#asset-groups .sec-title:not(.ag-head)')].map(e => e.innerText.split('\n')[0].trim());
  return { shown: secs.includes('예금'), secs,
    chip: [...document.querySelectorAll('.add-chip')].some(e => e.innerText.includes('예금')) };
});
ok('예금을 만들면 그 분류가 나타남', r.shown, r.secs.join(' / '));
ok('  추가 칩에서는 빠짐', !r.chip);

// 그룹 접기 — 상태가 저장된다
r = await p.evaluate(() => {
  const before = $('view-assets').innerText.includes('입출금 · 현금성');
  toggleAssetGroup('cash');
  const after = $('view-assets').innerText.includes('입출금 · 현금성');
  const saved = S.settings.assetOpen.cash;
  toggleAssetGroup('cash');
  return { before, after, saved, back: $('view-assets').innerText.includes('입출금 · 현금성') };
});
ok('묶음을 접으면 내용이 숨음', r.before && !r.after);
ok('  접은 상태가 저장됨', r.saved === false);
ok('  다시 펴짐', r.back);

// 비어 있는 묶음은 처음부터 접혀 있다
r = await p.evaluate(() => {
  S.settings.assetOpen = {}; save(); renderAssets();
  const g = ASSET_GROUPS.find(x => x.k === 'inv');
  return { open: assetGroupOpen(g), txt: $('view-assets').innerText.includes('투자 계좌') };
});
ok('투자 자산이 없으면 투자 묶음은 접혀 있음', r.open === false);

/* ══════ ③ 리포트 탭 ══════ */
r = await p.evaluate(() => {
  switchView('report'); setRepView('sum');
  const vis = k => { const e = $('repview-' + k); return e && e.style.display !== 'none'; };
  return { n: document.querySelectorAll('#rep-viewseg button').length,
    sum: vis('sum'), fore: vis('fore'), style: vis('style'), t: $('view-report').innerText };
});
ok('리포트 세그먼트 3개', r.n === 3);
ok('  요약만 보임', r.sum && !r.fore && !r.style);
ok('  요약에는 현금흐름·월별 리포트', /현금흐름|월별 리포트/.test(r.t), r.t.slice(0, 40));
ok('  예측·성향 내용은 안 섞임', !/시뮬레이터|소비 성향/.test(r.t));

r = await p.evaluate(() => { setRepView('fore'); return { t: $('view-report').innerText, saved: S.settings.repView }; });
ok('예측 탭 — 순자산 흐름·시뮬레이터', /순자산 흐름/.test(r.t) && /시뮬레이터/.test(r.t), r.t.slice(0, 40));
ok('  선택이 저장됨', r.saved === 'fore');

r = await p.evaluate(() => { setRepView('style'); return $('view-report').innerText; });
ok('성향 탭 — 수입원·소비 성향', /수입원/.test(r) && /소비 성향/.test(r), r.slice(0, 40));

/* ══════ ④ 내역 탭 ══════ */
r = await p.evaluate(() => {
  switchView('cal');
  return { segs: [...document.querySelectorAll('#tx-viewseg button')].map(e => e.innerText.trim()),
    cal: $('cal-box').style.display !== 'none', gone: !document.getElementById('list-wrap') };
});
ok('세그먼트가 2개로 줄어듦', r.segs.length === 2 && r.segs.join('|') === '날짜별|카테고리별', r.segs.join('|'));
ok('  옛 날짜별 전용 화면은 사라짐', r.gone);
ok('날짜별에 달력이 함께 보임', r.cal);

r = await p.evaluate(() => { setTxView('cat'); return { cal: $('cal-box').style.display, t: $('lst-body').innerText }; });
ok('카테고리별에서는 달력이 접힘', r.cal === 'none');
ok('  카테고리 묶음이 나옴', /카페\/간식|배달|편의점/.test(r.t), r.t.slice(0, 30));

// 달력에서 날짜를 누르면 아래 목록이 그 날로 좁혀진다
r = await p.evaluate(() => {
  setTxView('list');
  const d = todayStr();
  tapDay(d);
  const only = [...document.querySelectorAll('#lst-body .day-head')].length;
  const title = $('cal-list-title').innerText;
  const clear = $('cal-clear').style.display !== 'none';
  tapDay(d);
  return { only, title, clear, back: [...document.querySelectorAll('#lst-body .day-head')].length };
});
ok('날짜를 누르면 그 날만 남음', r.only === 1, `${r.only}일`);
ok('  제목이 그 날짜로 바뀜', /월 \d+일 내역/.test(r.title), r.title);
ok('  "전체 보기"가 뜸', r.clear);
ok('  다시 누르면 한 달 전체로', r.back > 1, `${r.back}일`);

// 달 이동이 달력과 목록에 동시에 먹는다 (예전엔 각자 다른 달을 가리킬 수 있었다)
r = await p.evaluate(() => {
  const now = $('cal-label').innerText;
  calMove(-1);
  const moved = { label: $('cal-label').innerText, body: $('lst-body').innerText, ym: calYM };
  calMove(1);
  return { now, moved, backTo: $('cal-label').innerText };
});
ok('달 이동이 달력·목록에 함께 먹음', r.moved.label !== r.now && r.moved.ym < thisYMNode(), `${r.now} → ${r.moved.label}`);
ok('  되돌아옴', r.backTo === r.now);
function thisYMNode() { return '9999-99'; }   // 위 비교용 상한

// 전체/지출/수입 필터
r = await p.evaluate(() => {
  S.tx.push({ id: 'inc1', type: 'income', date: todayStr(), amount: 3000000, cat: '급여', memo: '월급', payKind: 'account', payId: 'chk' });
  _discInvalidate(); save(); renderCal();
  setLstFilter('income');
  const incOnly = $('lst-body').innerText;
  setLstFilter('expense');
  const expOnly = $('lst-body').innerText;
  setLstFilter('');
  return { incOnly, expOnly, on: $('lf-expense').classList.contains('on') };
});
ok('수입 필터', /월급/.test(r.incOnly) && !/스타벅스/.test(r.incOnly), r.incOnly.slice(0, 30));
ok('지출 필터', /스타벅스|배민|GS25/.test(r.expOnly) && !/월급/.test(r.expOnly), r.expOnly.slice(0, 30));

// 최근 며칠만 펼치고 나머지는 눌러서 연다
r = await p.evaluate(() => {
  setTxView('list'); setLstFilter(''); lstAll = false; renderCal();
  const capped = document.querySelectorAll('#lst-body .day-head').length;
  const btn = [...document.querySelectorAll('#lst-body button')].find(b => /더 보기/.test(b.innerText));
  const label = btn ? btn.innerText.trim() : '';
  if (btn) btn.click();
  return { capped, label, all: document.querySelectorAll('#lst-body .day-head').length };
});
ok('한 달치를 통째로 펼치지 않음', r.capped === 7, `${r.capped}일`);
ok('  "더 보기" 버튼', /이전 \d+일 더 보기/.test(r.label), r.label);
ok('  누르면 전부 펼쳐짐', r.all > r.capped, `${r.capped} → ${r.all}일`);

// 예전 '달력' 설정으로 저장된 사람은 '날짜별'로 옮겨진다
r = await p.evaluate(() => {
  S.settings.txView = 'cal'; save();
  migrate();
  return S.settings.txView;
});
ok("옛 '달력' 설정은 '날짜별'로 이관", r === 'list', r);

ok('콘솔/페이지 오류 없음', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close();
