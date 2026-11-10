/* 전체 검토에서 찾은 것들 — 앱 쪽.
 *
 * 코드를 처음부터 끝까지 읽으며 찾은 문제 중, 동기화 엔진(sync)·밀린 달(catchup)·
 * 카드값 뒤 잔액(aftercard) 묶음에 들어가지 않는 것들을 여기 모았다.
 *   ① 두 기기가 같은 자동 기록을 각자 넣었을 때 — 합친 뒤 하나로
 *   ② 자동 기록은 클라우드를 받아온 뒤에 돈다
 *   ③ 사용자가 지은 이름이 화면에 '코드' 로 들어가지 않는다
 *   ④ 달력의 수입 점 · 투자 납입 삭제 · 지워진 내역 수정 · 말일 시작일 */
import { chromium, BASE, makeOk } from './lib/env.mjs';

const ok = makeOk();
const b = await chromium.launch();

async function at(iso, init) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
  await ctx.route('**/*', (r) => (r.request().url().includes('127.0.0.1') ? r.continue() : r.abort()));
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  p.on('dialog', (d) => d.accept());
  if (init) await p.addInitScript(init);
  await p.clock.install({ time: new Date(iso) });
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForTimeout(700);
  return { ctx, p, errs };
}
const ev = async (p, fn, arg) => { try { return await p.evaluate(fn, arg); } catch (e) { return { _err: String(e.message || e).split('\n')[0] }; } };

