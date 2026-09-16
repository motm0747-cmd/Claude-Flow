/* 돈 입력 — 사용자가 친 숫자가 조용히 사라지면 안 된다.
 *
 * 통장 잔액에 값을 넣어도 계속 0 으로 보인다는 제보에서 출발했다. 원인은 돈 칸이
 * type="number" 였다는 것 — 브라우저가 `310,000` 같은 값을 '무효'로 보고 .value 를
 * 통째로 비워버리는데, 앱은 그 빈 값을 0 으로 읽어 그대로 저장했다.
 * 화면에는 친 게 보이는데 저장은 0 이라, 사용자 눈에는 "입력이 안 먹는" 것으로 보인다. */
import { chromium, APP, makeOk } from './lib/env.mjs';

const ok = makeOk();
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1280, height: 900 }, serviceWorkers: 'block' });
await ctx.route('**/*', (r) => (r.request().url().includes('127.0.0.1') ? r.continue() : r.abort()));
const p = await ctx.newPage();
const errs = [];
p.on('pageerror', (e) => errs.push(e.message));
await p.goto(APP, { waitUntil: 'load' });
await p.waitForTimeout(700);

const reset = () => p.evaluate(() => {
  S.accounts = [{ id: 'chk', type: 'checking', name: '하나 나라사랑통장', bank: '하나은행', balance: 0, cur: 'KRW' }];
  S.cards = []; S.tx = []; S.fixed = []; S.goals = []; S.invLogs = []; S.budgets = {}; S.wish = [];
  _discInvalidate(); save();
});

/* ══════ ① 사람이 실제로 치는 형태들 ══════ */
for (const typed of ['310000', '310,000', '310 000', '₩310,000', '310000원']) {
  await reset();
  await p.evaluate(() => openAccModal('chk'));
  await p.waitForTimeout(120);
  await p.click('#ac-bal', { clickCount: 3 });
  await p.keyboard.press('Backspace');
  await p.keyboard.type(typed);
  const dom = await p.evaluate(() => document.getElementById('ac-bal').value);
  await p.evaluate(() => saveAcc('chk', 'checking'));
  const saved = await p.evaluate(() => accById('chk').balance);
  ok(`"${typed}" 로 쳐도 그대로 저장됨`, saved === 310000, `칸 "${dom}" → ${saved}`);
}

/* ══════ ② 돈 칸이 type=number 면 안 된다 ══════
   type=number 는 무효한 입력에서 .value 를 비워버려서 이 문제를 다시 만든다. */
{
  const bad = await p.evaluate(() => {
    const out = [];
    const MONEY = /금액|잔액|납입액|한도|목표|예산|평가금액|실적|카드값|연회비|환율|카드값|원\)/;
    const check = (open) => {
      try { open(); } catch (e) { return; }
      document.querySelectorAll('#sheet input[type="number"]').forEach((el) => {
        const lab = (el.closest('.field') || {}).innerText || '';
        if (MONEY.test(lab)) out.push(el.id + ' — ' + lab.split('\n')[0]);
      });
      closeModal();
    };
    check(() => openAccModal('chk'));
    check(() => openTxModal());
    check(() => openFixedModal(null, 'expense'));
    check(() => openGoalModal());
    check(() => openDebtModal());
    check(() => openBuyModal());
    check(() => openReconModal());
    check(() => openBudgetModal());
    check(() => openWishModal());
    check(() => openFxModal());
    check(() => openSafeModal());
    check(() => {
      S.accounts.push({ id: 'iv', type: 'invest', name: '증권', balance: 0, cur: 'USD' });
      save(); openInvLogModal('iv');
    });
    check(() => { S.cards = [{ id: 'c1', type: 'credit', name: 'X', accountId: 'chk', payDay: 14, tiers: [], exclCats: [], perks: [], prepays: [], open: { ym: '', pending: 0, perf: 0 } }]; save(); openCardModal('c1'); });
    return [...new Set(out)];
  });
  ok('돈 칸에 type=number 가 남아 있지 않음', bad.length === 0, bad.slice(0, 4).join(' | ') || '없음');
}

/* ══════ ③ 숫자로 못 읽는 값은 거절한다 (조용히 0 으로 저장하지 않는다) ══════ */
{
  await reset();
  await p.evaluate(() => { accById('chk').balance = 310000; save(); openAccModal('chk'); });
  await p.waitForTimeout(120);
  await p.click('#ac-bal', { clickCount: 3 });
  await p.keyboard.press('Backspace');
  await p.keyboard.type('삼십일만');
  await p.evaluate(() => saveAcc('chk', 'checking'));
  const r = await p.evaluate(() => ({
    bal: accById('chk').balance,
    open: document.getElementById('modal').classList.contains('open'),
    toast: document.getElementById('toast').textContent }));
  ok('못 읽는 값이면 기존 잔액을 지키고', r.bal === 310000, String(r.bal));
  ok('  무엇이 문제인지 알려주고', /숫자로 입력/.test(r.toast), r.toast);
  ok('  모달을 닫지 않는다 (고칠 수 있게)', r.open);
  await p.evaluate(() => closeModal());
}

