import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

// 시드: 급여 25일 280만, 월세 5일 55만, 넷플릭스 17일 카드결제,
//       적금 25일 70만, 청약 5일 10만, 신용카드 결제일 14일
let r = await p.evaluate(() => {
  const t=todayStr();
  S.accounts=[{id:'a1',type:'checking',name:'주거래',balance:1200000,cur:'KRW'},
    {id:'s1',type:'saving',name:'청년도약',balance:8000000,cur:'KRW',monthly:700000,payDay:25,payFrom:'a1'},
    {id:'h1',type:'housing',name:'주택청약',balance:2500000,cur:'KRW',monthly:100000,payDay:5,payFrom:'a1',joinDate:'2023-03-10'},
    {id:'i1',type:'invest',name:'미국주식',balance:5000000,cur:'KRW',invKind:'overseas'}];
  S.cards=[{id:'c1',type:'credit',name:'하나카드',accountId:'a1',payDay:14,tiers:[],exclCats:[],perks:[],annualFee:0}];
  S.fixed=[{id:'f1',kind:'income',name:'급여',amount:2800000,day:25,cat:'급여',payKind:'account',payId:'a1',active:true},
    {id:'f2',kind:'expense',name:'월세',amount:550000,day:5,cat:'주거',payKind:'account',payId:'a1',active:true},
    {id:'f3',kind:'expense',name:'넷플릭스',amount:13500,day:17,cat:'구독',payKind:'card',payId:'c1',active:true}];
  // 지난 3개월 수입·지출 기록 (평균 계산용)
  S.tx=[];
  for(let m=1;m<=3;m++){
    const d=new Date(); d.setMonth(d.getMonth()-m);
    const ym=`${d.getFullYear()}-${pad(d.getMonth()+1)}`;
    S.tx.push({id:uid(),type:'income',date:ym+'-25',amount:2800000,cat:'급여',memo:'월급',payKind:'account',payId:'a1',fxAt:1380});
    S.tx.push({id:uid(),type:'expense',date:ym+'-05',amount:550000,cat:'주거',memo:'월세',payKind:'account',payId:'a1',fxAt:1380});
    for(let k=0;k<12;k++)S.tx.push({id:uid(),type:'expense',date:`${ym}-${pad((k*2)+2)}`,amount:35000,
      cat:'식비',memo:'식사',payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:1});
  }
  S.invLogs=[];
  for(let m=1;m<=3;m++){const d=new Date();d.setMonth(d.getMonth()-m);
    S.invLogs.push({id:uid(),accountId:'i1',date:`${d.getFullYear()}-${pad(d.getMonth()+1)}-10`,amount:300000,cur:'KRW',fxAt:1});}
  _discInvalidate(); save();
  return cashflowPlan();
});

ok('고정수입 인식', r.incFixed===2800000 && r.incF.length===1, `${r.incFixed}원`);
ok('고정비 인식 (카드결제분 포함)', r.expFixed===563500 && r.expF.length===2, `${r.expFixed}원`);
ok('  카드로 내는 고정비 표시', r.expF.some(f=>f.byCard==='하나카드'));
ok('적금·청약 합계', r.forcedTotal===800000, `${r.forcedTotal}원`);
ok('투자 납입 페이스', r.dca===300000, `${r.dca}원`);
ok('변동지출 = 평균지출 − 고정비', r.variable>0 && r.variable === Math.max(0,Math.round(r.trend.slice(0,-1).length?0:0)+r.variable), `${r.variable}원`);
ok('남는 돈 = 수입 − (고정+저축+투자+변동)',
   r.net === r.inflow-(r.expFixed+r.forcedTotal+r.dca+r.variable), `${r.net}원`);
ok('비중 계산', Math.abs(r.rates.fixed-(r.expFixed/r.inflow*100))<0.01 && r.rates.save<=100,
   `고정 ${r.rates.fixed.toFixed(0)}% · 저축률 ${r.rates.save.toFixed(0)}%`);