/* ══════ ① 두 기기가 이번 달 월세를 각자 넣었다 ══════
   합치면 월세가 두 건이 되고 잔액도 두 번 깎인다(잔액은 양쪽 변화를 더하므로).
   이번 병합으로 생긴 중복만 골라 하나로 줄이고 잔액을 되돌린다. */
{
  const { ctx, p, errs } = await at('2026-11-26T10:00:00+09:00');
  const r = await ev(p, () => {
    const acc = (bal) => [{ id: 'chk', type: 'checking', name: '주거래', balance: bal, cur: 'KRW' }];
    const fixed = [{ id: 'rent', kind: 'expense', name: '월세', amount: 550000, day: 25, cat: '주거',
      payKind: 'account', payId: 'chk', active: true, from: '', to: '', since: '2026-11-01' }];
    const rent = (id) => ({ id, type: 'expense', date: '2026-11-25', amount: 550000, cat: '주거', memo: '월세',
      payKind: 'account', payId: 'chk', fixedId: 'rent', months: 1, paidPortions: 0 });
    const lunch = { id: 'l1', type: 'expense', date: '2026-11-26', amount: 9000, cat: '식비', memo: '점심', payKind: 'account', payId: 'chk' };
    const base = { accounts: acc(3000000), cards: [], tx: [], fixed, autoLog: {}, settings: { setupAt: '2026-09-01' } };
    // 이 기기: 월세 자동 기록 + 점심 한 건
    const mine = { ...base, accounts: acc(3000000 - 550000 - 9000), tx: [rent('mine-rent'), lunch], autoLog: { 'fx|rent|2026-11': 1 } };
    // 다른 기기: 월세 자동 기록만
    const theirs = { ...base, accounts: acc(3000000 - 550000), tx: [rent('their-rent')], autoLog: { 'fx|rent|2026-11': 1 } };
    // 동기화가 합친 결과 — 거래는 합집합, 잔액은 변화량의 합
    const merged = { ...base, accounts: acc(3000000 - 550000 - 9000 - 550000),
      tx: [rent('mine-rent'), lunch, rent('their-rent')], autoLog: { 'fx|rent|2026-11': 1 } };
    localStorage.setItem('claudeflow_v1', JSON.stringify(merged));
    reloadStateFromStorage({ base, mine, theirs });
    return { rents: S.tx.filter((t) => t.fixedId === 'rent').map((t) => t.id), n: S.tx.length,
      bal: accById('chk').balance, lunch: S.tx.some((t) => t.id === 'l1') };
  });
  ok('합친 뒤 월세가 한 건만 남는다', (r.rents || []).length === 1, (r.rents || []).join(',') || r._err);
  ok('  남는 건 다른 기기 것 (이미 모든 기기에 퍼져 있다)', (r.rents || [])[0] === 'their-rent', (r.rents || []).join(','));
  ok('  잔액도 한 번만 깎인 값으로', r.bal === 3000000 - 550000 - 9000, String(r.bal));
  ok('  이 기기에서만 적은 다른 내역은 그대로', r.lunch === true && r.n === 2, `거래 ${r.n}건`);

  // 상대가 '넣었다가 지운' 달이면 이 기기 것도 되살리지 않는다
  const r2 = await ev(p, () => {
    const acc = (bal) => [{ id: 'chk', type: 'checking', name: '주거래', balance: bal, cur: 'KRW' }];
    const fixed = [{ id: 'rent', kind: 'expense', name: '월세', amount: 550000, day: 25, cat: '주거',
      payKind: 'account', payId: 'chk', active: true, from: '', to: '', since: '2026-11-01' }];
    const rent = { id: 'mine-rent', type: 'expense', date: '2026-11-25', amount: 550000, cat: '주거', memo: '월세',
      payKind: 'account', payId: 'chk', fixedId: 'rent', months: 1, paidPortions: 0 };
    const base = { accounts: acc(3000000), cards: [], tx: [], fixed, autoLog: {}, settings: { setupAt: '2026-09-01' } };
    const mine = { ...base, accounts: acc(2450000), tx: [rent], autoLog: { 'fx|rent|2026-11': 1 } };
    const theirs = { ...base, autoLog: { 'fx|rent|2026-11': 1 } };       // 넣었다 지움 — 표시만 남았다
    const merged = { ...base, accounts: acc(2450000), tx: [rent], autoLog: { 'fx|rent|2026-11': 1 } };
    localStorage.setItem('claudeflow_v1', JSON.stringify(merged));
    reloadStateFromStorage({ base, mine, theirs });
    return { n: S.tx.filter((t) => t.fixedId === 'rent').length, bal: accById('chk').balance };
  });
  ok('다른 기기에서 지운 자동 기록은 이 기기가 되살리지 않는다', r2.n === 0 && r2.bal === 3000000, `${r2.n}건 · ${r2.bal}`);

  // 병합 맥락 없이(그냥 받아온 경우) 는 아무것도 지우지 않는다
  const r3 = await ev(p, () => {
    const n0 = S.tx.length;
    S.tx.push({ id: 'k1', type: 'expense', date: '2026-10-25', amount: 1, cat: '주거', memo: 'a', payKind: 'cash', fixedId: 'zz' },
      { id: 'k2', type: 'expense', date: '2026-10-25', amount: 1, cat: '주거', memo: 'b', payKind: 'cash', fixedId: 'zz' });
    save(); reloadStateFromStorage();
    return S.tx.length - n0;
  });
  ok('  병합이 아닐 때는 손대지 않는다 (예전 기록을 추측으로 지우지 않는다)', r3 === 2, String(r3));
  ok('  오류 없음', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ══════ ② 자동 기록은 클라우드를 받아온 뒤에 돈다 ══════
   한동안 안 연 기기는 데이터가 옛것이다. 그 상태로 먼저 돌리면 다른 기기가 이미 넣은
   월세를 또 넣는다. 로그인해 둔 기기는 받아오기를 기다렸다가 돌린다. */
{
  const { ctx, p } = await at('2026-11-26T10:00:00+09:00');
  const r = await ev(p, () => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' }];
    S.cards = []; S.tx = []; S.autoLog = {};
    S.fixed = [{ id: 'rent', kind: 'expense', name: '월세', amount: 550000, day: 25, cat: '주거',
      payKind: 'account', payId: 'chk', active: true, from: '', to: '', since: '2026-09-01' }];
    S.settings.setupAt = '2026-11-01';
    _discInvalidate(); store.save(S);
    bootAutoPending = true;                       // 시작할 때 미뤄둔 상태
    reloadStateFromStorage();                     // 받아오기가 화면을 다시 그렸다
    const before = S.tx.filter((t) => t.fixedId).length;
    flushBootAuto();                              // 받아오기가 끝났다
    const after = S.tx.filter((t) => t.fixedId).length;
    flushBootAuto(); flushBootAuto();             // 상태 알림이 여러 번 와도
    return { before, after, again: S.tx.filter((t) => t.fixedId).length, pending: bootAutoPending };
  });
  ok('받아오기 전에는 자동 기록을 돌리지 않는다', r.before === 0, String(r.before ?? r._err));
  ok('  받아오기가 끝나면 돌린다', r.after === 1, String(r.after));
  ok('  한 번만 돈다', r.again === 1 && r.pending === false, `${r.again}건`);
  await ctx.close();

  // 로그인 흔적이 있는 기기로 실제로 켜도 — 서버에 못 닿아도 — 결국은 돈다
  const seeded = JSON.stringify({
    accounts: [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' }], cards: [], tx: [],
    fixed: [{ id: 'rent', kind: 'expense', name: '월세', amount: 550000, day: 25, cat: '주거',
      payKind: 'account', payId: 'chk', active: true, from: '', to: '', since: '2026-09-01' }],
    invLogs: [], reports: {}, settings: { gemini: '', name: '', setupAt: '2026-11-01' } });
  const c = await at('2026-11-26T10:00:00+09:00',
    `try{ if(!localStorage.getItem('claudeflow_v1')){ localStorage.setItem('claudeflow_v1', ${JSON.stringify(seeded)});
       localStorage.setItem('claudeflow_auth', 'x'); } }catch(e){}`);
  await c.p.clock.runFor(7000);
  await c.p.waitForTimeout(300);
  const n = await ev(c.p, () => S.tx.filter((t) => t.fixedId === 'rent').length);
  ok('로그인해 둔 기기에서도 자동 기록이 빠지지 않는다', n === 1, String(n?._err || n));
  await c.ctx.close();
}

/* ══════ ③ 사용자가 지은 이름은 글자로만 보인다 ══════
   카드·계좌 이름과 카테고리는 사용자가 직접 짓는다(그리고 동기화·가져오기로도 들어온다).
   화면에 그대로 박으면 `A&B <특가>` 같은 이름이 깨져 보이고, 태그면 실행까지 된다. */
{
  const { ctx, p, errs } = await at('2026-11-26T10:00:00+09:00');
  const r = await ev(p, () => {
    const evil = '<img src=x onerror="window.__pwn=1">카드';
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' }];
    S.cards = [{ id: 'c1', type: 'credit', name: evil, accountId: 'chk', payDay: 14, tiers: [], perks: [], exclCats: [] }];
    S.cats = { exp: [['<b>', '식비'], ['🍜', '<i>면</i>']], inc: null };
    S.tx = [{ id: 't1', type: 'expense', date: todayStr(), amount: 9000, cat: '<i>면</i>', memo: '라멘', payKind: 'card', payId: 'c1' }];
    S.quick = [{ memo: '<u>빠른</u>', cat: '식비', amount: 5000, payKind: 'cash', payId: '' }];
    S.settings.setupAt = todayStr();
    _discInvalidate(); save(); renderAll();
    const home = document.getElementById('view-home');
    const row = document.querySelector('#recent-tx .tx .t-sub');
    switchView('cal');
    const cal = document.getElementById('view-cal');
    return { sub: row ? row.textContent : '', imgs: home.querySelectorAll('img').length + cal.querySelectorAll('img').length,
      ital: home.querySelectorAll('#recent-tx i').length + cal.querySelectorAll('#lst-body i').length,
      emo: (CAT_EMO['식비'] || ''), pwn: window.__pwn || 0 };
  });
  ok('카드 이름이 태그가 아니라 글자로 보인다', /<img/.test(r.sub || '') && r.imgs === 0, `${r.sub || r._err} · img ${r.imgs}개`);
  ok('  카테고리 이름도', r.ital === 0, `i ${r.ital}개`);
  ok('  이모지 칸에 넣은 태그 글자는 걸러진다', !/[<>]/.test(r.emo || ''), JSON.stringify(r.emo));
  ok('  아무것도 실행되지 않았다', r.pwn === 0, String(r.pwn));
  ok('  오류 없음', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ══════ ④ 작은 것들 ══════ */
{
  const { ctx, p, errs } = await at('2026-11-26T10:00:00+09:00');
  // 달력의 초록 점은 수입이 있던 날에만
  const r = await ev(p, () => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' },
      { id: 'sav', type: 'saving', name: '적금', balance: 0, cur: 'KRW' },
      { id: 'inv', type: 'invest', name: '증권', balance: 0, cur: 'KRW' }];
    S.cards = []; S.fixed = []; S.invLogs = [];
    S.tx = [
      { id: 'tr', type: 'transfer', date: '2026-11-10', amount: 300000, fromId: 'chk', toId: 'sav', memo: '적금' },
      { id: 'in', type: 'income', date: '2026-11-12', amount: 100000, cat: '용돈', memo: '용돈', payKind: 'account', payId: 'chk' }];
    S.settings.setupAt = '2026-11-01';
    _discInvalidate(); save(); switchView('cal');
    const cells = [...document.querySelectorAll('#cal-grid .hm-cell:not(.other)')];
    const dot = (d) => !!cells[d - 1].querySelector('.dot');
    return { transferDay: dot(10), incomeDay: dot(12) };
  });
  ok('이체한 날에는 수입 점이 찍히지 않는다', r.transferDay === false, String(r.transferDay ?? r._err));
  ok('  수입이 있던 날에는 찍힌다', r.incomeDay === true, String(r.incomeDay));

  // 투자 납입 이체를 지우면 납입 원금 기록도 함께 사라진다
  const r2 = await ev(p, () => {
    S.tx.push({ id: 'iv', type: 'transfer', date: '2026-11-15', amount: 500000, fromId: 'chk', toId: 'inv', memo: '증권 납입', invLogId: 'L1', fxAt: 1 });
    S.invLogs.push({ id: 'L1', accountId: 'inv', date: '2026-11-15', amount: 500000, cur: 'KRW', fxAt: 1, txId: 'iv' });
    applyBalance(S.tx[S.tx.length - 1], 1); save();
    const put0 = invPerf(accById('inv')).put;
    delTx('iv');
    return { put0, put1: invPerf(accById('inv')).put, logs: S.invLogs.length, chk: accById('chk').balance, inv: accById('inv').balance };
  });
  ok('투자 납입을 지우면 납입 원금도 같이 빠진다', r2.put0 === 500000 && r2.put1 === 0 && r2.logs === 0,
    `${r2.put0} → ${r2.put1} (기록 ${r2.logs}건) ${r2._err || ''}`);
  ok('  잔액도 양쪽 다 돌아온다', r2.chk === 3000000 && r2.inv === 0, `${r2.chk} · ${r2.inv}`);

  // 고치는 사이 다른 기기에서 지워진 내역 — 멈추지 않고 알려준다
  const r3 = await ev(p, () => {
    openTxModal('in');
    S.tx = S.tx.filter((t) => t.id !== 'in');           // 동기화로 사라졌다
    let threw = '';
    try { saveTx(); } catch (e) { threw = String(e.message || e); }
    return { threw, toast: document.getElementById('toast').textContent, open: document.getElementById('modal').classList.contains('open') };
  });
  ok('지워진 내역을 저장하려 해도 멈추지 않는다', r3.threw === '' && /지워진/.test(r3.toast || ''), r3.threw || r3.toast || r3._err);
  ok('  창은 닫힌다', r3.open === false);

  // 동기화가 덮기 전에 남긴 백업을 꺼낼 수 있다
  const r4 = await ev(p, () => {
    openSettings(); toggleStAdv();
    const has = () => [...document.querySelectorAll('#sheet button')].some((x) => /동기화 직전/.test(x.textContent));
    const none = has();
    localStorage.setItem('claudeflow_conflict_backup', JSON.stringify({ at: '2026-11-20T09:30:00.000Z', rev: 3,
      data: { accounts: [], tx: [{ id: 'z' }, { id: 'y' }] } }));
    openSettings(); toggleStAdv();
    const info = document.getElementById('sheet').innerText;
    return { none, shown: has(), cnt: /내역 2건/.test(info) };
  });
  ok('백업이 없으면 버튼도 없다', r4.none === false, String(r4.none ?? r4._err));
  ok('  백업이 있으면 내려받을 수 있다', r4.shown === true && r4.cnt === true, `버튼 ${r4.shown} · 건수 ${r4.cnt}`);
  ok('  오류 없음', errs.length === 0, errs.join(' | '));
  await ctx.close();
}

/* ══════ ④-b 말일 결제 고정비 — 시작일이 없는 날짜로 박히지 않는다 ══════
   1월 31일에 '매월 30일' 고정비를 등록하면 시작일이 `2월 30일` 로 저장됐다. 그러면
   2월 28일 결제가 '시작 전' 으로 판정돼 2월이 통째로 빠졌다. */
{
  const { ctx, p } = await at('2027-01-31T10:00:00+09:00');
  const from = await ev(p, () => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' }];
    S.cards = []; S.fixed = []; S.tx = []; S.autoLog = {}; S.settings.setupAt = '2027-01-01';
    _discInvalidate(); save();
    openFixedModal(null, 'expense');
    $('fx-name').value = '관리비'; $('fx-amt').value = '100000'; $('fx-day').value = '30';
    saveFixed('');
    return S.fixed[0].from;
  });
  ok('시작일이 실제로 있는 날짜다 (2월 28일)', from === '2027-02-28', String(from?._err || from));
  const blob = await p.evaluate(() => localStorage.getItem('claudeflow_v1'));
  await ctx.close();
  const c = await at('2027-03-02T10:00:00+09:00');
  const dates = await ev(c.p, (d) => {
    localStorage.setItem('claudeflow_v1', d); reloadStateFromStorage();
    return S.tx.filter((t) => t.fixedId).map((t) => t.date).sort();
  }, blob);
  ok('  2월 치가 빠지지 않는다', Array.isArray(dates) && dates.includes('2027-02-28'), (dates || []).join?.(',') || String(dates?._err));
  await c.ctx.close();
}

await b.close();
