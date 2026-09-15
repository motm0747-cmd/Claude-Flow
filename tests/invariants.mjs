import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:1280,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

const r = await p.evaluate(() => {
  const out = {};
  const seed = () => {
    S.accounts=[{id:'a1',type:'checking',name:'주',balance:1000000,cur:'KRW'},
                {id:'a2',type:'checking',name:'부',balance:500000,cur:'KRW'},
                {id:'a3',type:'invest',name:'투자',balance:1000,cur:'USD'}];
    S.cards=[{id:'c1',type:'check',name:'체크',accountId:'a1',perks:[],exclCats:[],tiers:[],annualFee:0},
             {id:'c2',type:'credit',name:'신용',accountId:'a1',payDay:14,perks:[],exclCats:[],tiers:[],annualFee:0}];
    S.tx=[]; S.fixed=[]; S.invLogs=[]; S.debts=[]; S.goals=[]; S.wish=[]; S.recon=[];
    _discInvalidate();
  };

  // ① 추가 → 삭제 하면 잔액이 정확히 원복되는가
  seed();
  const snap = () => S.accounts.map(a=>a.balance).join('|');
  const s0 = snap();
  const cases = [
    {type:'expense',payKind:'account',payId:'a1',amount:12345},
    {type:'expense',payKind:'card',payId:'c1',amount:6789},     // 체크 → 즉시 차감
    {type:'expense',payKind:'card',payId:'c2',amount:50000},    // 신용 → 결제 전엔 무변동
    {type:'expense',payKind:'cash',payId:'',amount:3000},
    {type:'income',payKind:'account',payId:'a2',amount:777777},
    {type:'transfer',fromId:'a1',toId:'a2',amount:100000},
    {type:'transfer',fromId:'a1',toId:'a3',amount:130000},      // 원화 → 달러(환전)
  ];
  out.roundTrip = [];
  for (const c of cases) {
    const t={id:uid(),date:todayStr(),cat:'식비',memo:'t',fxAt:fxRate(),...c};
    S.tx.push(t); applyBalance(t,1);
    const mid = snap();
    applyBalance(t,-1); S.tx=S.tx.filter(x=>x.id!==t.id);
    out.roundTrip.push({kind:c.type+'/'+(c.payKind||c.toId), changed: mid!==s0, restored: snap()===s0});
  }

  // ② 수정(금액 변경) 후에도 잔액이 어긋나지 않는가
  seed();
  const t2={id:'x1',type:'expense',date:todayStr(),amount:10000,cat:'식비',memo:'m',
            payKind:'account',payId:'a1',fxAt:fxRate()};
  S.tx.push(t2); applyBalance(t2,1);
  const afterAdd = accById('a1').balance;
  applyBalance(t2,-1); Object.assign(t2,{amount:30000}); applyBalance(t2,1);
  out.edit = { afterAdd, afterEdit: accById('a1').balance,
               expected: 1000000-30000, addExpected: 1000000-10000 };

  // ③ 계좌를 지웠을 때 남은 참조가 앱을 깨뜨리지 않는가
  seed();
  const t3={id:'x2',type:'transfer',date:todayStr(),amount:5000,fromId:'a1',toId:'a2',fxAt:fxRate()};
  S.tx.push(t3); applyBalance(t3,1);
  S.accounts=S.accounts.filter(a=>a.id!=='a2');          // 받는 계좌만 삭제
  let threw='';
  try{ applyBalance(t3,-1); totals(thisYM()); netAssets(); renderAll(); }
  catch(e){ threw=e.message }
  out.orphan = { threw, balance: accById('a1').balance };

  // ④ 0원·음수·거대 금액 방어
  out.guard = { zero: checkAmt(0), neg: checkAmt(-100), huge: checkAmt(2e9), nan: checkAmt(NaN), fine: checkAmt(1000) };

  // ⑤ 월 경계: 말일 고정지출이 짧은 달에 사라지지 않는가
  out.monthEnd = (()=>{
    const feb = '2026-02';
    const d = daysIn(feb);
    return { daysInFeb: d, ok: d===28 };
  })();

  // ⑥ 대량 데이터 렌더 성능
  seed();
  for(let i=0;i<2000;i++){
    const t={id:'b'+i,type:'expense',date:`2026-0${(i%9)+1}-1${i%9}`,amount:(i%50+1)*1000,
      cat:EXP_CATS[i%EXP_CATS.length][1],memo:'대량'+i,payKind:'cash',payId:'',fxAt:1380};
    S.tx.push(t);
  }
  _discInvalidate();
  const t0=performance.now(); renderAll(); const ms=performance.now()-t0;
  out.perf = { n:S.tx.length, ms: Math.round(ms) };
  return out;
});

r.roundTrip.forEach(c=>{
  ok(`잔액 원복: ${c.kind}`, c.restored, c.restored?'':'❌ 어긋남');
});
ok('신용카드는 결제 전 잔액 무변동', r.roundTrip[2].changed===false);
ok('체크카드는 즉시 차감', r.roundTrip[1].changed===true);
ok('수정 후 잔액 정확', r.edit.afterEdit===r.edit.expected && r.edit.afterAdd===r.edit.addExpected,
   `${r.edit.afterEdit} (기대 ${r.edit.expected})`);
ok('삭제된 계좌를 참조해도 안 죽음', r.orphan.threw==='', r.orphan.threw);
ok('금액 방어: 0 거부', r.guard.zero===false);
ok('  음수 거부', r.guard.neg===false);
ok('  10억 초과 거부', r.guard.huge===false);
ok('  NaN 거부', r.guard.nan===false);
ok('  정상 금액 통과', r.guard.fine===true);
ok('2월 일수 계산', r.monthEnd.ok, String(r.monthEnd.daysInFeb));
ok(`대량 렌더 성능 (${r.perf.n}건)`, r.perf.ms<800, r.perf.ms+'ms');
ok('오류 없음', errs.length===0, errs.slice(0,3).join(' | '));
await b.close();
if(errs.length) errs.forEach(e=>console.log(' '+e));
