/* 환불 — 돌려받은 돈이 숫자에 제대로 반영돼야 한다.
 *
 * 지금까지 환불 개념이 아예 없었다. `-30,000` 은 '금액을 확인해주세요' 로 거절됐고,
 * 할 수 있는 건 원래 내역을 지우거나 수입으로 넣는 것뿐이었다. 수입으로 넣으면
 * 수입 통계가 오염되고 카테고리 합계·전월 실적·카드 미결제·예산이 전부 틀어진다.
 *
 * 환불은 '마이너스 지출' 로 저장한다. 따로 유형을 만들면 지출을 더하는 곳마다 손대야
 * 하고 한 군데만 빠뜨려도 숫자가 조용히 틀어지는데, 같은 계산을 그대로 타게 두면
 * 뺄 곳을 빠뜨릴 수가 없다. 대신 '학습' 하는 곳에서는 빼야 한다. */
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

/* 기능이 없던 때의 코드에서도 끝까지 돌아야 '무엇이 어떻게 달랐는지' 가 다 보인다.
   evaluate 가 던지면 빈 껍데기를 돌려주고, 판정들은 그 껍데기를 안전하게 읽는다. */
const ev = async (fn, arg) => {
  try { const v = await p.evaluate(fn, arg); return v && typeof v === 'object' ? v : { v }; }
  catch (e) { return { _err: String(e.message || e).split('\n')[0] }; }
};
const g = (o, path, dflt) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o) ?? dflt;

const seed = () => p.evaluate(() => {
  S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 2000000, cur: 'KRW' }];
  S.cards = [
    { id: 'c1', type: 'credit', name: '신용', accountId: 'chk', payDay: 14, tiers: [500000], exclCats: [],
      perks: [{ id: 'p', name: '기본적립', cat: '전체', kind: 'percent', value: 1, tier: 0 }],
      prepays: [], open: { ym: '', pending: 0, perf: 0 } },
    { id: 'c2', type: 'check', name: '체크', accountId: 'chk', tiers: [], exclCats: [], perks: [], prepays: [] }];
  S.tx = []; S.fixed = []; S.budgets = {}; S.autoLog = {}; S.quick = []; S.quickHide = [];
  S.settings.setupAt = todayStr(); S.cats = null;
  _discInvalidate(); save(); renderAll();
});

/* ══════ ① 전액 환불이면 모든 숫자가 원점으로 ══════ */
{
  await seed();
  const r = await ev(() => {
    const ym = thisYM();
    S.tx = [{ id: 'o1', type: 'expense', date: todayStr(), amount: 300000, cat: '쇼핑',
      memo: '노트북', payKind: 'card', payId: 'c1', months: 1, paidPortions: 0 }];
    _discInvalidate(); save();
    const c = cardById('c1');
    const paid = { exp: totals(ym).exp, perf: perfSpend(c, ym), pend: creditPending(c),
      cat: (catSums(ym).find((x) => x[0] === '쇼핑') || [, 0])[1], net: netAssets() };
    refundOf('o1');
    const pre = { amt: (document.getElementById('tx-amt') || {}).value, cat: txDraft.cat,
      pay: txDraft.payKind + '|' + txDraft.payId, refund: !!txDraft.refund,
      title: (document.querySelector('#sheet h3') || {}).textContent || '' };
    saveTx();
    const back = { exp: totals(ym).exp, perf: perfSpend(c, ym), pend: creditPending(c),
      cat: (catSums(ym).find((x) => x[0] === '쇼핑') || [, 0])[1], net: netAssets(),
      n: S.tx.length, amt: S.tx[1].amount, type: S.tx[1].type };
    return { paid, pre, back };
  });
  ok('원래 내역에서 바로 환불창이 열린다', /환불/.test(g(r, 'pre.title', '')), g(r, 'pre.title', '') || r._err);
  ok('  금액·카테고리·결제수단을 물려받는다',
    g(r, 'pre.amt') === '300000' && g(r, 'pre.cat') === '쇼핑' && g(r, 'pre.pay') === 'card|c1',
    JSON.stringify(r.pre || r._err));
  ok('마이너스 지출로 저장된다', g(r, 'back.amt') === -300000 && g(r, 'back.type') === 'expense',
    `${g(r, 'back.type', '-')} ${g(r, 'back.amt', '-')}`);
  ok('  이번 달 지출이 0 으로', g(r, 'back.exp') === 0, `${g(r, 'paid.exp', '-')} → ${g(r, 'back.exp', '-')}`);
  ok('  전월 실적도 0 으로', g(r, 'back.perf') === 0, `${g(r, 'paid.perf', '-')} → ${g(r, 'back.perf', '-')}`);
  ok('  카드 결제 예정도 0 으로', g(r, 'back.pend') === 0, `${g(r, 'paid.pend', '-')} → ${g(r, 'back.pend', '-')}`);
  ok('  카테고리 합계도 0 으로', g(r, 'back.cat') === 0, `${g(r, 'paid.cat', '-')} → ${g(r, 'back.cat', '-')}`);
  ok('  순자산이 원래대로', g(r, 'back.net') === 2000000, String(g(r, 'back.net', '-')));
}

