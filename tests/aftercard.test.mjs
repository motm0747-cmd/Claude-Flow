/* 카드값 내고 나면 얼마 남나 — 홈의 대표 숫자가 못 보는 구간.
 *
 * '쓸 수 있는 돈' 은 **다음 수입일까지만** 본다. 그런데 카드 결제일은 그 뒤인 경우가
 * 많아서 "급여 들어오면 넉넉한데, 카드값 빠지고 나면?" 에는 답하지 못했다.
 * 잔액 곡선에서 다음 카드 결제 시점을 집어 그 직후 잔액을 보여준다.
 *
 * 시계를 고정해서 본다 — 결제일까지 며칠인가가 판정의 전부라 '오늘' 을 그대로 쓰면
 * 같은 코드가 날짜에 따라 통과했다 실패했다 한다. */
import { chromium, BASE, makeOk } from './lib/env.mjs';

const ok = makeOk();
const b = await chromium.launch();

/* 한 판정이 던져서 뒤의 판정이 통째로 안 돌면 무엇이 깨졌는지 알 수 없다.
   빈 껍데기를 돌려주고, 판정들은 그 껍데기를 안전하게 읽는다. */
const evOf = async (p, fn, arg) => {
  try { const v = await p.evaluate(fn, arg); return v && typeof v === 'object' ? v : { v }; }
  catch (e) { return { _err: String(e.message || e).split('\n')[0] }; }
};
const g = (o, path, dflt) => path.split('.').reduce((a, k) => (a == null ? a : a[k]), o) ?? dflt;

async function at(iso) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
    timezoneId: 'Asia/Seoul', serviceWorkers: 'block' });
  await ctx.route('**/*', (r) => (r.request().url().includes('127.0.0.1') ? r.continue() : r.abort()));
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', (e) => errs.push('PAGEERROR: ' + e.message));
  p.on('console', (m) => { const t = m.text(); if (m.type() === 'error' && !/net::|ERR_|Failed to load/.test(t)) errs.push(t); });
  await p.clock.install({ time: new Date(iso) });
  await p.goto(BASE + '/', { waitUntil: 'load' });
  await p.waitForTimeout(700);
  return { ctx, p, errs };
}

/* 카드 결제일 14일 · 급여 25일 · 월세 25일 · 카드로 75.6만 씀 */
const SEED = `
  S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:2400000,cur:'KRW'}];
  S.cards=[{id:'c1',type:'credit',name:'하나 MOVING',accountId:'chk',payDay:14,tiers:[],exclCats:[],
    perks:[],prepays:[],open:{ym:'',pending:0,perf:0}}];
  S.fixed=[{id:'rent',kind:'expense',name:'월세',amount:550000,day:25,cat:'주거',payKind:'account',payId:'chk',active:true,from:'',to:''},
    {id:'pay',kind:'income',name:'급여',amount:2800000,day:25,cat:'급여',payKind:'account',payId:'chk',active:true,from:'',to:''}];
  S.tx=[]; S.budgets={}; S.autoLog={}; S.scores={}; S.settings.setupAt='2026-09-01';
  for(let i=1;i<=18;i++)S.tx.push({id:'c'+i,type:'expense',date:addDays(todayStr(),-i),amount:42000,
    cat:'쇼핑',memo:'구매',payKind:'card',payId:'c1',months:1,paidPortions:0});
  _discInvalidate(); save(); renderAll();
`;

/* ══════ ① 결제일이 다음 달이어도 집어낸다 ══════ */
{
  const { ctx, p, errs } = await at('2026-10-21T10:00:00+09:00');
  const r = await evOf(p, `(()=>{ ${SEED}
    const a=afterCardPay(), s=safeSpend();
    return {a, hz:s.hz.date, safe:s.usable, pend:creditPendingNet(cardById('c1')),
      shown:document.getElementById('h-after').innerHTML.length>0,
      text:document.getElementById('h-after').innerText.replace(/\\s+/g,' ').trim()}; })()`);
  ok("'쓸 수 있는 돈' 은 급여일까지만 본다", r.hz === '2026-10-25', r.hz || r._err);
  ok('그 뒤의 카드 결제일을 집어낸다', g(r, 'a.date') === '2026-11-14', g(r, 'a.date', r._err || '없음'));
  ok('  며칠 뒤인지 센다', g(r, 'a.days') === 24, `${g(r, 'a.days', '-')}일`);
  ok('  카드값은 기록된 미결제액', g(r, 'a.total') === r.pend && g(r, 'a.total') === 756000,
    `${g(r, 'a.total', '-')} / ${r.pend}`);
  ok('  홈에 줄이 뜬다', r.shown === true, r.text || r._err);
  ok('  날짜와 금액이 글자로 보인다', /11\/14/.test(r.text || '') && /3,894,000/.test(r.text || ''), r.text || '');
  ok('  오류 없음', errs.length === 0, errs[0] || '');
  await ctx.close();
}

