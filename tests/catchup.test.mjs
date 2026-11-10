/* 앱을 한동안 안 열었을 때 — 밀린 달이 그대로 비면 안 된다.
 *
 * 고정비·자동납입은 '이번 달' 만 보고 있었다. 그래서 9/20 에 열고 11/3 에 다시 열면
 * 10월이 통째로 비었다 — 월세·급여·적금이 영영 기록되지 않고, 잔액과 홈의 대표 숫자인
 * '쓸 수 있는 돈' 이 그만큼 틀어진 채로 남는다.
 *
 * 메우기 시작하면 반대 위험이 생긴다. 사용자가 '이번 달엔 안 냈다' 며 지운 자동 기록이
 * 다음에 열 때 되살아나는 것 — 이건 원래부터 있던 문제라 함께 고정한다. */
import { chromium, BASE, makeOk } from './lib/env.mjs';

const ok = makeOk();
const b = await chromium.launch();

/* 시계를 고정한 페이지 */
async function at(iso) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
  await ctx.route('**/*', (r) => (r.request().url().includes('127.0.0.1') ? r.continue() : r.abort()));
  const p = await ctx.newPage();
  await p.clock.install({ time: new Date(iso) });
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForTimeout(600);
  return { ctx, p };
}

const SEED = `
  S.accounts = [{ id:'chk', type:'checking', name:'주거래', balance:3000000, cur:'KRW' },
    { id:'sav', type:'saving', name:'적금', balance:0, cur:'KRW', monthly:300000, payDay:10, payFrom:'chk', payFrom_start:'2026-09-01' }];
  S.cards = []; S.tx = []; S.budgets = {}; S.scores = {}; S.autoLog = {};
  S.fixed = [
    { id:'rent', kind:'expense', name:'월세', amount:550000, day:25, cat:'주거', payKind:'account', payId:'chk', active:true, from:'', to:'', since:'2026-09-01' },
    { id:'pay',  kind:'income',  name:'급여', amount:2800000, day:28, cat:'급여', payKind:'account', payId:'chk', active:true, from:'', to:'', since:'2026-09-01' }];
  S.settings.setupAt = '2026-09-01';
  _discInvalidate(); save();
`;
const byMonth = () => {
  const out = {};
  S.tx.forEach((t) => { const m = ymOf(t.date); (out[m] = out[m] || []).push(t.memo); });
  return out;
};

/* ══════ ① 한 달을 통째로 건너뛰어도 그 달이 메워진다 ══════ */
{
  const a = await at('2026-09-20T10:00:00+09:00');
  const blob = await a.p.evaluate(`(()=>{ ${SEED} autoApplyFixed(); autoApplySaving();
    return localStorage.getItem('claudeflow_v1'); })()`);
  await a.ctx.close();

  const c = await at('2026-11-03T10:00:00+09:00');
  const r = await c.p.evaluate((d) => {
    localStorage.setItem('claudeflow_v1', d);
    reloadStateFromStorage();
    autoApplyFixed(); autoApplySaving();
    const out = {};
    S.tx.forEach((t) => { const m = ymOf(t.date); (out[m] = out[m] || []).push(t.memo); });
    return { by: out, bal: accById('chk').balance, sav: accById('sav').balance };
  }, blob);
  const oct = r.by['2026-10'] || [], sep = r.by['2026-09'] || [];
  ok('건너뛴 10월의 고정지출이 메워진다', oct.some((x) => /월세/.test(x)), oct.join(',') || '10월 비어 있음');
  ok('  고정수입도', oct.some((x) => /급여/.test(x)), oct.join(','));
  ok('  적금 자동납입도', oct.some((x) => /적금/.test(x)), oct.join(','));
  ok('  열어두고 지나간 9월 분도 함께', sep.filter((x) => /월세|급여/.test(x)).length === 2, sep.join(','));
  // 9·10월 각각 급여 280 − 월세 55 − 적금 30 = +195만, 시작 300만
  ok('  잔액이 그만큼 맞춰진다', r.bal === 3000000 + 2 * (2800000 - 550000 - 300000), `${r.bal}`);
  ok('  적금도 두 번 들어간다', r.sav === 600000, `${r.sav}`);
  await c.ctx.close();
}

