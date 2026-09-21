/* 매일 하는 일이 짧아야 한다 — 기록 흐름과 '모르면 모른다고 말하기'.
 *
 * 외부 검토에서 나온 지적 넷을 고정한다.
 *   ① 기록 화면이 자동화보다 먼저 32칸 격자를 들이민다 (메모칸이 화면 밖 943px 에 있었다)
 *   ② 빈 앱은 시작 마법사를 볼 수 없고, 들어가도 "자산 탭에서 먼저" 라며 돌려보낸다
 *   ③ 데이터가 0건인데 Health Score 56점 '양호해요' 가 뜬다
 *   ④ 저장하면 '저장했어요' 뿐 — 무엇이 달라졌는지 알 수 없고 되돌릴 수도 없다 */
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

/* 예전 코드에는 없던 함수를 부르면 evaluate 가 통째로 던져 뒤의 판정이 다 죽는다.
   고치기 전 코드에서 '무엇이 어떻게 달랐는지'까지 보려면 여기서 받아내야 한다. */
const ev = async (fn, arg) => { try { return await p.evaluate(fn, arg); } catch (e) { return { _err: String(e.message || e).split('\n')[0] }; } };

const seed = (txN = 0) => p.evaluate((n) => {
  const t = todayStr();
  S.accounts = [{ id: 'chk', type: 'checking', name: '하나 주거래', balance: 1800000, cur: 'KRW' }];
  S.cards = [{ id: 'c1', type: 'credit', name: '하나 MOVING', accountId: 'chk', payDay: 14,
    tiers: [500000], exclCats: [], perks: [], prepays: [], open: { ym: '', pending: 0, perf: 0 } }];
  S.tx = []; S.fixed = []; S.budgets = {}; S.quick = []; S.quickHide = []; S.scores = {};
  for (let i = 0; i < n; i++) S.tx.push({ id: 'g' + i, type: 'expense', date: addDays(t, -(i % 5)),
    amount: 8000 + i * 100, cat: '식비', memo: '김밥천국', payKind: 'card', payId: 'c1' });
  S.settings.setupAt = todayStr();     // 마법사 배너는 이 묶음에서 따로 본다
  _discInvalidate(); save(); renderAll();
}, txN);

/* ══════ ① 기록 화면 — 금액과 가맹점이 먼저 온다 ══════ */
{
  await seed(0);
  await p.evaluate(() => openTxModal());
  await p.waitForTimeout(250);
  const r = await p.evaluate(() => {
    const sh = document.getElementById('sheet'), sr = sh.getBoundingClientRect();
    const top = (id) => { const e = document.getElementById(id); return e ? Math.round(e.getBoundingClientRect().top - sr.top) : -1; };
    return { h: Math.round(sh.scrollHeight), vh: window.innerHeight,
      amt: top('tx-amt'), memo: top('tx-memo'),
      cells: document.querySelectorAll('#sheet .cat-cell').length,
      focus: (document.activeElement || {}).id || '',
      foot: !!document.querySelector('#sheet .sheet-foot'),
      chip: !!document.getElementById('tx-cat-chip'),
      dateShown: !!document.getElementById('tx-date') };
  });
  ok('입력창이 한 화면에 들어온다', r.h <= r.vh, `${r.h}px / 화면 ${r.vh}px`);
  ok('  금액칸이 가장 먼저', r.amt > 0 && r.amt < 300, `${r.amt}px`);
  ok('  가맹점칸이 자동 추론보다 앞', r.memo > r.amt && r.memo < 400, `${r.memo}px`);
  ok('  32칸 격자는 접혀 있음', r.cells === 0, `${r.cells}칸`);
  ok('  고른 카테고리는 칩으로 보임', r.chip);
  ok('  금액칸에 커서가 잡힌다', r.focus === 'tx-amt', r.focus || '없음');
  ok('  저장 버튼이 아래에 붙어 있다', r.foot);
  ok('  날짜는 상세 설정 안으로', !r.dateShown);
}

