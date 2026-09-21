/* 가계부는 0원에서 시작하지 않는다 —
   ① 개시 스냅샷(남은 카드값·지난달 실적)이 결제 예정·혜택 판정에 제대로 들어가는지
   ② 진행 중인 할부를 옮길 수 있는지
   ③ 시작 마법사가 실제 화면 조작으로 끝까지 도는지
   ④ 할부는 혜택 대상에서 빠지되 실적에는 들어가는지 */
import { chromium, APP, BASE } from './lib/env.mjs';
const b = await chromium.launch();
/* 시계를 박아둔다 — 카드 결제일(20일)이 급여일(28일) 전에 오는 날이어야 개시 스냅샷이
   '쓸 수 있는 돈'에 반영되는지 볼 수 있다. '오늘'을 그대로 쓰면 21일 이후엔 결제일이
   이미 지나 이 판정이 달력에 따라 무너진다. */
const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, timezoneId: 'Asia/Seoul' });
const p = await ctx.newPage();
await p.clock.install({ time: new Date('2026-09-10T10:00:00+09:00') });
const errs = [];
p.on('pageerror', e => errs.push('PAGEERROR: ' + e.message));
p.on('console', m => { const t = m.text(); if (m.type()==='error' && !/net::ERR|Failed to load resource|supabase/i.test(t)) errs.push(t); });
await p.goto(APP, { waitUntil: 'load' });
await p.waitForTimeout(1000);
const ok = (n, v, x='') => { console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v) process.exitCode = 1; };
let r;

const seed = () => p.evaluate(() => {
  S.accounts = [{ id:'chk', type:'checking', name:'생활비 통장', balance:2000000, cur:'KRW' }];
  S.cards = [{ id:'c1', type:'credit', name:'하나 MOVING', accountId:'chk', payDay:20,
    tiers:[500000], exclCats:[], prepays:[], noInstPerk:true, open:{ym:'',pending:0,perf:0},
    perks:[{ name:'기본적립', cat:'전체', kind:'percent', value:1, tier:1 }] }];
  S.fixed = []; S.tx = []; S.goals=[]; S.debts=[]; S.invLogs=[];
  S.settings.setupAt = '';
  _discInvalidate(); save(); renderAll();
});

/* ══════ ① 개시 스냅샷 ══════ */
await seed();
r = await p.evaluate(() => {
  const c = cardById('c1');
  return { pend: creditPending(c), perf: perfSpend(c, prevYM(thisYM())), tier: activeTierOf(c, thisYM()) };
});
ok('시작 전: 미결제 0 · 실적 0 · 혜택 잠김', r.pend===0 && r.perf===0 && r.tier===0, JSON.stringify(r));

r = await p.evaluate(() => {
  const c = cardById('c1');
  c.open = { ym: thisYM(), pending: 550000, perf: 800000 };
  _discInvalidate(); save();
  return { pend: creditPending(c), perf: perfSpend(c, prevYM(thisYM())), tier: activeTierOf(c, thisYM()),
    net: netAssets(), 이번달지출: totals(thisYM()).exp, 내역수: S.tx.length };
});
ok('남은 카드값이 결제 예정에 들어감', r.pend===550000, `${r.pend}원`);
ok('지난달 실적이 혜택을 열어줌', r.perf===800000 && r.tier===1, `실적 ${r.perf} · ${r.tier}구간`);
ok('순자산에서 갚을 돈으로 빠짐', r.net===2000000-550000, `${r.net}원`);
ok('  이번 달 지출 통계는 오염되지 않음', r.이번달지출===0 && r.내역수===0,
   `지출 ${r.이번달지출} · 내역 ${r.내역수}건`);

// '쓸 수 있는 돈'에도 반영돼야 한다 (결제일이 급여 전이면)
r = await p.evaluate(() => {
  S.fixed = [{ id:'f2', name:'급여', kind:'income', amount:3200000, day:28, cat:'급여', active:true }];
  save(); const a = safeSpend().usable;
  cardById('c1').open.pending = 0; _discInvalidate(); save();
  const b = safeSpend().usable;
  cardById('c1').open.pending = 550000; _discInvalidate(); save();
  return { withOpen: a, without: b };
});
ok("'쓸 수 있는 돈'이 그만큼 줄어듦", r.without - r.withOpen === 550000,
   `${r.without.toLocaleString()} → ${r.withOpen.toLocaleString()}`);

// 결제 처리하면 개시분도 함께 사라진다
r = await p.evaluate(() => {
  window.confirm = () => true;
  settleCard('c1');
  const c = cardById('c1');
  return { pend: creditPending(c), open: c.open.pending, bal: accById('chk').balance };
});
ok('결제 처리하면 개시분도 청산됨', r.pend===0 && r.open===0, `미결제 ${r.pend} · 개시 ${r.open}`);
ok('  계좌에서 실제로 빠짐', r.bal===2000000-550000, `${r.bal}원`);