/* ══════ ② 부분 환불은 차액만 남긴다 ══════ */
{
  await seed();
  const r = await ev(() => {
    const ym = thisYM();
    S.tx = [{ id: 'o1', type: 'expense', date: todayStr(), amount: 100000, cat: '쇼핑',
      memo: '옷', payKind: 'card', payId: 'c1', months: 1, paidPortions: 0 }];
    _discInvalidate(); save();
    refundOf('o1');
    document.getElementById('tx-amt').value = '30,000';     // 쉼표를 쳐도
    saveTx();
    const c = cardById('c1');
    return { exp: totals(ym).exp, perf: perfSpend(c, ym), pend: creditPending(c),
      cat: (catSums(ym).find((x) => x[0] === '쇼핑') || [, 0])[1] };
  });
  ok('부분 환불이 차액만 남긴다', r.exp === 70000 && r.cat === 70000, `지출 ${r.exp} · 카테고리 ${r.cat} ${r._err || ''}`);
  ok('  실적·결제 예정도 차액', r.perf === 70000 && r.pend === 70000, `실적 ${r.perf} · 예정 ${r.pend}`);
}

/* ══════ ③ 바로 빠져나간 돈은 바로 돌아온다 ══════ */
{
  await seed();
  const r = await ev(() => {
    const out = {};
    // 체크카드
    S.tx = []; accById('chk').balance = 2000000; _discInvalidate(); save();
    openTxModal();
    document.getElementById('tx-amt').value = '50000';
    document.getElementById('tx-pay').value = 'card|c2';
    document.getElementById('tx-memo').value = '장보기';
    saveTx();
    out.checkMid = accById('chk').balance;
    refundOf(S.tx[0].id); saveTx();
    out.checkBack = accById('chk').balance;
    // 계좌이체 결제
    S.tx = []; accById('chk').balance = 2000000; _discInvalidate(); save();
    openTxModal();
    document.getElementById('tx-amt').value = '70000';
    document.getElementById('tx-pay').value = 'account|chk';
    document.getElementById('tx-memo').value = '공과금';
    saveTx();
    out.accMid = accById('chk').balance;
    refundOf(S.tx[0].id); saveTx();
    out.accBack = accById('chk').balance;
    return out;
  });
  ok('체크카드 환불로 잔액이 돌아온다', r.checkMid === 1950000 && r.checkBack === 2000000, `${r.checkMid} → ${r.checkBack}`);
  ok('  계좌 결제도 마찬가지', r.accMid === 1930000 && r.accBack === 2000000, `${r.accMid} → ${r.accBack}`);
  if (r._err) console.log('   (' + r._err + ')');
}

/* ══════ ④ 환불하면 적립도 되돌아간다 ══════
   perkMatch 가 `t.amount < minAmt` 로 걸러서 환불이 통째로 빠지면
   '환불했는데 적립은 그대로' 가 된다. */
{
  await seed();
  const r = await ev(() => {
    const ym = thisYM();
    S.tx = [{ id: 'b1', type: 'expense', date: todayStr(), amount: 600000, cat: '쇼핑',
      memo: '가전', payKind: 'card', payId: 'c1', months: 1, paidPortions: 0 }];
    _discInvalidate(); save();
    const before = perkEstimates(cardById('c1'), ym).reduce((s, e) => s + e.est, 0);
    refundOf('b1'); saveTx();
    const after = perkEstimates(cardById('c1'), ym).reduce((s, e) => s + e.est, 0);
    // 건당 최소금액이 있는 혜택은 환불도 그 기준으로 따져야 한다
    S.cards[0].perks = [{ id: 'p2', name: '만원이상', cat: '전체', kind: 'percent', value: 1, tier: 0, minAmt: 10000 }];
    S.tx = [{ id: 'b2', type: 'expense', date: todayStr(), amount: 50000, cat: '쇼핑', memo: 'x', payKind: 'card', payId: 'c1', months: 1, paidPortions: 0 }];
    _discInvalidate(); save();
    const big = perkEstimates(cardById('c1'), ym).reduce((s, e) => s + e.est, 0);
    refundOf('b2'); saveTx();
    const bigBack = perkEstimates(cardById('c1'), ym).reduce((s, e) => s + e.est, 0);
    return { before, after, big, bigBack };
  });
  ok('환불하면 적립 예상이 되돌아간다', r.before > 0 && r.after === 0, `${r.before} → ${r.after} ${r._err || ''}`);
  ok('  최소금액 조건이 있어도', r.big > 0 && r.bigBack === 0, `${r.big} → ${r.bigBack}`);
}

