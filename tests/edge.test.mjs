/* 날짜 경계 — 시계를 고정해서 본다.
 *
 * 우리 테스트는 모두 '오늘'을 그대로 써서, 2월이나 말일에만 나는 문제를 볼 수 없었다.
 * (자동 선결제 요일 버그도 마침 일요일에 돌려서 우연히 걸렸다.)
 * 여기서는 시계를 특정 날짜로 박아두고 돌린다.
 *
 * 보는 것
 *   ① 29·30·31일 결제일이 짧은 달에 통째로 건너뛰어지지 않는가
 *   ② 기록되는 날짜가 실제로 존재하는 날인가 (2026-02-31 같은 게 만들어지면 안 된다)
 *   ③ 끝난 고정비가 앞으로의 잔액 곡선에서 빠지는가
 *   ④ 환율은 '실제로 받아온 값'만 관측으로 남는가 */
import { chromium, BASE, makeOk } from './lib/env.mjs';

const ok = makeOk();
const b = await chromium.launch();

/* 시계를 고정한 페이지 하나 */
async function at(iso) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
  await ctx.route('**/*', (r) => (r.request().url().includes('127.0.0.1') ? r.continue() : r.abort()));
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date(iso) });
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForTimeout(700);
  return { ctx, p };
}

/* ══════ ① 2월 말일 — 31일 고정비가 건너뛰어지면 안 된다 ══════ */
{
  const { ctx, p } = await at('2026-02-28T20:00:00+09:00');
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '통장', balance: 1000000, cur: 'KRW' },
                  { id: 'sav', type: 'saving', name: '적금', balance: 0, cur: 'KRW', monthly: 100000, payDay: 31, payFrom: 'chk' }];
    S.cards = []; S.tx = []; S.goals = []; S.invLogs = []; S.budgets = {};
    S.fixed = [{ id: 'rent', kind: 'expense', name: '월세', amount: 300000, day: 31, cat: '주거',
                 payKind: 'account', payId: 'chk', active: true }];
    _discInvalidate(); save();
    autoApplyFixed(); autoApplySaving();
    const rent = S.tx.find((t) => t.fixedId === 'rent');
    const sav = S.tx.find((t) => t.savingId === 'sav');
    const valid = (d) => !!d && new Date(d + 'T00:00:00').getDate() === +d.slice(8);
    // 한 번 더 — 중복으로 또 빠지면 안 된다
    autoApplyFixed(); autoApplySaving();
    return { today: todayStr(), rentDate: rent && rent.date, savDate: sav && sav.date,
      rentValid: valid(rent && rent.date), savValid: valid(sav && sav.date),
      n: S.tx.length, bal: accById('chk').balance };
  });
  ok('2월에도 31일 고정비가 기록됨', !!r.rentDate, r.rentDate || '(건너뜀)');
  ok('  그 달 마지막 날로', r.rentDate === '2026-02-28', r.rentDate);
  ok('  존재하는 날짜임 (2026-02-31 아님)', r.rentValid);
  ok('31일 적금 자동납입도 기록됨', r.savDate === '2026-02-28' && r.savValid, r.savDate);
  ok('  두 번 돌려도 중복되지 않음', r.n === 2, `${r.n}건`);
  ok('  잔액에서 한 번만 빠짐', r.bal === 1000000 - 300000 - 100000, `${r.bal}원`);
  await ctx.close();
}

/* ══════ ② 말일 결제일을 실제로 입력할 수 있어야 한다 ══════ */
{
  const { ctx, p } = await at('2026-02-10T12:00:00+09:00');
  const r = await p.evaluate(() => {
    openFixedModal(null, 'expense');
    const el = document.getElementById('fx-day');
    const max = el ? el.getAttribute('max') : '';
    closeModal();
    // 저장 경로가 31을 보존하는가
    S.fixed = []; save();
    openFixedModal(null, 'expense');
    document.getElementById('fx-name').value = '월세';
    document.getElementById('fx-amt').value = '300000';
    document.getElementById('fx-day').value = '31';
    saveFixed();
    return { max, saved: (S.fixed[0] || {}).day };
  });
  ok('결제일을 31일까지 넣을 수 있음', r.max === '31', `max=${r.max}`);
  ok('  31일이 그대로 저장됨', r.saved === 31, String(r.saved));
  await ctx.close();
}

/* ══════ ③ 끝난 고정비는 앞날에서 빠져야 한다 ══════ */
{
  const { ctx, p } = await at('2026-02-25T12:00:00+09:00');
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '통장', balance: 1000000, cur: 'KRW' }];
    S.cards = []; S.tx = []; S.invLogs = []; S.budgets = {};
    S.fixed = [
      { id: 'old', kind: 'expense', name: '끝난 구독', amount: 99000, day: 28, to: '2026-02-20',
        cat: '구독', payKind: 'account', payId: 'chk', active: true },
      { id: 'soon', kind: 'expense', name: '아직 시작 안 함', amount: 50000, day: 28, from: '2026-06-01',
        cat: '구독', payKind: 'account', payId: 'chk', active: true },
      { id: 'live', kind: 'expense', name: '살아 있는 고정비', amount: 70000, day: 28,
        cat: '구독', payKind: 'account', payId: 'chk', active: true },
    ];
    _discInvalidate(); save();
    const names = (cashflowPlan(40).line || []).flatMap((x) => x.ev || []).map((e) => e.n);
    const safe = safeSpend();
    return { names, safeNames: safe.items.map((i) => i.n) };
  });
  ok('끝난 고정비는 잔액 곡선에서 빠짐', !r.names.includes('끝난 구독'), r.names.join(',') || '(없음)');
  ok('  아직 시작 안 한 것도 빠짐', !r.names.includes('아직 시작 안 함'));
  ok('  살아 있는 것은 남음', r.names.includes('살아 있는 고정비'), r.names.join(','));
  ok("'쓸 수 있는 돈'에서도 끝난 것은 빠짐", !r.safeNames.includes('끝난 구독'), r.safeNames.join(',') || '(없음)');
  await ctx.close();
}