/* ══════ ② 곡선과 어긋나지 않는다 ══════
   숫자를 따로 계산하면 부족 경고와 다른 말을 하게 된다. 같은 곡선에서 가져온다. */
{
  const { ctx, p } = await at('2026-10-21T10:00:00+09:00');
  const r = await evOf(p, `(()=>{ ${SEED}
    const plan=cashflowPlan(), a=afterCardPay(plan);
    const pt=plan.line.find(x=>x.d===a.date);
    // 시작 잔액 + 그날까지의 사건 − 평소 지출 = 그날 잔액
    const evSum=plan.line.filter(x=>x.d<=a.date).reduce((s,x)=>
      s+x.ev.reduce((t,e)=>t+(e.t==='in'?e.v:-e.v),0),0);
    return {after:a.after, curve:pt.bal, start:plan.start, evSum}; })()`);
  ok('곡선이 말하는 잔액과 같다', r.after != null && r.after === r.curve, `${r.after} vs ${r.curve} ${r._err || ''}`);
  ok('  시작 잔액 + 수입 − 지출로 설명된다',
    r.start != null && r.start + r.evSum >= r.after, `${r.start} + ${r.evSum} → ${r.after}`);
  await ctx.close();
}

/* ══════ ③ 이번 달에 아직 결제일이 안 지났으면 이번 달을 집는다 ══════ */
{
  const { ctx, p } = await at('2026-10-05T10:00:00+09:00');
  const r = await evOf(p, `(()=>{ ${SEED} const a=afterCardPay();
    return {date:a&&a.date, days:a&&a.days}; })()`);
  ok('이번 달 결제일을 집는다', r.date === '2026-10-14' && r.days === 9, `${r.date} · ${r.days}일 ${r._err || ''}`);
  await ctx.close();
}

/* ══════ ④ 말일 결제일이 짧은 달에 건너뛰어지지 않는다 ══════ */
{
  const { ctx, p } = await at('2027-02-05T10:00:00+09:00');
  const r = await evOf(p, `(()=>{ ${SEED}
    S.cards[0].payDay=31; _discInvalidate(); save();
    const a=afterCardPay(); return {date:a&&a.date}; })()`);
  ok('31일 결제일이 2월엔 말일로 당겨진다', r.date === '2027-02-28', r.date || r._err || '없음');
  await ctx.close();
}

/* ══════ ⑤ 모자라면 그렇게 말한다 ══════ */
{
  const { ctx, p } = await at('2026-10-21T10:00:00+09:00');
  const r = await evOf(p, `(()=>{ ${SEED}
    accById('chk').balance=200000;
    S.fixed=S.fixed.filter(f=>f.kind!=='income');     // 들어올 돈이 없으면 카드값에서 모자란다
    _discInvalidate(); save(); renderAll();
    const a=afterCardPay();
    return {after:a&&a.after, cls:document.getElementById('h-after').className,
      text:document.getElementById('h-after').innerText.replace(/\\s+/g,' ').trim()}; })()`);
  ok('모자라면 마이너스로 나온다', r.after < 0, `${r.after} ${r._err || ''}`);
  ok('  경고색으로 바뀐다', /short/.test(r.cls || ''), r.cls || '');
  ok('  −가 두 번 붙지 않는다', !!r.text && !/−-|--/.test(r.text), r.text || '');
  await ctx.close();
}

/* ══════ ⑥ 보여줄 게 없으면 안 띄운다 ══════ */
{
  const { ctx, p } = await at('2026-10-21T10:00:00+09:00');
  const r = await evOf(p, () => {
    const out = {};
    const base = () => { S.tx = []; S.fixed = []; S.budgets = {}; S.settings.setupAt = todayStr(); };
    S.accounts = [{ id: 'chk', type: 'checking', name: '주거래', balance: 1000000, cur: 'KRW' }];
    S.cards = []; base(); _discInvalidate(); save(); renderAll();
    out.noCard = document.getElementById('h-after').innerHTML.length;
    S.cards = [{ id: 'c2', type: 'check', name: '체크', accountId: 'chk', tiers: [], exclCats: [], perks: [], prepays: [] }];
    _discInvalidate(); save(); renderAll();
    out.checkOnly = document.getElementById('h-after').innerHTML.length;
    S.accounts = []; S.cards = [{ id: 'c1', type: 'credit', name: '신용', accountId: 'chk', payDay: 14, tiers: [], exclCats: [], perks: [], prepays: [], open: { ym: '', pending: 0, perf: 0 } }];
    _discInvalidate(); save(); renderAll();
    out.noAcc = document.getElementById('h-after').innerHTML.length;
    return out;
  });
  ok('카드가 없으면 안 띄운다', r.noCard === 0, `${r.noCard} ${r._err || ''}`);
  ok('  체크카드만 있으면 (결제일이 없다)', r.checkOnly === 0, String(r.checkOnly));
  ok('  입출금 계좌가 없으면', r.noAcc === 0, String(r.noAcc));
  await ctx.close();
}