/* ══════ ⑤ 할부는 막는다 ══════
   남은 회차가 어긋나므로 마이너스 한 건으로 처리하면 안 된다. */
{
  await seed();
  const r = await ev(() => {
    S.tx = [{ id: 'i1', type: 'expense', date: addDays(todayStr(), -40), amount: 1200000,
      cat: '쇼핑', memo: '노트북', payKind: 'card', payId: 'c1', months: 12, paidPortions: 0 }];
    _discInvalidate(); save(); closeModal();
    refundOf('i1');
    return { toast: document.getElementById('toast').textContent,
      opened: document.getElementById('modal').classList.contains('open'), n: S.tx.length };
  });
  ok('할부 건은 환불창을 열지 않는다', r.opened === false && r.n === 1, `${r.n}건 ${r._err || ''}`);
  ok('  왜인지 말해준다', /할부/.test(r.toast), r.toast);
}

/* ══════ ⑥ 환불은 학습 대상이 아니다 ══════ */
{
  await seed();
  const r = await ev(() => {
    const t = todayStr();
    S.tx = [];
    for (let i = 0; i < 4; i++) S.tx.push({ id: 's' + i, type: 'expense', date: addDays(t, -i - 1),
      amount: 5000, cat: '카페/간식', memo: '스타벅스', payKind: 'card', payId: 'c1' });
    S.tx.push({ id: 'rf', type: 'expense', date: t, amount: -5000, cat: '카페/간식',
      memo: '스타벅스', payKind: 'card', payId: 'c1' });
    _discInvalidate(); save();
    const mm = merchantMemory().find((x) => /스타벅스/.test(x.label));
    return { n: mm ? mm.n : 0, quick: quickList().map((q) => q.amount),
      avg: dailyAvg30() };
  });
  ok('가맹점 기억이 환불을 세지 않는다', r.n === 4, `${r.n}건 ${r._err || ''}`);
  ok('  빠른 입력에 마이너스가 안 올라온다', (r.quick || []).every((a) => a > 0), (r.quick || []).join(','));
  ok('  일평균이 음수가 되지 않는다', r.avg >= 0, String(r.avg));
}

/* ══════ ⑦ 환불이 지출보다 많아도 화면이 깨지지 않는다 ══════ */
{
  await seed();
  const r = await ev(() => {
    const t = todayStr();
    S.tx = [{ id: 'a', type: 'expense', date: t, amount: 10000, cat: '식비', memo: '점심', payKind: 'cash' },
            { id: 'b', type: 'expense', date: t, amount: -50000, cat: '쇼핑', memo: '반품', payKind: 'card', payId: 'c1' }];
    S.budgets = {}; S.budgets[thisYM()] = { total: 500000, cats: { '쇼핑': 100000 } };
    _discInvalidate(); save();
    let views = 0; const e = [];
    try { ['home', 'cal', 'assets', 'cards', 'report'].forEach((v) => { switchView(v); views++; }); } catch (x) { e.push(x.message); }
    switchView('cal'); setTxView('cat');
    const bars = [...document.querySelectorAll('.cat-bar i')].map((i) => i.style.width);
    const summary = (document.getElementById('cal-summary') || {}).innerText || '';
    switchView('home');
    const budgetBars = [...document.querySelectorAll('#budget-card i')].map((i) => i.style.width);
    return { views, e, bars, budgetBars, exp: totals(thisYM()).exp, summary };
  });
  ok('다섯 탭이 모두 뜬다', r.views === 5 && (r.e || []).length === 0, (r.e || []).join(',') || `${r.views}탭`);
  ok('  카테고리 막대가 음수·NaN 이 아니다', (r.bars || []).every((w) => !/-|NaN/.test(w)), (r.bars || []).join(' '));
  ok('  예산 막대도', (r.budgetBars || []).every((w) => !/-|NaN/.test(w)), (r.budgetBars || []).join(' ') || '없음');
  ok('  달력 요약에 −- 가 안 나온다', !/−-|--/.test(r.summary || ''), String(r.summary || '').replace(/\s+/g, ' ').trim());
  ok('  이번 달 지출이 마이너스로 집계된다', r.exp === -40000, String(r.exp));
}

