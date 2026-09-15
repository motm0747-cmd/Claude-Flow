import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

const D=(off)=>{const d=new Date();d.setDate(d.getDate()+off);
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`};

let r = await p.evaluate(([past,soon,far]) => {
  S.accounts=[
    {id:'a1',type:'checking',name:'주',balance:20000000,cur:'KRW'},
    {id:'k1',type:'invest',name:'국내주식',balance:5000000,cur:'KRW',invKind:'domestic',
      fees:{buy:0.015,sell:0.015,etc:0.0036,min:0,from:'',to:''},fxPref:{spread:0,pref:0,from:'',to:''}},
    {id:'o1',type:'invest',name:'미국주식',balance:8000,cur:'USD',invKind:'overseas',
      fees:{buy:0.07,sell:0.09,etc:0,min:0.01,from:'',to:soon},
      fxPref:{spread:1.0,pref:95,from:'',to:far}},
    {id:'o2',type:'invest',name:'우대끝난계좌',balance:1000,cur:'USD',invKind:'overseas',
      fees:{buy:0.25,sell:0.25,etc:0,min:0,from:'',to:past},
      fxPref:{spread:1.0,pref:90,from:'',to:past}},
    {id:'t1',type:'invest',name:'ISA',balance:3000000,cur:'KRW',invKind:'tax',taxKind:'isa',yearCap:20000000,
      fees:{buy:0.01,sell:0.01,etc:0,min:0,from:'',to:''},fxPref:{spread:0,pref:0,from:'',to:''}}];
  S.invLogs=[{id:'l1',accountId:'t1',date:todayStr(),amount:4800000,cur:'KRW',fxAt:1}];
  S.cards=[];S.tx=[];_discInvalidate();save();
  const o1=accById('o1'), o2=accById('o2'), k1=accById('k1');
  return {
    kinds:S.accounts.filter(a=>a.type==='invest').map(a=>invKindOf(a)),
    fxOn:invFxRate(o1), fxOff:invFxRate(o2),
    buyK:tradeCost(k1,1000000,'buy'), sellK:tradeCost(k1,1000000,'sell'),
    buyO:tradeCost(o1,1000,'buy'), minO:tradeCost(o1,5,'buy'),
    alerts:invPeriodAlerts().map(x=>({name:x.a.name,label:x.label,kind:x.kind})),
    yearPaid:invYearPaid(accById('t1')),
    stExpired:periodState('',past), stSoon:periodState('',soon), stNone:periodState('',''),
    stBefore:periodState(far,''),
  };
}, [D(-10), D(14), D(200)]);

ok('계좌 종류 분류', JSON.stringify(r.kinds)==='["domestic","overseas","overseas","tax"]', r.kinds.join(','));

// 환전: 기준 1380, 스프레드 1%, 우대 95% → 1380*(1+0.01*0.05)=1380.69
ok('환전 우대 적용 환율', Math.abs(r.fxOn.rate-1380.69)<0.02, `${r.fxOn.rate}원 (우대없음 ${r.fxOn.noPref})`);
ok('  우대 없을 때 1393.8', Math.abs(r.fxOn.noPref-1393.8)<0.02, `${r.fxOn.noPref}원`);
ok('  기간 지나면 우대 0으로 계산', r.fxOff.applied===0 && Math.abs(r.fxOff.rate-r.fxOff.noPref)<0.01,
   `적용 ${r.fxOff.applied}% · ${r.fxOff.rate}원`);

// 국내 100만원 매수: (0.015+0.0036)% = 0.0186% → 186원
ok('국내 매수 수수료', r.buyK.fee===186, `${r.buyK.fee}원`);
ok('  매도도 동일', r.sellK.fee===186, `${r.sellK.fee}원`);
// 해외 $1000 매수: 0.07% = $0.70
ok('해외 매수 수수료', Math.abs(r.buyO.fee-0.7)<0.001, `$${r.buyO.fee}`);
// $5 매수 → 0.07% = $0.0035 이지만 최소 $0.01
ok('  최소 수수료 적용', r.minO.fee===0.01, `$${r.minO.fee}`);

ok('기간 상태 판정', r.stExpired.state==='expired'&&r.stSoon.state==='active'
   &&r.stNone.state==='none'&&r.stBefore.state==='before',
   `${r.stExpired.state}/${r.stSoon.state}/${r.stNone.state}/${r.stBefore.state}`);
ok('  만료 D+10', r.stExpired.days===10, String(r.stExpired.days));
ok('  임박 D-14', r.stSoon.days===14, String(r.stSoon.days));

ok('만료·임박 알림 수집', r.alerts.length===3, JSON.stringify(r.alerts));
ok('  만료된 것 표시', r.alerts.some(x=>x.name==='우대끝난계좌'&&x.kind==='expired'));
ok('  임박한 것 표시', r.alerts.some(x=>x.name==='미국주식'&&x.kind==='soon'&&x.label==='수수료 우대'));
ok('절세 계좌 올해 납입액', r.yearPaid===4800000, String(r.yearPaid));

// ── 화면 ──
r = await p.evaluate(()=>{switchView('assets');return $('inv-alert').textContent+'|'+$('list-invest').textContent});
ok('자산 화면에 만료 배너', r.includes('끝났어요')&&r.includes('뒤 끝나요'), '');
ok('  목록에 종류 표시', r.includes('국내 주식')&&r.includes('해외 주식')&&r.includes('절세 계좌'));
ok('  환전우대·한도 표시', r.includes('환전 95%')&&r.includes('올해 한도 24%'), '');

// ── 거래 비용 계산기 ──
r = await p.evaluate(()=>{
  openTradeCostModal('o1');
  $('tc-amt').value=1000; tcHint();
  const buy=$('tc-out').textContent;
  tcSetSide('both'); const both=$('tc-out').textContent;
  closeModal(); return {buy,both};
});
ok('계산기: 매수 비용', r.buy.includes('$0.70'), r.buy.slice(0,50));
ok('  환전 비용도 포함', r.buy.includes('환전 비용'), '');
ok('  왕복 손익분기 계산', r.both.includes('본전이 되려면')&&r.both.includes('0.160%'), r.both.match(/약 [\d.]+%/)?.[0]||'');

// ── 계좌 모달 ──
r = await p.evaluate(()=>{
  openAccModal('o1');
  const fxShown=$('ac-fx-wrap').style.display!=='none';
  const taxShown=$('ac-tax-wrap').style.display!=='none';
  const hint=$('ac-fx-hint').textContent;
  closeModal(); return {fxShown,taxShown,hint};
});
ok('해외 계좌 → 환전 칸 노출', r.fxShown&&!r.taxShown);
ok('  우대 효과 미리보기', r.hint.includes('이득이에요'), r.hint.slice(0,70));

r = await p.evaluate(()=>{ openAccModal('t1');
  const t=$('ac-tax-wrap').style.display!=='none'; const c=$('ac-yearcap').value; closeModal(); return {t,c}; });
ok('절세 계좌 → 한도 칸 노출', r.t&&r.c==='20000000', `한도 ${r.c}`);

// ── 저장 왕복 ──
r = await p.evaluate(()=>{
  openAccModal('k1');
  $('ac-fbuy').value='0.011'; $('ac-fsell').value='0.012'; $('ac-fetc').value='0.004';
  $('ac-ffrom').value='2026-01-01'; $('ac-fto').value='2026-12-31';
  saveAcc('k1','invest');
  const a=accById('k1');
  return {f:a.fees, kind:a.invKind, cost:tradeCost(a,1000000,'buy').fee};
});
ok('설정 저장 왕복', r.f.buy===0.011&&r.f.sell===0.012&&r.f.etc===0.004&&r.f.to==='2026-12-31', JSON.stringify(r.f));
ok('  저장값으로 재계산', r.cost===150, `${r.cost}원`);

// ── 납입 모달에 우대 환율 반영 ──
r = await p.evaluate(()=>{
  openInvLogModal('o1');
  const pre=$('il-fx').value;
  $('il-krw').value=1000000; ilHint();
  const hint=$('il-hint').textContent;
  closeModal(); return {pre,hint};
});
ok('납입 모달 환율 = 우대 적용값', Math.abs(+r.pre-1380.69)<0.02, r.pre);
ok('  우대 이득 표시', r.hint.includes('더 받았어요'), r.hint.slice(-46));

ok('오류 없음', errs.length===0, errs.slice(0,3).join(' | '));
await b.close();
if(errs.length)errs.forEach(e=>console.log(' '+e));
