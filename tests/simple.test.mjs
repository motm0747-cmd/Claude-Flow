/* 간편 단순화 — '보러 온 것이 먼저 온다'.
 *
 * 재어보니 모든 탭이 거꾸로였다. 보러 온 것 위에 그것에 대한 분석이 먼저 깔려 있었다.
 *   ① 카드 탭: 내 카드가 657px 아래. 위에 피킹률 분석 574px
 *   ② 자산 탭: 내 계좌가 357px 아래. 위에 자산 배분 231px
 *   ③ 설정: 1,177px · 버튼 17개 — 화면(844px)을 넘겨, 매일 쓰는 로그인·테마까지
 *      1년에 한 번 쓰는 초기화·타임머신과 같은 스크롤 안에 있었다
 *   ④ 첫 실행: 들어본 적 없는 것의 진척도 '분석 준비 중 0/10건'
 *
 * 지우는 게 아니라 순서를 바꾼 것이므로, **접었다 펴면 내용이 그대로 와야 한다**.
 * 그걸 같이 고정한다 — 안 그러면 '단순화' 가 그냥 기능 상실이 된다. */
import { chromium, BASE, makeOk } from './lib/env.mjs';

const ok = makeOk();
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
  timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
await ctx.route('**/*', (r) => (r.request().url().includes('127.0.0.1') ? r.continue() : r.abort()));
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
p.on('console', (m) => { const t = m.text(); if (m.type() === 'error' && !/net::|ERR_|Failed to load/.test(t)) errs.push(t); });
await p.goto(BASE + '/', { waitUntil: 'load' });
await p.waitForTimeout(700);

const ev = async (fn, arg) => { try { return await p.evaluate(fn, arg); } catch (e) { return { _err: String(e.message || e).split('\n')[0] }; } };

/* 실사용자에 가까운 상태 — 계좌 3·카드 2(혜택 등록 1)·고정비 2·거래 120건 */
const seed = () => p.evaluate(() => {
  const t = todayStr();
  S.accounts = [
    { id: 'chk', type: 'checking', name: '하나 주거래', balance: 2400000, cur: 'KRW' },
    { id: 'sav', type: 'saving', name: '비상금', balance: 8000000, cur: 'KRW' },
  ];
  S.cards = [
    { id: 'c1', type: 'credit', name: '하나 MOVING', accountId: 'chk', payDay: 14, tiers: [500000],
      exclCats: [], perks: [{ name: '기본적립', cat: '전체', kind: 'percent', value: 1, tier: 0 }],
      prepays: [], open: { ym: '', pending: 0, perf: 0 } },
    { id: 'c2', type: 'credit', name: '삼성 iD', accountId: 'chk', payDay: 25, tiers: [300000, 700000],
      exclCats: [], perks: [], prepays: [], open: { ym: '', pending: 0, perf: 0 } },
  ];
  S.fixed = [{ id: 'f1', name: '월세', amount: 750000, day: 25, cat: '주거/통신', kind: 'expense' },
    { id: 'f2', name: '급여', amount: 3600000, day: 10, cat: '급여', kind: 'income' }];
  S.tx = [];
  const cats = ['식비', '카페/간식', '교통', '쇼핑', '생활', '의료'];
  const shops = ['김밥천국', '스타벅스', '지하철', '쿠팡', '다이소', '약국'];
  for (let i = 0; i < 120; i++) S.tx.push({ id: 'g' + i, type: 'expense', date: addDays(t, -(i % 60)),
    amount: 4000 + (i * 737) % 40000, cat: cats[i % 6], memo: shops[i % 6], payKind: 'card', payId: i % 3 ? 'c1' : 'c2' });
  S.settings.setupAt = addDays(t, -200);
  S.settings.fold = {};
  _discInvalidate(); save(); renderAll();
});

/* 탭 안에서 어떤 요소가 화면 위에서 몇 px 에 있는지 */
const topOf = (view, sel) => p.evaluate(({ v, s }) => {
  const root = document.getElementById('view-' + v);
  const host = root.querySelector(s);
  if (!host) return -1;
  return Math.round(host.getBoundingClientRect().top - root.getBoundingClientRect().top);
}, { v: view, s: sel });