/* ══════ ② 진행 중 할부 ══════ */
await seed();
r = await p.evaluate(() => {
  // 5개월 전에 산 12개월 할부, 5회차까지 냄
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()-5);
  const date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-15`;
  S.tx.push({ id:'ins', type:'expense', date, amount:1200000, cat:'쇼핑', memo:'노트북',
    payKind:'card', payId:'c1', months:12, paidPortions:5, defended:true });
  _discInvalidate(); save();
  const c = cardById('c1'), t = S.tx[0];
  return { due: duePortions(t), pend: pendingOfTx(t), cardPend: creditPending(c), remain: installRemain(c) };
});
ok('5회차까지 낸 12개월 할부 — 이번 청구분만 잡힘', r.pend===100000, `${r.pend}원`);
ok('  남은 회차는 할부 잔여로', r.remain===600000, `${r.remain}원`);
ok('  전액(120만)이 미결제로 잡히지 않음', r.cardPend===100000, `${r.cardPend}원`);

// 화면에서 '이미 낸 회차'를 실제로 고를 수 있는가
await seed();
await p.evaluate(() => { openTxModal(); txDraft.payKind='card'; txDraft.payId='c1'; txDraft.amount=1200000; txMoreOpen=true; renderTxModal(); });
await p.waitForTimeout(250);
await p.selectOption('#tx-months', '12');
await p.waitForTimeout(250);
r = await p.evaluate(() => !!document.getElementById('tx-paid'));
ok("할부를 고르면 '이미 낸 회차' 칸이 나타남", r);
await p.selectOption('#tx-paid', '5');
await p.waitForTimeout(250);
r = await p.evaluate(() => ({ draft: txDraft.paidPortions, warn: $('sheet').innerText.includes('구입일을 실제 결제한 날로') }));
ok('  고른 값이 저장됨', r.draft===5, String(r.draft));
ok('  구입일이 오늘이면 경고가 뜸(회차가 조용히 사라지지 않게)', r.warn);
// 구입일을 과거로 바꾸면 경고가 사라지고 남은 금액이 맞는다
r = await p.evaluate(() => {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth()-5);
  txDraft.date = `${d.getFullYear()}-${pad(d.getMonth()+1)}-15`;
  renderTxModal();
  return { warn: $('sheet').innerText.includes('구입일을 실제 결제한 날로'), txt: $('sheet').innerText };
});
ok('  구입일을 실제 날짜로 고치면 경고가 사라짐', !r.warn);
ok('  남은 회차·금액을 보여줌', /남은 7회/.test(r.txt), (r.txt.match(/남은[^\n]*/)||[''])[0]);
await p.evaluate(() => { saveTx(); });
await p.waitForTimeout(250);
r = await p.evaluate(() => { const t=S.tx.find(x=>x.memo!=='')||S.tx[0]; return { paid:t.paidPortions, pend:creditPending(cardById('c1')) }; });
ok('  저장해도 회차가 보존됨', r.paid===5, String(r.paid));
ok('  결제 예정은 이번 회차분만', r.pend===100000, `${r.pend}원`);

/* ══════ ④ 할부 혜택 제외 ══════ */
await seed();
r = await p.evaluate(() => {
  const ym = thisYM(), c = cardById('c1');
  c.open = { ym, pending:0, perf:800000 };      // 혜택이 열린 상태로
  const mk = (id, months) => ({ id, type:'expense', date:todayStr(), amount:1000000, cat:'쇼핑',
    memo:'가전', payKind:'card', payId:'c1', months, paidPortions:0 });
  S.tx = [mk('a',1)]; _discInvalidate(); save();
  const 일시불 = perkEstimates(c, ym).reduce((s,e)=>s+e.est,0);
  const 실적일시불 = perfSpend(c, ym);
  S.tx = [mk('b',6)]; _discInvalidate(); save();
  const 할부 = perkEstimates(c, ym).reduce((s,e)=>s+e.est,0);
  const 실적할부 = perfSpend(c, ym);
  c.noInstPerk = false; _discInvalidate(); save();
  const 할부허용 = perkEstimates(c, ym).reduce((s,e)=>s+e.est,0);
  return { 일시불, 할부, 할부허용, 실적일시불, 실적할부 };
});
ok('일시불은 혜택 적립됨', r.일시불===10000, `${r.일시불}원`);
ok('할부는 혜택 제외 (카드사 기본)', r.할부===0, `${r.할부}원`);
ok('  카드 설정을 끄면 할부에도 적립', r.할부허용===10000, `${r.할부허용}원`);
ok('  할부도 전월 실적에는 그대로 포함', r.실적할부===r.실적일시불 && r.실적할부===1000000, `${r.실적할부}원`);

r = await p.evaluate(() => {
  const c = cardById('c1'); c.noInstPerk = true; save(); openCardModal('c1');
  return { has: !!document.getElementById('cd-noinst'), on: document.getElementById('cd-noinst')?.checked };
});
ok('카드 관리에 할부 제외 설정이 있음', r.has && r.on===true);
await p.evaluate(() => closeModal());

/* ══════ ③ 시작 마법사 (실제 클릭) ══════ */
await seed();
r = await p.evaluate(() => { renderHome(); return $('setup-banner').innerText; });
ok('처음이면 홈에 안내 배너', /옮겨올까요/.test(r), r.split('\n')[0]);

await p.evaluate(() => openWizard());
await p.waitForTimeout(300);
r = await p.evaluate(() => ({ dots: document.querySelectorAll('.wz-dot').length, acc: !!document.getElementById('wz-acc-chk') }));
ok('마법사 4단계 · 1단계는 통장', r.dots===4 && r.acc);

await p.fill('#wz-acc-chk', '1160300');
await p.evaluate(() => wizGo(1));
await p.waitForTimeout(250);
r = await p.evaluate(() => ({ pend: !!document.getElementById('wz-pend-c1'), perf: !!document.getElementById('wz-perf-c1') }));
ok('2단계: 카드별 남은 카드값·지난달 실적', r.pend && r.perf);
await p.fill('#wz-pend-c1', '550000');
await p.fill('#wz-perf-c1', '800000');

await p.evaluate(() => wizGo(2));
await p.waitForTimeout(250);
await p.evaluate(() => wizAddInst());
await p.waitForTimeout(250);
await p.fill('#wz-i0-memo', '노트북');
await p.fill('#wz-i0-amt', '1200000');
await p.selectOption('#wz-i0-m', '12');
await p.waitForTimeout(200);
await p.selectOption('#wz-i0-paid', '5');
await p.waitForTimeout(250);
r = await p.evaluate(() => $('sheet').innerText);
ok('3단계: 할부를 넣으면 남은 회차를 보여줌', /남은 7회/.test(r), (r.match(/남은[^\n]*/)||[''])[0]);

await p.evaluate(() => wizGo(3));
await p.waitForTimeout(250);
r = await p.evaluate(() => $('sheet').innerText);
ok('4단계: 확인 요약', /남은 카드값/.test(r) && /진행 중 할부 잔여/.test(r));
ok('  거래로 만들지 않는다는 점을 밝힘', /거래 내역으로 만들지 않습니다/.test(r));

await p.evaluate(() => wizApply());
await p.waitForTimeout(400);
r = await p.evaluate(() => {
  const c = cardById('c1'), t = S.tx.find(x=>x.memo==='노트북');
  return { bal: accById('chk').balance, open: c.open.pending, perf: perfSpend(c, prevYM(thisYM())),
    tier: activeTierOf(c, thisYM()), inst: t ? { months:t.months, paid:t.paidPortions, pend:pendingOfTx(t) } : null,
    cardPend: creditPending(c), done: !!S.settings.setupAt, banner: (renderHome(), $('setup-banner').innerText) };
});
ok('통장 잔액이 반영됨', r.bal===1160300, `${r.bal}원`);
ok('남은 카드값이 개시 스냅샷으로 들어감', r.open===550000, `${r.open}원`);
ok('지난달 실적이 들어가 혜택이 열림', r.perf===800000 && r.tier===1, `실적 ${r.perf} · ${r.tier}구간`);
ok('할부가 거래로 들어감 (12개월 중 5회차 납부)',
   r.inst && r.inst.months===12 && r.inst.paid===5, JSON.stringify(r.inst));
ok('  결제 예정 = 개시분 + 이번 할부 회차', r.cardPend===550000+100000, `${r.cardPend}원`);
ok('마치면 배너가 사라짐', r.done && !r.banner.trim(), r.banner.slice(0,20));

// 개시분을 선결제로도 갚을 수 있어야 한다
r = await p.evaluate(() => {
  openPrepayModal('c1');
  const txt = $('sheet').innerText;
  ppToggleAll();
  const all = $('sheet').innerText;
  return { hasOpen: /이전 이용분/.test(txt), sel: /2건/.test(all) };
});
ok('선결제 목록에 개시분이 한 줄로 나옴', r.hasOpen);
ok('  전체 선택에 함께 잡힘', r.sel);
r = await p.evaluate(() => {
  doPrepaySelected();
  const c = cardById('c1');
  return { pend: creditPending(c), open: c.open.pending, bal: accById('chk').balance };
});
ok('  선결제하면 개시분도 갚아짐', r.pend===0 && r.open===0, `미결제 ${r.pend} · 개시 ${r.open}`);
ok('  계좌에서 65만원 빠짐', r.bal===1160300-650000, `${r.bal}원`);
await p.evaluate(() => closeModal());

// 이미 쓰던 사람에게는 마법사를 띄우지 않는다
r = await p.evaluate(() => {
  S.settings.setupAt = undefined;
  S.tx = Array.from({length:30},(_,i)=>({id:'x'+i,type:'expense',date:todayStr(),amount:1000,cat:'식비',memo:'',payKind:'cash'}));
  migrate(); return S.settings.setupAt;
});
ok('내역이 쌓인 기존 사용자에게는 안 띄움', r==='migrated', String(r));

ok('콘솔/페이지 오류 없음', errs.length===0, errs.slice(0,3).join(' | '));
await b.close();