/* ══════ ⑦ 근거를 펼쳐 보여준다 ══════
   숫자 하나만 던지면 왜 그 값인지 알 수 없다. 이 앱의 다른 곳과 같은 원칙. */
{
  const { ctx, p, errs } = await at('2026-10-21T10:00:00+09:00');
  const r = await evOf(p, `(()=>{ ${SEED}
    openAfterCard();
    const t=document.getElementById('sheet').innerText;
    return {open:document.getElementById('modal').classList.contains('open'), text:t,
      hasStart:/지금 입출금 잔액/.test(t), hasIncome:/급여/.test(t), hasRent:/월세/.test(t),
      hasCard:/하나 MOVING/.test(t), hasNote:/실제와 다를 수 있어요/.test(t),
      bad:/NaN|undefined|−-/.test(t)}; })()`);
  ok('눌러서 근거를 펼칠 수 있다', r.open === true, r._err || '');
  ok('  시작 잔액부터 보여준다', r.hasStart === true);
  ok('  그 사이 수입·고정비·카드값을 항목별로', !!(r.hasIncome && r.hasRent && r.hasCard));
  ok('  추정이라는 사실을 밝힌다', r.hasNote === true);
  ok('  NaN·undefined 가 없다', r.bad === false, r.bad ? String(r.text).slice(0, 120) : '');
  ok('  오류 없음', errs.length === 0, errs[0] || '');
  await ctx.close();
}

/* ══════ ⑧ 평소 지출이 있으면 그 몫도 적는다 ══════ */
{
  const { ctx, p } = await at('2026-10-21T10:00:00+09:00');
  const r = await evOf(p, `(()=>{ ${SEED}
    // 현금 지출을 여러 달에 걸쳐 넣어 '평소 지출' 평균이 잡히게 한다
    ['2026-08','2026-09','2026-10'].forEach(m=>{
      for(let i=1;i<=10;i++)S.tx.push({id:m+'v'+i,type:'expense',date:m+'-0'+(i%9+1),
        amount:60000,cat:'식비',memo:'밥',payKind:'cash'});
    });
    _discInvalidate(); save();
    const plan=cashflowPlan(), a=afterCardPay(plan);
    openAfterCard();
    const t=document.getElementById('sheet').innerText;
    const m=t.match(/그 밖의 평소 지출[^\\n]*\\n?[^\\d−-]*[−-]?([\\d,]+)/);
    return {variable:plan.variable, shown:m?m[1]:'', after:a.after, text:t}; })()`);
  ok('평소 지출이 계산된다', r.variable > 0, `월 ${r.variable}원 ${r._err || ''}`);
  ok('  근거 화면에 그 몫이 적힌다', !!r.shown && r.shown !== '0', r.shown || '안 나옴');
  await ctx.close();
}

/* ══════ ⑨ 카드가 여럿이면 같은 날 것을 묶는다 ══════ */
{
  const { ctx, p } = await at('2026-10-21T10:00:00+09:00');
  const r = await evOf(p, `(()=>{ ${SEED}
    S.cards.push({id:'c2',type:'credit',name:'신한',accountId:'chk',payDay:14,tiers:[],exclCats:[],
      perks:[],prepays:[],open:{ym:'',pending:0,perf:0}});
    for(let i=1;i<=5;i++)S.tx.push({id:'s'+i,type:'expense',date:addDays(todayStr(),-i),amount:30000,
      cat:'쇼핑',memo:'구매',payKind:'card',payId:'c2',months:1,paidPortions:0});
    _discInvalidate(); save(); renderAll();
    const a=afterCardPay();
    return {n:a.cards.length, total:a.total,
      sum:a.cards.reduce((s,c)=>s+c.amt,0),
      text:document.getElementById('h-after').innerText.replace(/\\s+/g,' ').trim()}; })()`);
  ok('같은 날 결제되는 카드를 함께 센다', r.n === 2, `${r.n}장 ${r._err || ''}`);
  ok('  합계가 카드별 합과 맞는다', r.total === r.sum && r.total === 756000 + 150000, `${r.total}`);
  ok('  카드 이름을 함께 적는다', /하나 MOVING/.test(r.text || '') && /신한/.test(r.text || ''), r.text || '');
  await ctx.close();
}

await b.close();