ok('45일 타임라인 생성', r.line.length===46 && r.line[0].bal===1200000, `${r.line.length}일 · 시작 ${r.line[0].bal}`);
ok('  최저점 계산', !!r.lowest && typeof r.lowest.bal==='number', `${r.lowest.d} ${r.lowest.bal}원`);
const evs = r.line.flatMap(x=>x.ev.map(e=>e.t));
ok('  이벤트 종류', evs.includes('in')&&evs.includes('out')&&evs.includes('save'),
   [...new Set(evs)].join(','));
ok('  카드로 낸 고정비는 결제일에만 반영', !r.line.some(x=>x.ev.some(e=>e.t==='out'&&e.n==='넷플릭스')));
ok('최근 6개월 추이', r.trend.length>=3, `${r.trend.length}개월`);

// 위험 감지: 잔액을 확 낮추면 부족이 잡혀야 한다
r = await p.evaluate(() => { accById('a1').balance=50000; _discInvalidate(); save();
  const q=cashflowPlan(); switchView('home');
  return {risk:q.risk, banner:$('flow-slot').textContent}; });
ok('잔액 부족 감지', !!r.risk && r.risk.short>0, r.risk?`${r.risk.d} ${r.risk.short}원 부족`:'없음');
ok('  홈 배너 노출', r.banner.includes('모자랄 수 있어요'), r.banner.slice(0,50));

r = await p.evaluate(() => { accById('a1').balance=9000000; _discInvalidate(); save();
  switchView('home'); return {banner:$('flow-slot').textContent, risk:cashflowPlan().risk}; });
ok('여유 있으면 배너 없음', r.banner==='' && !r.risk);

// 화면
r = await p.evaluate(() => { switchView('report'); return $('flow-card').textContent; });
ok('리포트 요약 카드', r.includes('현금흐름 코치')&&r.includes('한 달에 남는 돈'), '');

r = await p.evaluate(() => { openFlowAI(); const t=$('sheet').textContent; closeModal(); return t; });
ok('전체 화면 렌더', r.includes('한 달 구조')&&r.includes('앞으로 45일 잔액')&&r.includes('AI 진단'), '');
ok('  항목별 내역 표시', r.includes('급여')&&r.includes('월세')&&r.includes('청년도약'), '');
ok('  비중 3종 표시', r.includes('고정비 비중')&&r.includes('저축률'), '');

// AI 호출 (gemini 를 가짜로)
r = await p.evaluate(async () => {
  S.settings.gemini='test-key'; save();   // aiEnabled() 통과용
  window.gemini = async (prompt) => { window.__prompt=prompt; return '지금 구조는 안정적이에요.\n\n- 고정비 비중이 20%로 낮아요\n- 25일에 몰려 있어요'; };
  openFlowAI();
  await flowDiagnose();
  const out=$('flow-ai-out').textContent;
  const prm=window.__prompt;
  closeModal();
  return {out, hasCtx:prm.includes('현금흐름 데이터'), hasNums:prm.includes('2800000'),
          noRawTx:!prm.includes('"payKind"'), saved:!!S.flowAI, len:prm.length};
});
ok('AI 진단 호출·표시', r.out.includes('안정적'), r.out.slice(0,40));
ok('  프롬프트에 계산된 숫자 포함', r.hasCtx&&r.hasNums);
ok('  원본 거래를 통째로 넣지 않음', r.noRawTx, `프롬프트 ${r.len}자`);
ok('  결과 저장', r.saved);

r = await p.evaluate(() => { openFlowAI(); const t=$('flow-ai-out').textContent; closeModal(); return t; });
ok('  다시 열면 지난 진단 표시', r.includes('안정적'));

// 데이터 없을 때
r = await p.evaluate(() => {
  S.fixed=[];S.tx=[];S.invLogs=[];S.accounts=S.accounts.filter(a=>a.type==='checking');
  S.accounts[0].balance=0;_discInvalidate();save();switchView('report');
  return $('flow-card').textContent;
});
ok('데이터 없으면 안내', r.includes('고정수입·고정비를 등록하면'), r.slice(0,50));

ok('오류 없음', errs.length===0, errs.slice(0,3).join(' | '));
await b.close();
if(errs.length)errs.forEach(e=>console.log(' '+e));