const hOf = (view, sel) => p.evaluate(({ v, s }) => {
  const root = document.getElementById('view-' + v);
  const e = root.querySelector(s);
  return e ? Math.round(e.getBoundingClientRect().height) : -1;
}, { v: view, s: sel });

/* ══════ ① 카드 탭 — 내 카드가 먼저, 피킹률은 접혀 아래에 ══════ */
{
  await seed();
  await p.evaluate(() => { switchView('cards'); setCardView('manage'); window.scrollTo(0, 0); });
  await p.waitForTimeout(450);
  const r = await ev(() => {
    const root = document.getElementById('view-cards');
    const rt = root.getBoundingClientRect().top;
    const top = (s) => { const e = root.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top - rt) : -1; };
    return { h: Math.round(root.scrollHeight), list: top('#card-list'), pick: top('#pick-card'),
      pickH: Math.round((root.querySelector('#pick-card') || {}).getBoundingClientRect ? root.querySelector('#pick-card').getBoundingClientRect().height : 0),
      pickTxt: (root.querySelector('#pick-card') || {}).innerText || '',
      names: (root.querySelector('#card-list') || {}).innerText || '' };
  });
  ok('카드 탭: 내 카드가 첫 화면 안에', r.list > 0 && r.list < 844, `${r.list}px`);
  ok('  피킹률은 내 카드 아래', r.pick > r.list, `카드 ${r.list}px · 피킹률 ${r.pick}px`);
  ok('  피킹률은 접혀 한 줄', r.pickH > 0 && r.pickH < 120, `${r.pickH}px`);
  ok('  접혀도 비율·등급은 보인다', /%/.test(r.pickTxt) && r.pickTxt.length < 90, JSON.stringify(r.pickTxt.slice(0, 60)));
  ok('  내 카드 2장이 다 보인다', /하나 MOVING/.test(r.names) && /삼성 iD/.test(r.names));
  ok('  탭 전체가 1,000px 아래', r.h < 1000, `${r.h}px`);
}

/* ══════ ①-b 펼치면 내용이 그대로 — 단순화는 기능 상실이 아니다 ══════ */
{
  await ev(() => toggleFold('pick'));
  await p.waitForTimeout(400);
  const r = await ev(() => {
    const el = document.getElementById('pick-card');
    return { h: Math.round(el.getBoundingClientRect().height), txt: el.innerText,
      bench: /낮음[\s\S]*양호[\s\S]*우수[\s\S]*최상/.test(el.innerText) };
  });
  ok('펼치면 피킹률 본문이 돌아온다', r.h > 400, `${r.h}px`);
  ok('  전체 피킹률 숫자', /전체 피킹률/.test(r.txt));
  ok('  비교 눈금(낮음·양호·우수·최상)', r.bench);
  ok('  카드별 줄', /하나 MOVING/.test(r.txt));
  ok('  예상치 고지', /예상치/.test(r.txt));
  const kept = await ev(() => { closeModal(); location.reload(); return 1; });
  void kept;
  await p.waitForTimeout(1000);
  const again = await ev(() => { switchView('cards'); setCardView('manage');
    return !!(S.settings.fold && S.settings.fold.pick); });
  ok('  펼친 상태는 다시 열어도 기억된다', again === true, String(again));
}

/* ══════ ② 자산 탭 — 내 계좌가 먼저, 배분은 접혀 아래에 ══════ */
{
  await seed();
  await p.evaluate(() => { switchView('assets'); window.scrollTo(0, 0); });
  await p.waitForTimeout(450);
  const r = await ev(() => {
    const root = document.getElementById('view-assets');
    const rt = root.getBoundingClientRect().top;
    const top = (s) => { const e = root.querySelector(s); return e ? Math.round(e.getBoundingClientRect().top - rt) : -1; };
    const al = root.querySelector('#alloc-card');
    return { grp: top('#asset-groups > *'), alloc: top('#alloc-card'),
      allocH: al ? Math.round(al.getBoundingClientRect().height) : -1,
      allocTxt: al ? al.innerText : '', accTxt: (root.querySelector('#list-checking') || {}).innerText || '' };
  });
  ok('자산 탭: 내 계좌 묶음이 첫 화면 안에', r.grp > 0 && r.grp < 500, `${r.grp}px`);
  ok('  자산 배분은 계좌 아래', r.alloc > r.grp, `계좌 ${r.grp}px · 배분 ${r.alloc}px`);
  ok('  배분은 접혀 한 줄', r.allocH > 0 && r.allocH < 110, `${r.allocH}px`);
  ok('  접혀도 상태 한 마디는 남는다', /목표|조정|맞음/.test(r.allocTxt), JSON.stringify(r.allocTxt.slice(0, 50)));
  ok('  주거래 잔액이 보인다', /하나 주거래/.test(r.accTxt), JSON.stringify(r.accTxt.slice(0, 40)));
}