/* ══════ ② 같은 달을 두 번 열어도 두 번 넣지 않는다 ══════ */
{
  const { ctx, p } = await at('2026-10-28T10:00:00+09:00');
  const r = await p.evaluate(`(()=>{ ${SEED}
    autoApplyFixed(); autoApplySaving();
    const a = { n: S.tx.length, bal: accById('chk').balance };
    autoApplyFixed(); autoApplySaving();   // 다시 열었다
    autoApplyFixed(); autoApplySaving();
    return { a, b: { n: S.tx.length, bal: accById('chk').balance } }; })()`);
  ok('여러 번 열어도 중복 기록되지 않는다', r.a.n === r.b.n && r.a.bal === r.b.bal,
    `${r.a.n}건 → ${r.b.n}건`);
  await ctx.close();
}

/* ══════ ③ 지운 자동 기록이 되살아나지 않는다 ══════ */
{
  const { ctx, p } = await at('2026-10-28T10:00:00+09:00');
  const r = await p.evaluate(`(()=>{ ${SEED}
    autoApplyFixed();
    const before = { n: S.tx.length, bal: accById('chk').balance };
    const t = S.tx.find(x => x.fixedId === 'rent' && ymOf(x.date) === thisYM());
    applyBalance(t, -1); S.tx = S.tx.filter(x => x.id !== t.id); save();
    const del = { n: S.tx.length, bal: accById('chk').balance };
    autoApplyFixed();                    // 앱을 다시 연다
    autoApplyFixed();
    return { before, del, after: { n: S.tx.length, bal: accById('chk').balance } }; })()`);
  ok('지운 자동 기록은 돌아오지 않는다', r.after.n === r.del.n, `${r.del.n}건 → ${r.after.n}건`);
  ok('  잔액도 다시 깎이지 않는다', r.after.bal === r.del.bal, `${r.del.bal} → ${r.after.bal}`);
  await ctx.close();
}

/* ══════ ④ 지난 달 것을 메웠으면 그렇게 말한다 ══════ */
{
  const a = await at('2026-09-05T10:00:00+09:00');
  const blob = await a.p.evaluate(`(()=>{ ${SEED} return localStorage.getItem('claudeflow_v1'); })()`);
  await a.ctx.close();
  const c = await at('2026-11-03T10:00:00+09:00');
  const r = await c.p.evaluate((d) => {
    localStorage.setItem('claudeflow_v1', d); reloadStateFromStorage();
    autoApplyFixed();
    return document.getElementById('toast').textContent;
  }, blob);
  ok('무엇을 메웠는지 알려준다', /지난 달/.test(r), r);
  await c.ctx.close();
}

/* ══════ ⑤ 쓰기 전으로는 소급하지 않는다 ══════
   처음 설치한 사람에게 과거 몇 달치가 쏟아지면 안 된다. */
{
  const { ctx, p } = await at('2026-11-20T10:00:00+09:00');
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 1000000, cur: 'KRW' }];
    S.cards = []; S.tx = []; S.budgets = {}; S.autoLog = {};
    S.fixed = [{ id: 'rent', kind: 'expense', name: '월세', amount: 550000, day: 5, cat: '주거',
      payKind: 'account', payId: 'chk', active: true, from: '', to: '' }];
    S.settings.setupAt = '';                 // 아직 시작 설정도 안 함, 기록도 없음
    _discInvalidate(); save();
    autoApplyFixed();
    const fresh = { n: S.tx.length, months: [...new Set(S.tx.map((t) => ymOf(t.date)))] };
    // 이번엔 10월부터 쓰기 시작한 사람
    S.tx = []; S.autoLog = {}; S.settings.setupAt = '2026-10-10';
    S.accounts[0].balance = 1000000; _discInvalidate(); save();
    autoApplyFixed();
    return { fresh, since: [...new Set(S.tx.map((t) => ymOf(t.date)))].sort() };
  });
  ok('기록이 없으면 이번 달만 본다', r.fresh.months.length <= 1, r.fresh.months.join(',') || '없음');
  ok('  10월부터 쓴 사람에게 9월 이전은 안 넣는다',
    r.since.every((m) => m >= '2026-10'), r.since.join(',') || '없음');
  ok('  그 사람의 10·11월은 넣는다', r.since.includes('2026-10') && r.since.includes('2026-11'), r.since.join(','));
  await ctx.close();
}