/* ══════ ①-b 가맹점을 치면 카테고리·결제수단이 채워지고, 칩이 그걸 보여준다 ══════ */
{
  await p.evaluate(() => {
    closeModal();
    const t = todayStr();
    for (let i = 0; i < 5; i++) S.tx.push({ id: 'sb' + i, type: 'expense', date: addDays(t, -i - 1),
      amount: 5600, cat: '카페/간식', memo: '스타벅스', payKind: 'card', payId: 'c1' });
    S.accounts.push({ id: 'chk2', type: 'checking', name: '국민 생활비', balance: 300000, cur: 'KRW' });
    for (let i = 0; i < 5; i++) S.tx.push({ id: 'cu' + i, type: 'expense', date: addDays(t, -i - 1),
      amount: 2400, cat: '편의점', memo: 'CU', payKind: 'account', payId: 'chk2' });
    _discInvalidate(); save(); openTxModal();
  });
  await p.waitForTimeout(250);
  try { await p.fill('#tx-memo', 'CU', { timeout: 2000 }); } catch (e) {}
  await p.evaluate(() => onMemoInput());
  await p.waitForTimeout(150);
  const r = await p.evaluate(() => ({
    cat: txDraft.cat, pay: txDraft.payKind + '|' + txDraft.payId,
    chip: (document.getElementById('tx-cat-chip') || {}).textContent || '',
    cells: document.querySelectorAll('#sheet .cat-cell').length }));
  ok('가맹점만 쳐도 카테고리가 맞춰진다', r.cat === '편의점', r.cat);
  ok('  결제수단도', r.pay === 'account|chk2', r.pay);
  ok('  접힌 칩이 바뀐 값을 보여준다', r.chip.includes('편의점'), r.chip.trim());
  ok('  그래도 격자는 펼쳐지지 않는다', r.cells === 0, `${r.cells}칸`);
  await p.evaluate(() => closeModal());
}

/* ══════ ①-c 격자는 한 번 눌러 열고, 고르면 다시 접힌다 ══════ */
{
  await p.evaluate(() => openTxModal());
  await p.waitForTimeout(200);
  // 칩이 없으면(예전 배치) 여기서 멈추지 않고 '못 눌렀다'로 기록하고 계속 간다 —
  // 한 판정이 죽어서 뒤의 판정들이 통째로 안 돌면 무엇이 깨졌는지 알 수 없다
  try { await p.click('.pick-chip', { timeout: 2000 }); } catch (e) {}
  await p.waitForTimeout(180);
  const open = await p.evaluate(() => ({
    cells: document.querySelectorAll('#sheet .cat-cell').length,
    quick: document.querySelectorAll('#sheet .cat-recent .btn').length }));
  ok('칩을 누르면 전체 목록이 열린다', open.cells === 32, `${open.cells}칸`);
  ok('  자주 쓰는 것 6개가 먼저', open.quick === 6, `${open.quick}개`);
  try { await p.locator('.cat-cell', { hasText: '교통' }).first().click({ timeout: 2000 }); } catch (e) {}
  await p.waitForTimeout(180);
  const after = await p.evaluate(() => ({ cat: txDraft.cat,
    cells: document.querySelectorAll('#sheet .cat-cell').length,
    chip: (document.getElementById('tx-cat-chip') || {}).textContent || '' }));
  ok('  고르면 다시 접힌다', after.cells === 0 && after.cat === '교통', `${after.cat} · ${after.cells}칸`);
  ok('  칩에 반영됨', after.chip.includes('교통'), after.chip.trim());
  await p.evaluate(() => closeModal());
}

/* ══════ ①-d 접어둔 값은 숨기지 않고 접힌 줄에 적는다 ══════ */
{
  await p.evaluate(() => { openTxModal(); txDraft.date = addDays(todayStr(), -3); txDraft.months = 3;
    txDraft.defended = true; renderTxModal(); });
  await p.waitForTimeout(200);
  const sum = await p.evaluate(() => (document.querySelector('#sheet .more-toggle .mv') || {}).textContent || '');
  ok('기본값이 아닌 설정은 접힌 줄에 보인다', /3개월 할부/.test(sum) && /계획된 지출/.test(sum), sum.trim());
  await p.evaluate(() => closeModal());
}