/* ══════ ④ 30일까지인 달 — 31일 결제일 ══════ */
{
  const { ctx, p } = await at('2026-04-30T21:00:00+09:00');
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '통장', balance: 2000000, cur: 'KRW' }];
    S.cards = [{ id: 'c1', type: 'credit', name: '카드', accountId: 'chk', payDay: 31,
                 tiers: [], exclCats: [], perks: [], prepays: [], open: { ym: '', pending: 0, perf: 0 } }];
    S.tx = [{ id: 'x1', type: 'expense', date: todayStr(), amount: 200000, cat: '식비', memo: '장보기',
              payKind: 'card', payId: 'c1', months: 1, paidPortions: 0 }];
    S.fixed = [{ id: 'pay', kind: 'income', name: '급여', amount: 3000000, day: 31, cat: '급여',
                 payKind: 'account', payId: 'chk', active: true }];
    _discInvalidate(); save();
    const hz = nextIncomeDate();
    const plan = cashflowPlan(40);
    const cardHit = (plan.line || []).find((x) => (x.ev || []).some((e) => e.t === 'card'));
    return { hz, cardDate: cardHit && cardHit.d, dim: daysIn(hz.date.slice(0, 7)) };
  });
  ok('31일 급여 → 30일까지인 달은 말일', +r.hz.date.slice(8) === Math.min(31, r.dim), `${r.hz.date} (그 달 ${r.dim}일)`);
  ok('31일 카드 결제일도 곡선에 잡힘', !!r.cardDate, r.cardDate || '(안 잡힘)');
  ok('  존재하는 날짜임', !!r.cardDate && new Date(r.cardDate + 'T00:00:00').getDate() === +r.cardDate.slice(8), r.cardDate);
  await ctx.close();
}

/* ══════ ⑤ 환율 — 지어낸 관측을 남기지 않는다 ══════ */
{
  const { ctx, p } = await at('2026-03-10T09:00:00+09:00');
  const r = await p.evaluate(() => {
    // 한 번도 환율을 받아온 적 없는 사람 (외부망 차단 등)
    S.settings.fx = { usdkrw: 1380, at: '', auto: true, hist: {} };
    save();
    const before = Object.keys(S.settings.fx.hist).length;
    // 앱을 8일 연속 열었다고 가정 — 시작 코드와 같은 조건을 그대로 쓴다
    for (let i = 0; i < 8; i++) if (S.settings.fx && S.settings.fx.at) fxRecord(fxRate());
    const after = Object.keys(S.settings.fx.hist).length;
    const st = fxStats(6);
    // 실제로 받아온 뒤에는 남아야 한다
    S.settings.fx.at = todayStr();
    fxRecord(1395);
    return { before, after, enough: st.enough, n: st.n, afterReal: Object.keys(S.settings.fx.hist).length };
  });
  ok('받아온 적 없으면 관측을 남기지 않음', r.after === 0, `${r.after}개`);
  ok('  따라서 "낮은 편/높은 편" 판정도 하지 않음', r.enough === false, `표본 ${r.n}개`);
  ok('실제로 받아오면 그때부터 남음', r.afterReal === 1, `${r.afterReal}개`);
  await ctx.close();
}

/* ══════ ⑥ 이거 사도 될까? ══════ */
{
  const { ctx, p } = await at('2026-03-10T09:00:00+09:00');
  const r = await p.evaluate(() => {
    const t = todayStr(), D = (n) => +addDays(t, n).slice(8, 10);
    S.accounts = [{ id: 'chk', type: 'checking', name: '통장', balance: 2000000, cur: 'KRW' }];
    S.cards = []; S.tx = []; S.budgets = {}; S.settings.buffer = 0;
    S.fixed = [{ id: 'f1', kind: 'income', name: '급여', amount: 3000000, day: D(10), cat: '급여',
                 payKind: 'account', payId: 'chk', active: true }];
    _discInvalidate(); save();
    const before = safeSpend().usable;
    return { before, lump: buyCheck(500000, 1), inst: buyCheck(1200000, 12), over: buyCheck(5000000, 1),
      bad: buyCheck(0, 1) };
  });
  ok('일시불 — 쓸 수 있는 돈에서 그대로 빠짐', r.lump.after === r.before - 500000, `${r.before} → ${r.lump.after}`);
  ok('할부 — 이번 기간엔 첫 회차만', r.inst.first === 100000 && r.inst.after === r.before - 100000,
     `첫 회차 ${r.inst.first}`);
  ok('감당 안 되면 음수로 알려줌', r.over.after < 0, String(r.over.after));
  ok('  금액이 없으면 계산하지 않음', r.bad.valid === false);

  const ui = await p.evaluate(() => {
    openBuyModal();
    document.getElementById('buy-amt').value = '500000';
    renderBuyResult();
    const txt = document.getElementById('sheet').innerText;
    closeModal();
    return { txt, noTx: S.tx.length, bal: accById('chk').balance };
  });
  ok('화면에 사기 전후가 보임', /사고 나면/.test(ui.txt) && /1,500,000/.test(ui.txt), ui.txt.slice(0, 40).replace(/\n/g, ' '));
  ok('  기록을 만들지 않음', ui.noTx === 0 && ui.bal === 2000000, `내역 ${ui.noTx}건 · 잔액 ${ui.bal}`);
  await ctx.close();
}

await b.close();