/* ══════ ②-b 배분을 펼치면 도표와 제안이 그대로 ══════ */
{
  await ev(() => { S.alloc = { cash: 30, safe: 30, invest: 40 }; save(); toggleFold('alloc'); });
  await p.waitForTimeout(400);
  const r = await ev(() => {
    const el = document.getElementById('alloc-card');
    return { h: Math.round(el.getBoundingClientRect().height), txt: el.innerText,
      bars: el.querySelectorAll('.legend-dot').length,
      btn: [...el.querySelectorAll('button')].map((x) => x.textContent.trim()).join('|') };
  });
  ok('펼치면 배분 본문이 돌아온다', r.h > 180, `${r.h}px`);
  ok('  세 묶음 비중 줄', r.bars >= 3, `${r.bars}개`);
  ok('  목표 수정 버튼', /목표/.test(r.btn), r.btn);
  ok('  목표를 정했으면 조정 제안', /%p|맞춰져/.test(r.txt), JSON.stringify(r.txt.slice(-80)));
}

/* ══════ ③ 설정 — 매일 쓰는 것이 한 화면에, 1년에 한 번은 접힌다 ══════ */
{
  await seed();
  await p.evaluate(() => openSettings());
  await p.waitForTimeout(450);
  const r = await ev(() => {
    const sh = document.getElementById('sheet');
    const vis = [...sh.querySelectorAll('button')].filter((e) => e.offsetParent).map((e) => e.textContent.trim());
    return { h: Math.round(sh.scrollHeight), vh: window.innerHeight, btns: vis,
      adv: !!document.getElementById('st-adv'),
      advShown: !!(document.getElementById('st-adv') || {}).offsetParent };
  });
  ok('설정이 한 화면에 들어온다', r.h <= r.vh, `${r.h}px / 화면 ${r.vh}px`);
  ok('  보이는 버튼 10개 이하', r.btns.length <= 10, `${r.btns.length}개: ${r.btns.join(',')}`);
  ok('  고급 묶음은 처음엔 접혀 있다', r.adv && !r.advShown);
  ok('  초기화는 접힘 안에 숨어 있다', !r.btns.some((t) => /전체 초기화/.test(t)), r.btns.join(','));
  ok('  타임머신도 접힘 안에', !r.btns.some((t) => /타임머신/.test(t)));
  ok('  매일 쓰는 테마는 바로 보인다', r.btns.some((t) => /다크/.test(t)));
  ok('  카테고리 관리도 바로 보인다', r.btns.some((t) => /카테고리/.test(t)));
}

/* ══════ ③-b 고급을 펼치면 일곱 가지가 전부 거기 있다 ══════ */
{
  await ev(() => toggleStAdv());
  await p.waitForTimeout(300);
  const r = await ev(() => {
    const sh = document.getElementById('sheet');
    const vis = [...sh.querySelectorAll('button')].filter((e) => e.offsetParent).map((e) => e.textContent.trim());
    return { btns: vis, file: !!document.getElementById('st-file'), key: !!document.getElementById('st-key') };
  });
  /* 환율은 달러를 쓸 때만 나오므로 여기 목록에 없다 — ⑤-c 가 따로 본다 */
  const want = ['고정수입', '쓰던 걸', '내보내기', '가져오기', '타임머신', '전체 초기화'];
  for (const w of want) ok(`  고급 안: ${w}`, r.btns.some((t) => t.includes(w)), r.btns.join(' / '));
  ok('  가져오기 파일칸도 살아 있다', r.file);
  ok('  Gemini 키칸도 거기 있다', r.key);
}