/* ══════ ② 빈 앱에서도 시작 안내가 보이고, 마법사 안에서 통장을 만든다 ══════ */
{
  const r = await p.evaluate(() => {
    S.accounts = []; S.cards = []; S.tx = []; S.settings.setupAt = '';
    _discInvalidate(); save(); renderAll();
    const el = document.getElementById('setup-banner');
    return { shown: el.innerHTML.trim().length > 0, text: el.innerText.trim(), nag: el.dataset.nag };
  });
  ok('아무것도 없는 앱에서 시작 안내가 뜬다', r.shown, r.text.split('\n')[0] || '안 뜸');
  ok("  '할 일' 개수로는 세지 않는다", r.nag === '1', r.nag || '-');

  await p.evaluate(() => openWizard());
  await p.waitForTimeout(250);
  const dead = await p.evaluate(() => ({
    sendAway: /자산 탭에서 먼저/.test(document.getElementById('sheet').innerText),
    canMake: !!document.getElementById('wz-new-name') }));
  ok('  "자산 탭에서 먼저" 라며 돌려보내지 않는다', !dead.sendAway);
  ok('  마법사 안에서 통장을 만들 수 있다', dead.canMake);

  try {
    await p.fill('#wz-new-name', '하나 나라사랑', { timeout: 2000 });
    await p.fill('#wz-new-bal', '310,000', { timeout: 2000 });
    await p.click('button:has-text("통장 추가")', { timeout: 2000 });
  } catch (e) {}
  await p.waitForTimeout(250);
  const made = await p.evaluate(() => ({ n: S.accounts.length,
    name: (S.accounts[0] || {}).name, bal: (S.accounts[0] || {}).balance,
    field: !!document.getElementById('wz-acc-' + (S.accounts[0] || {}).id),
    safe: safeSpend().ok }));
  ok('  만들어진다 (쉼표를 쳐도)', made.n === 1 && made.bal === 310000, `${made.name} ${made.bal}`);
  ok('  바로 목록에 나타난다', made.field);
  ok("  '쓸 수 있는 돈'이 계산되기 시작한다", made.safe);
  await p.evaluate(() => closeModal());
}