/* ══════ ④ 비워두면 0 으로 받는다 (거절 아님) ══════ */
{
  await reset();
  await p.evaluate(() => { accById('chk').balance = 310000; save(); openAccModal('chk'); });
  await p.waitForTimeout(120);
  await p.click('#ac-bal', { clickCount: 3 });
  await p.keyboard.press('Backspace');
  await p.evaluate(() => saveAcc('chk', 'checking'));
  const r = await p.evaluate(() => ({ bal: accById('chk').balance, open: document.getElementById('modal').classList.contains('open') }));
  ok('빈칸은 0 으로 저장', r.bal === 0 && !r.open, `${r.bal}`);
}

/* ══════ ⑤ 이미 망가진 잔액은 열 때 되살린다 ══════ */
{
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'a', type: 'checking', name: 'X', cur: 'KRW' },            // balance 없음
                  { id: 'b', type: 'checking', name: 'Y', balance: null, cur: 'KRW' },
                  { id: 'c', type: 'checking', name: 'Z', balance: '310000', cur: 'KRW' },
                  { id: 'd', type: 'checking', name: 'W', balance: NaN, cur: 'KRW' }];
    migrate();
    const bals = S.accounts.map((a) => a.balance);
    return { bals, allNum: bals.every((v) => typeof v === 'number' && Number.isFinite(v)),
      total: totalAssets(), shown: (openAccModal('a'), document.getElementById('ac-bal').value) };
  });
  ok('망가진 잔액이 숫자로 되살아남', r.allNum, JSON.stringify(r.bals));
  ok('  문자열로 들어온 것도 숫자로', r.bals[2] === 310000, String(r.bals[2]));
  ok('  총자산이 계산됨', r.total === 310000, String(r.total));
  ok('  수정 화면에 0 이 보임 (빈칸 아님)', r.shown === '0', `"${r.shown}"`);
  await p.evaluate(() => closeModal());
}

/* ══════ ⑥ 이상한 금액으로 잔액을 망가뜨리지 않는다 ══════ */
{
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '통장', balance: 100000, cur: 'KRW' }];
    S.tx = []; save();
    applyToAcc(accById('chk'), undefined, -1);
    applyToAcc(accById('chk'), NaN, -1);
    applyToAcc(accById('chk'), '오천', -1);
    const after = accById('chk').balance;
    applyToAcc(accById('chk'), 5000, -1);
    return { after, ok: accById('chk').balance };
  });
  ok('읽을 수 없는 금액은 잔액을 건드리지 않음', r.after === 100000, String(r.after));
  ok('  정상 금액은 그대로 반영', r.ok === 95000, String(r.ok));
}

/* ══════ ⑦ 다른 돈 칸도 같은 규칙 — 저장된 값으로 확인한다 ══════ */
{
  await reset();
  /* 거래: 쉼표를 친 금액이 그대로 기록돼야 한다 */
  await p.evaluate(() => openTxModal());
  await p.waitForTimeout(120);
  await p.click('#tx-amt');
  await p.keyboard.type('12,500');
  await p.fill('#tx-memo', '점심');
  await p.evaluate(() => saveTx());
  const tx = await p.evaluate(() => (S.tx[0] || {}).amount);
  ok('거래 금액도 쉼표를 받아들임', tx === 12500, String(tx));

  /* 예산 */
  await p.evaluate(() => openBudgetModal());
  await p.waitForTimeout(120);
  await p.click('#bd-total');
  await p.keyboard.type('1,000,000');
  const bd = await p.evaluate(() => { syncBd(); const v = bdDraft.total; closeModal(); return v; });
  ok('예산 총액도 쉼표를 받아들임', bd === 1000000, String(bd));

  /* 위시 */
  await p.evaluate(() => openWishModal());
  await p.waitForTimeout(120);
  await p.fill('#wi-name', '노트북');
  await p.click('#wi-amt');
  await p.keyboard.type('1,500,000');
  await p.evaluate(() => saveWish());
  const wi = await p.evaluate(() => ((S.wish || [])[0] || {}).amount);
  ok('사고 싶은 것 금액도 쉼표를 받아들임', wi === 1500000, String(wi));

  /* 파서 자체 */
  const r = await p.evaluate(() => ({
    parsed: numOf('1,234,567'), won: numOf('5000원'), wonSym: numOf('₩310,000'),
    pct: numOf('10%'), dec: numOf('1380.5'), empty: numOf(''), sp: numOf('  '), bad: numOf('삼십일만'),
  }));
  ok('  파서: 1,234,567', r.parsed === 1234567, String(r.parsed));
  ok('  파서: 5000원', r.won === 5000, String(r.won));
  ok('  파서: ₩310,000', r.wonSym === 310000, String(r.wonSym));
  ok('  파서: 10%', r.pct === 10, String(r.pct));
  ok('  파서: 1380.5', r.dec === 1380.5, String(r.dec));
  ok('  파서: 빈값은 0', r.empty === 0 && r.sp === 0, `${r.empty}/${r.sp}`);
  ok('  파서: 못 읽으면 NaN', Number.isNaN(r.bad), String(r.bad));
}

ok('콘솔/페이지 오류 없음', errs.length === 0, errs.slice(0, 3).join(' | '));
await b.close();