/* ══════ ③-c 다시 열면 또 접혀 있다 — '치워져 있어야' 치운 의미가 있다 ══════ */
{
  await p.evaluate(() => { closeModal(); openSettings(); });
  await p.waitForTimeout(400);
  const shown = await ev(() => !!(document.getElementById('st-adv') || {}).offsetParent);
  ok('설정을 다시 열면 고급은 또 접혀 있다', shown === false, String(shown));
  await p.evaluate(() => closeModal());
}

/* ══════ ④ 첫 실행 — 들어본 적 없는 것의 진척도를 내밀지 않는다 ══════ */
{
  await p.evaluate(() => localStorage.clear());
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(900);
  const r = await ev(() => {
    const chip = document.getElementById('h-score-chip');
    const root = document.getElementById('view-home');
    return { shown: !!chip.offsetParent, txt: root.innerText,
      h: Math.round(root.scrollHeight) };
  });
  ok('첫 실행에 Health Score 칩이 없다', r.shown === false, String(r.shown));
  ok('  "0/10건" 이 화면에 없다', !/0\/10건/.test(r.txt));
  ok('  대신 시작 안내가 있다', /60초/.test(r.txt));
}

/* ══════ ④-b 한 건이라도 넣으면 진척도가 나온다 — 그때는 격려가 된다 ══════ */
{
  await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 1000000, cur: 'KRW' }];
    S.tx = [{ id: 't1', type: 'expense', date: todayStr(), amount: 9000, cat: '식비', memo: '김밥', payKind: 'cash' }];
    _discInvalidate(); save(); renderAll();
  });
  await p.waitForTimeout(400);
  const r = await ev(() => {
    const chip = document.getElementById('h-score-chip');
    return { shown: !!chip.offsetParent, txt: chip.innerText };
  });
  ok('1건 넣으면 진척도가 보인다', r.shown === true, String(r.shown));
  ok('  몇 건 남았는지 말한다', /\/10건/.test(r.txt), JSON.stringify(r.txt));
}

/* ══════ ⑤ 안 쓰는 묶음은 제목째로 내려간다 ══════
 *
 * 투자를 안 쓰는 사람에게 투자 기능이 '실제로' 얼마나 보이는지 재어보니,
 * 배너·수익률·DCA·환율칩은 이미 전부 자동으로 숨고 있었고 남은 건
 * 자산 탭 한가운데의 '투자 0원 ▾' 머리와 총자산 부제의 '· 투자 0원' 뿐이었다.
 * 그래서 코드를 들어내는 대신 그 둘을 치운다 — 계좌를 만들면 그대로 돌아온다.
 * 돌아오는지까지 같이 보는 게 이 묶음의 핵심이다. */
{
  await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 2400000, cur: 'KRW' },
      { id: 'sv', type: 'saving', name: '비상금', balance: 8000000, cur: 'KRW' }];
    S.cards = []; S.invLogs = []; S.goals = []; S.debts = [];
    S.fixed = [{ id: 'f1', name: '월세', amount: 750000, day: 25, cat: '주거/통신', kind: 'expense' }];
    delete S.alloc; S.settings.dcaM = 0; S.settings.fold = {};
    _discInvalidate(); save(); renderAll(); switchView('assets');
  });
  await p.waitForTimeout(450);
  const r = await ev(() => {
    const root = document.getElementById('view-assets');
    const vis = (e) => e.offsetParent !== null;
    const heads = [...root.querySelectorAll('.ag-head')].filter(vis).map((e) => e.textContent.trim());
    const rows = [...root.querySelectorAll('.add-row')].filter(vis);
    return { heads, rows: rows.length,
      chips: rows.flatMap((x) => [...x.querySelectorAll('.add-chip')].map((c) => c.textContent.trim())),
      sub: document.getElementById('a-total-sub').textContent,
      total: totalAssets() };
  });
  ok('투자 계좌가 없으면 "투자" 묶음 머리가 없다', !r.heads.some((t) => /^투자/.test(t)), r.heads.join(' / '));
  ok('  대신 "＋ 투자 계좌" 칩으로만 남는다', r.chips.some((t) => /투자 계좌/.test(t)), r.chips.join(' / '));
  ok('  칩 줄이 둘로 갈리지 않는다', r.rows <= 2, `${r.rows}줄`);
  ok('  총자산 부제에 "투자 0원" 이 없다', !/투자/.test(r.sub), r.sub);
  ok('  0원인 칸은 아예 적지 않는다', !/0원/.test(r.sub), r.sub);
  ok('  총자산은 그대로', r.total === 10400000, String(r.total));
}