/* ══════ ⑥ 끝난 고정비는 메울 때도 제외된다 ══════ */
{
  const { ctx, p } = await at('2026-11-20T10:00:00+09:00');
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' }];
    S.cards = []; S.tx = []; S.budgets = {}; S.autoLog = {};
    S.fixed = [{ id: 'sub', kind: 'expense', name: '구독', amount: 10000, day: 5, cat: '구독',
      payKind: 'account', payId: 'chk', active: true, from: '', to: '2026-09-30' }];
    S.settings.setupAt = '2026-08-01';
    _discInvalidate(); save();
    autoApplyFixed();
    return [...new Set(S.tx.map((t) => ymOf(t.date)))].sort();
  });
  ok('해지한 달 이후로는 메우지 않는다', r.every((m) => m <= '2026-09'), r.join(',') || '없음');
  await ctx.close();
}

/* ══════ ⑦ 점수도 건너뛴 달까지 남긴다 ══════ */
{
  const { ctx, p } = await at('2026-11-20T10:00:00+09:00');
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' }];
    S.cards = []; S.fixed = []; S.budgets = {}; S.scores = {}; S.autoLog = {};
    S.settings.setupAt = '2026-08-01';
    S.tx = [];
    ['2026-09', '2026-10'].forEach((m) => {
      for (let i = 0; i < 12; i++) S.tx.push({ id: m + i, type: 'expense', date: `${m}-1${i % 9}`,
        amount: 9000, cat: '식비', memo: '점심', payKind: 'cash' });
      S.tx.push({ id: m + 'inc', type: 'income', date: `${m}-25`, amount: 2800000, cat: '급여', payKind: 'account', payId: 'chk' });
    });
    _discInvalidate(); save();
    recordScore();
    return Object.keys(S.scores).sort();
  });
  ok('건너뛴 달의 점수도 남는다', r.includes('2026-09') && r.includes('2026-10'), r.join(',') || '없음');
  ok('  이번 달은 아직 안 끝났으니 안 남긴다', !r.includes('2026-11'), r.join(','));
  await ctx.close();
}


/* ══════ ⑧ 새로 등록한 항목은 등록하기 전으로 소급하지 않는다 ══════
   '밀린 달 메우기' 는 앱을 처음 쓴 달까지만 막고 있었다. 그래서 석 달째 쓰던 사람이
   오늘 월세를 고정비로 **처음 등록하면**, 다음에 앱을 열 때 지난 석 달 치 월세가
   한꺼번에 기록되고 잔액이 그만큼 깎였다. 등록한 날 이전은 메울 대상이 아니다. */
{
  const { ctx, p } = await at('2026-11-05T10:00:00+09:00');
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' },
      { id: 'sav', type: 'saving', name: '적금', balance: 0, cur: 'KRW' }];
    S.cards = []; S.fixed = []; S.budgets = {}; S.scores = {}; S.autoLog = {};
    S.settings.setupAt = '2026-08-01';
    S.tx = [{ id: 'old', type: 'expense', date: '2026-08-03', amount: 9000, cat: '식비', memo: '8월부터 씀', payKind: 'cash' }];
    _discInvalidate(); save();
    // 화면에서 고정비를 새로 등록한다 (결제일 25일 — 이번 달 것은 아직 안 지났다)
    openFixedModal(null, 'expense');
    $('fx-name').value = '월세'; $('fx-amt').value = '550000'; $('fx-day').value = '25';
    [...$('fx-pay').options].forEach((o) => { if (o.value === 'account|chk') $('fx-pay').value = o.value; });
    saveFixed('');
    // 적금 자동납입도 오늘 처음 켠다 (납입일 10일 — 아직 안 지났다)
    openAccModal('sav');
    $('ac-monthly').value = '300000'; $('ac-payday').value = '10'; $('ac-payfrom').value = 'chk';
    saveAcc('sav', 'saving');
    autoApplyFixed(); autoApplySaving();          // 다음에 앱을 열었다
    return { months: [...new Set(S.tx.filter((t) => t.fixedId || t.savingId).map((t) => ymOf(t.date)))].sort(),
      bal: accById('chk').balance, since: S.fixed[0].since || '' };
  });
  ok('새 고정비가 지난 달로 소급 기록되지 않는다', r.months.length === 0, r.months.join(',') || '없음');
  ok('  잔액도 그대로', r.bal === 3000000, String(r.bal));
  ok('  등록한 날을 기억해 둔다', r.since === '2026-11-05', r.since || '없음');
  const blob = await p.evaluate(() => localStorage.getItem('claudeflow_v1'));
  await ctx.close();

  // 결제일이 지난 뒤 다시 열면 이번 달 것만 한 번 들어간다
  const c = await at('2026-11-26T10:00:00+09:00');
  const r2 = await c.p.evaluate((d) => {
    localStorage.setItem('claudeflow_v1', d); reloadStateFromStorage();
    autoApplyFixed(); autoApplySaving();
    return { list: S.tx.filter((t) => t.fixedId || t.savingId).map((t) => t.date + ' ' + t.memo).sort(),
      bal: accById('chk').balance };
  }, blob);
  ok('  결제일이 지나면 이번 달 것만 들어간다', r2.list.length === 2 && r2.list.every((x) => x.startsWith('2026-11')),
    r2.list.join(' / ') || '없음');
  ok('  잔액은 한 번씩만 깎인다', r2.bal === 3000000 - 550000 - 300000, String(r2.bal));
  await c.ctx.close();
}