/* ══════ ③ 기록이 모자라면 점수를 지어내지 않는다 ══════ */
{
  await seed(0);
  const zero = await ev(() => ({
    total: healthScore(thisYM()).total,
    ok: typeof scoreReady === 'function' ? scoreReady().ok : true,
    chip: document.getElementById('h-score-chip').innerText.replace(/\s+/g, ' ').trim(),
    ring: ((document.querySelector('#h-score-chip .score-ring text') || {}).textContent || '').trim(),
    full: document.getElementById('h-score-chip').textContent.replace(/\s+/g, ' ').trim() }));
  ok('데이터 0건이면 점수를 보여주지 않는다', !zero.ok, `내부 계산은 ${zero.total}점 · 화면 "${zero.chip}"`);
  ok('  링 안에 점수가 찍히지 않는다', !/\d/.test(zero.ring || ''), `"${zero.ring}"`);
  ok('  대신 무엇이 더 필요한지 말한다', /준비 중/.test(zero.full || '') && /0\/10/.test(zero.full || ''), zero.full);
  ok('  "양호해요" 라고 하지 않는다', !/양호|훌륭/.test(zero.full || ''), zero.full);

  await seed(9);
  const nine = await ev(() => ({ ok: typeof scoreReady === 'function' ? scoreReady().ok : true,
    full: document.getElementById('h-score-chip').textContent.replace(/\s+/g, ' ').trim() }));
  ok('9건까지도 아직 아니다', !nine.ok && /9\/10/.test(nine.full || ''), nine.full);

  await seed(12);
  await p.evaluate(() => { S.fixed = [{ id: 'f1', kind: 'income', name: '급여', amount: 2800000, day: 25,
    cat: '급여', payKind: 'account', payId: 'chk', active: true }];
    S.tx.push({ id: 'inc1', type: 'income', date: todayStr(), amount: 2800000, cat: '급여', payKind: 'account', payId: 'chk' });
    _discInvalidate(); save(); renderAll(); });
  const many = await ev(() => ({ ok: typeof scoreReady === 'function' ? scoreReady().ok : false,
    ready: healthScore(thisYM()).ready,
    chip: document.getElementById('h-score-chip').innerText.replace(/\s+/g, ' ').trim() }));
  ok('기록이 쌓이면 점수를 보여준다', many.ok, `${many.ready}개 항목 준비 · ${many.chip}`);
  // 좁은 화면에서는 칩의 설명이 접히고 링만 남는다(원래 설계) — 그때는 링 안에 점수가 보여야 한다
  ok('  링 안에 점수가 보인다', /^\d+$/.test(many.chip), many.chip);
  ok('  더 이상 준비 중이 아니다', !/준비|\//.test(many.chip), many.chip);
}

/* ══════ ③-b 지어낸 점수를 AI 나 기록에 남기지 않는다 ══════ */
{
  await seed(2);
  const r = await ev(() => {
    const pm = prevYM(thisYM());
    S.tx.push({ id: 'p1', type: 'expense', date: pm + '-05', amount: 9000, cat: '식비', payKind: 'cash' });
    S.scores = {}; _discInvalidate(); save();
    recordScore();
    return { kept: Object.keys(S.scores).length, hist: scoreHistory(6).filter((x) => x.has).length,
      ctx: /건강점수/.test(JSON.stringify(aiCtx ? aiCtx() : '')) };
  });
  ok('기록이 적은 달은 점수 이력에 남기지 않는다', r.kept === 0, r._err || `${r.kept}개`);
  ok('  추이 그래프에도 찍지 않는다', r.hist === 0, r._err || `${r.hist}개월`);
  ok('  AI 에게도 넘기지 않는다', r.ctx === false, r._err || String(r.ctx));
}

/* ══════ ③-c 월초 며칠치로 월말을 단정하지 않는다 ══════ */
{
  const r = await ev(() => {
    S.tx = []; S.budgets = {}; save();
    const t = todayStr();
    S.tx.push({ id: 'one', type: 'expense', date: t, amount: 30000, cat: '식비', payKind: 'cash' });
    S.budgets[thisYM()] = { total: 1000000 };
    _discInvalidate(); save();
    const few = { conf: forecastMonth().conf, ready: forecastMonth().ready, pace: budgetPace(thisYM()) };
    for (let i = 0; i < 12; i++) S.tx.push({ id: 'x' + i, type: 'expense', date: addDays(t, -i),
      amount: 12000, cat: '식비', payKind: 'cash' });
    _discInvalidate(); save();
    return { few, many: { conf: forecastMonth().conf, ready: forecastMonth().ready } };
  });
  ok('한두 건으로는 월말을 예측하지 않는다', !!r.few && r.few.conf === '데이터 부족' && !r.few.ready, (r.few||{}).conf||r._err);
  ok('  예산 카드도 예측 대신 지금까지 쓴 것만 말한다', !!(r.few && r.few.pace) && !r.few.pace.ready);
  ok('  기록이 쌓이면 신뢰도가 올라간다', !!(r.many && r.many.ready), (r.many||{}).conf||r._err);
}

/* ══════ ④ 저장하면 무엇이 달라졌는지 말하고, 되돌릴 수 있다 ══════ */
{
  await seed(0);
  await p.evaluate(() => openTxModal());
  await p.waitForTimeout(220);
  try { await p.fill('#tx-amt', '18,400', { timeout: 2000 }); } catch (e) {}
  try { await p.fill('#tx-memo', '점심', { timeout: 2000 }); } catch (e) {}
  await p.evaluate(() => saveTx());
  await p.waitForTimeout(220);
  const r = await p.evaluate(() => ({
    n: S.tx.length, amt: (S.tx[0] || {}).amount,
    toast: document.getElementById('toast').innerText.replace(/\s+/g, ' ').trim(),
    undo: !!document.querySelector('#toast .t-act'),
    closed: !document.getElementById('modal').classList.contains('open') }));
  ok('저장된다', r.n === 1 && r.amt === 18400, `${r.amt}`);
  ok('  창이 닫힌다', r.closed);
  ok("  '저장했어요' 로 끝나지 않는다", !/^저장했어요$/.test(r.toast), r.toast);
  ok('  무엇이 달라졌는지 숫자로 말한다', /오늘|예산|실적/.test(r.toast), r.toast);
  ok('  되돌리기가 함께 뜬다', r.undo);
  /* left:50% 로 붙은 고정 요소라 폭이 화면의 반으로 잘려, 긴 문구가 한 단어씩 접히며
     알약이 덩어리가 됐다. 문구가 늘어나도 한 줄에 서야 한다. */
  const box = await p.evaluate(() => { const t = document.getElementById('toast');
    const b = t.getBoundingClientRect();
    return { w: Math.round(b.width), h: Math.round(b.height), vw: window.innerWidth,
      inside: b.left >= 0 && b.right <= window.innerWidth }; });
  ok('  토스트가 한 줄에 들어간다', box.h <= 56, `${box.w}×${box.h}`);
  ok('  화면 밖으로 나가지 않는다', box.inside && box.w <= box.vw, `${box.w}px / 화면 ${box.vw}px`);

  const balBefore = await p.evaluate(() => accById('chk').balance);
  try { await p.click('#toast .t-act', { timeout: 2000 }); } catch (e) {}
  await p.waitForTimeout(250);
  const u = await p.evaluate(() => ({ n: S.tx.length, bal: accById('chk').balance,
    toast: document.getElementById('toast').innerText.trim() }));
  ok('되돌리면 내역이 사라진다', u.n === 0, `${u.n}건`);
  ok('  잔액도 함께 되돌아간다', u.bal === balBefore, `${balBefore} → ${u.bal}`);
  ok('  되돌렸다고 알려준다', /되돌렸/.test(u.toast), u.toast);
}

/* ══════ ④-b 예산이 있으면 남은 예산을, 실적 구간이 있으면 남은 실적을 ══════ */
{
  await seed(0);
  const withBudget = await ev(() => {
    S.budgets[thisYM()] = { total: 500000 }; _discInvalidate(); save();
    return txFeedback({ type: 'expense', amount: 20000, date: todayStr(), payKind: 'cash' });
  });
  ok('예산이 있으면 남은 예산을 말한다', /예산/.test(String(withBudget)), String(withBudget));

  const withPerf = await ev(() => {
    S.budgets = {}; _discInvalidate(); save();
    return txFeedback({ type: 'expense', amount: 20000, date: todayStr(), payKind: 'card', payId: 'c1' });
  });
  ok('  예산이 없고 실적 구간이 있으면 실적까지 남은 금액', /실적/.test(String(withPerf)), String(withPerf));

  const plain = await ev(() => {
    S.cards = []; _discInvalidate(); save();
    return txFeedback({ type: 'expense', amount: 20000, date: todayStr(), payKind: 'cash' });
  });
  ok('  둘 다 없으면 오늘 쓴 돈 (늘 맞는 숫자)', /오늘/.test(String(plain)), String(plain));
}

/* ══════ ④-c 수정도 되돌릴 수 있다 ══════ */
{
  await seed(0);
  const r = await ev(() => {
    S.tx = [{ id: 't1', type: 'expense', date: todayStr(), amount: 10000, cat: '식비', memo: '원래',
      payKind: 'account', payId: 'chk' }];
    applyBalance(S.tx[0], 1); save();
    const bal0 = accById('chk').balance;
    openTxModal('t1'); document.getElementById('tx-amt').value = '99,000'; saveTx();
    const mid = { amt: S.tx[0].amount, bal: accById('chk').balance };
    undoLastTx();
    return { bal0, mid, back: { amt: S.tx[0].amount, memo: S.tx[0].memo, bal: accById('chk').balance } };
  });
  ok('수정이 반영되고', !!r.mid && r.mid.amt === 99000, (r.mid||{}).amt ?? r._err);
  ok('  되돌리면 원래 금액으로', !!r.back && r.back.amt === 10000 && r.back.memo === '원래', (r.back||{}).amt ?? r._err);
  ok('  잔액도 원래대로', !!r.back && r.back.bal === r.bal0, r.back ? `${r.bal0} → ${r.back.bal}` : r._err);
}

ok('콘솔/페이지 오류 없음', errs.length === 0, errs.slice(0, 3).join(' | ') || '없음');
await b.close();