/* ══════ ⑤-b 투자 계좌를 만들면 묶음이 통째로 돌아온다 (기능 상실이 아니다) ══════ */
{
  await p.evaluate(() => {
    S.accounts.push({ id: 'iv', type: 'invest', name: '연금저축', balance: 5000000, cur: 'KRW' });
    _discInvalidate(); save(); renderAll(); switchView('assets');
  });
  await p.waitForTimeout(450);
  const r = await ev(() => {
    const root = document.getElementById('view-assets');
    const vis = (e) => e.offsetParent !== null;
    return { heads: [...root.querySelectorAll('.ag-head')].filter(vis).map((e) => e.textContent.trim()),
      list: (document.getElementById('list-invest') || {}).innerText || '',
      slots: ['inv-alert', 'invperf-card', 'dca-card'].filter((id) => document.getElementById(id)),
      sub: document.getElementById('a-total-sub').textContent,
      total: totalAssets() };
  });
  ok('투자 계좌를 만들면 "투자" 묶음이 돌아온다', r.heads.some((t) => /^투자/.test(t)), r.heads.join(' / '));
  ok('  계좌가 목록에 보인다', /연금저축/.test(r.list), JSON.stringify(r.list.slice(0, 40)));
  ok('  수익률·DCA 칸도 같이 돌아온다', r.slots.length === 3, r.slots.join(','));
  ok('  총자산 부제에 투자가 다시 적힌다', /투자/.test(r.sub), r.sub);
  ok('  잔액이 총자산에 들어간다', r.total === 15400000, String(r.total));
}

/* ══════ ⑤-c 환율은 달러를 쓸 때만 ══════ */
{
  await p.evaluate(() => {
    S.accounts = S.accounts.filter((a) => a.type !== 'invest');
    S.invLogs = []; save(); renderAll(); openSettings(); toggleStAdv();
  });
  await p.waitForTimeout(400);
  const off = await ev(() => [...document.querySelectorAll('#sheet button')]
    .filter((e) => e.offsetParent).map((e) => e.textContent.trim()));
  ok('달러가 없으면 설정에 환율 버튼이 없다', !off.some((t) => /환율/.test(t)), off.join(' / '));
  ok('  고정수입 바로잡기는 그대로 있다', off.some((t) => /고정수입/.test(t)));

  await p.evaluate(() => {
    closeModal();
    S.accounts.push({ id: 'us', type: 'invest', name: '해외주식', balance: 1000, cur: 'USD' });
    save(); renderAll(); openSettings(); toggleStAdv();
  });
  await p.waitForTimeout(400);
  const on = await ev(() => [...document.querySelectorAll('#sheet button')]
    .filter((e) => e.offsetParent).map((e) => e.textContent.trim()));
  ok('달러 계좌가 생기면 환율 버튼이 돌아온다', on.some((t) => /환율/.test(t)), on.join(' / '));
  await p.evaluate(() => closeModal());
}

/* ══════ ⑥ 접기가 다른 계산을 건드리지 않는다 ══════ */
{
  await seed();
  const snap = () => ev(() => ({ safe: safeSpend().usable, net: netAssets(), tot: totalAssets(),
    pick: pickRate(S.cards[0], thisYM()).got }));
  const before = await snap();
  /* 함수 이름을 틀리면 before·after 가 똑같이 undefined 가 되어 이 판정이
     아무것도 안 지키면서 통과한다 — 값이 실제로 잡혔는지 먼저 본다 */
  ok('  (비교할 숫자가 실제로 잡혔다)',
    typeof before.safe === 'number' && typeof before.tot === 'number' && before.tot > 0,
    JSON.stringify(before));
  await ev(() => { toggleFold('pick'); toggleFold('alloc'); });
  await p.waitForTimeout(400);
  const after = await snap();
  ok('접기/펴기는 숫자를 바꾸지 않는다',
    before.safe === after.safe && before.net === after.net
      && before.tot === after.tot && before.pick === after.pick,
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
}

ok('콘솔 오류 없음', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close();