/* ══════ ⑧-b 예전 날짜로 적은 내역이 메우는 범위를 끌어당기지 않는다 ══════
   시작 마법사는 진행 중인 할부를 '몇 달 전 구입' 으로 넣는다. 메우는 범위를 가장 오래된
   내역으로 잡으면, 오늘 처음 쓴 사람도 그 할부 하나 때문에 지난 달 고정비가 쏟아진다. */
{
  const { ctx, p } = await at('2026-11-05T10:00:00+09:00');
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' }];
    S.cards = [{ id: 'c1', type: 'credit', name: '카드', accountId: 'chk', payDay: 14, tiers: [], perks: [], exclCats: [] }];
    S.budgets = {}; S.scores = {}; S.autoLog = {}; S.tx = [];
    S.settings.setupAt = '2026-11-02';           // 사흘 전에 시작했다
    // 그때 등록해 둔 고정비 (예전 버전이 만든 것 — 등록일 표시가 없다)
    S.fixed = [{ id: 'rent', kind: 'expense', name: '월세', amount: 550000, day: 25, cat: '주거',
      payKind: 'account', payId: 'chk', active: true, from: '', to: '' }];
    // 마법사가 넣은 진행 중 할부 — 구입일이 석 달 전
    S.tx.push({ id: 'inst', type: 'expense', date: '2026-08-15', amount: 1200000, cat: '기타', memo: '노트북',
      payKind: 'card', payId: 'c1', months: 12, paidPortions: 3, noPerf: true, defended: true });
    _discInvalidate(); save(); reloadStateFromStorage();     // 앱을 다시 열었다
    autoApplyFixed();
    return { months: S.tx.filter((t) => t.fixedId).map((t) => ymOf(t.date)), bal: accById('chk').balance };
  });
  ok('옛 날짜 내역이 있어도 지난 달 고정비가 쏟아지지 않는다', r.months.length === 0, r.months.join(',') || '없음');
  ok('  잔액도 그대로', r.bal === 3000000, String(r.bal));
  await ctx.close();
}

/* ══════ ⑧-c 시작일을 직접 과거로 넣었으면 그건 메운다 (사용자가 정한 것) ══════ */
{
  const { ctx, p } = await at('2026-11-05T10:00:00+09:00');
  const r = await p.evaluate(() => {
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 3000000, cur: 'KRW' }];
    S.cards = []; S.fixed = []; S.budgets = {}; S.scores = {}; S.autoLog = {};
    S.settings.setupAt = '2026-08-01';
    S.tx = [{ id: 'old', type: 'expense', date: '2026-08-03', amount: 9000, cat: '식비', memo: 'x', payKind: 'cash' }];
    _discInvalidate(); save();
    openFixedModal(null, 'expense');
    $('fx-name').value = '구독'; $('fx-amt').value = '10000'; $('fx-day').value = '3';
    $('fx-from').value = '2026-10-01';
    saveFixed('');
    autoApplyFixed();
    return S.tx.filter((t) => t.fixedId).map((t) => t.date).sort();
  });
  ok('시작일을 과거로 정하면 그날부터는 메운다', r.join(',') === '2026-10-03,2026-11-03', r.join(',') || '없음');
  await ctx.close();
}

await b.close();