/* ══════ ⑧ 목록에서 환불이 수입과 구분된다 ══════ */
{
  await seed();
  const r = await ev(() => {
    const t = todayStr();
    S.tx = [{ id: 'rf', type: 'expense', date: t, amount: -30000, cat: '쇼핑', memo: '반품', payKind: 'card', payId: 'c1' }];
    _discInvalidate(); save();
    const html = txRow(S.tx[0]);
    return { html, minus: /−-|--/.test(html), badge: /환불/.test(html), plus: /\+30,000/.test(html) };
  });
  ok('환불 표시가 붙는다', r.badge === true, r._err || '');
  ok('  `−-30,000` 처럼 안 나온다', r.minus === false);
  ok('  돌려받은 돈이라 +로 보인다', r.plus === true, (r.html || '').match(/t-amt[^>]*>([^<]*)/)?.[1] || '');
}

/* ══════ ⑨ 환불을 수정하면 부호가 유지된다 ══════ */
{
  await seed();
  const r = await ev(() => {
    S.tx = [{ id: 'rf', type: 'expense', date: todayStr(), amount: -30000, cat: '쇼핑', memo: '반품', payKind: 'card', payId: 'c1' }];
    _discInvalidate(); save();
    openTxModal('rf');
    const shown = { amt: (document.getElementById('tx-amt') || {}).value, refund: !!txDraft.refund };
    document.getElementById('tx-amt').value = '45000';
    saveTx();
    return { shown, after: S.tx[0].amount };
  });
  ok('수정 화면에는 양수로 보인다', g(r, 'shown.amt') === '30000' && g(r, 'shown.refund') === true, JSON.stringify(r.shown || r._err));
  ok('  고쳐 저장해도 마이너스로 남는다', r.after === -45000, String(r.after));
}

/* ══════ ⑩ 저장 후 알려주고 되돌릴 수 있다 ══════ */
{
  await seed();
  const r = await ev(() => {
    S.tx = [{ id: 'o', type: 'expense', date: todayStr(), amount: 40000, cat: '쇼핑', memo: '옷',
      payKind: 'account', payId: 'chk' }];
    applyBalance(S.tx[0], 1); save();
    const bal0 = accById('chk').balance;
    refundOf('o'); saveTx();
    const mid = { n: S.tx.length, bal: accById('chk').balance,
      toast: document.getElementById('toast').innerText.replace(/\s+/g, ' ').trim(),
      undo: !!document.querySelector('#toast .t-act') };
    undoLastTx();
    return { bal0, mid, back: { n: S.tx.length, bal: accById('chk').balance } };
  });
  ok('환불이라고 알려준다', /환불/.test(g(r, 'mid.toast', '')), g(r, 'mid.toast', '') || r._err);
  ok('  되돌리기가 함께 뜬다', g(r, 'mid.undo') === true);
  ok('  되돌리면 잔액까지 원래대로', g(r, 'back.n') === 1 && g(r, 'back.bal') === r.bal0,
    `${g(r, 'mid.bal', '-')} → ${g(r, 'back.bal', '-')}`);
}

/* ══════ ⑪ 네 칸 세그먼트가 좁은 화면에서 안 깨진다 ══════ */
{
  await seed();
  const r = await ev(() => {
    openTxModal();
    const seg = document.querySelector('#sheet .seg');
    const btns = [...seg.querySelectorAll('button')];
    const sr = seg.getBoundingClientRect();
    return { n: btns.length, labels: btns.map((x) => x.textContent),
      overflow: btns.some((x) => { const r2 = x.getBoundingClientRect(); return r2.right > sr.right + 1 || r2.left < sr.left - 1; }),
      wrapped: btns.some((x) => x.getBoundingClientRect().height > 44) };
  });
  ok('네 칸이 모두 있다', r.n === 4, (r.labels || []).join('|') || r._err);
  ok('  넘치지 않는다', !r.overflow);
  ok('  글자가 두 줄로 접히지 않는다', !r.wrapped);
}

ok('콘솔/페이지 오류 없음', errs.length === 0, errs.slice(0, 3).join(' | ') || '없음');
await b.close();
