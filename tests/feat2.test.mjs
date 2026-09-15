/* A(제외: 서버 함수는 digest2.test.mjs) 이후로 이번 라운드에서 추가한
   B) 리밸런싱 실행 도우미(allocExecPlan)  C) 과거 패턴 기반 AI 예측(cashflowHistory/flowForecast) */
import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

/* ══════════ B) 리밸런싱 실행 도우미 ══════════ */

// ① 매수: 수수료 낮은 계좌부터 채운다
let r = await p.evaluate(() => {
  S.accounts=[
    {id:'chk',type:'checking',name:'주거래',balance:3000000,cur:'KRW'},
    {id:'sav',type:'saving',name:'적금',balance:3000000,cur:'KRW'},
    {id:'inv1',type:'invest',name:'국내주식',balance:1000000,cur:'KRW',invKind:'domestic',
      fees:{buy:0.015,sell:0.015,etc:0,min:0,from:'',to:''}},
    {id:'inv2',type:'invest',name:'ISA',balance:1000000,cur:'KRW',invKind:'tax',
      fees:{buy:0.5,sell:0.5,etc:0,min:0,from:'',to:''}},
  ];
  S.alloc={cash:20,safe:50,invest:30};
  _discInvalidate(); save();
  return allocExecPlan();
});
ok('drift 계산(투자 25%→목표 30%)', r.drift.some(x=>x.k==='invest'), JSON.stringify(r.rows.find(x=>x.k==='invest')));
ok('매수 방향 판정', r.side==='buy', r.side);
ok('수수료 낮은 계좌부터 매수', r.legs.length===1 && r.legs[0].a.id==='inv1', JSON.stringify(r.legs.map(l=>l.a.id)));
ok('매수 금액 = 부족분 전액', r.legs[0].krw===400000, String(r.legs[0].krw));
ok('수수료 = 400,000×0.015%', r.legs[0].feeKrw===60, String(r.legs[0].feeKrw));
ok('short 없음(현금은 무제한 가정)', r.short===0, String(r.short));

// ② 매도: 절세계좌(ISA)는 수수료가 더 싸도 맨 뒤로 미룬다 + 잔액만큼만 판다
r = await p.evaluate(() => {
  S.accounts=[
    {id:'chk',type:'checking',name:'주거래',balance:2000000,cur:'KRW'},
    {id:'sav',type:'saving',name:'적금',balance:2000000,cur:'KRW'},
    {id:'inv1',type:'invest',name:'국내주식',balance:300000,cur:'KRW',invKind:'domestic',
      fees:{buy:0.015,sell:0.015,etc:0,min:0,from:'',to:''}},
    {id:'inv2',type:'invest',name:'ISA',balance:3700000,cur:'KRW',invKind:'tax',
      fees:{buy:0.01,sell:0.01,etc:0,min:0,from:'',to:''}},  // 수수료가 국내주식보다 더 싸다
  ];
  S.alloc={cash:20,safe:20,invest:20};   // 투자 50%→목표 20%, 2,400,000원 매도 필요
  _discInvalidate(); save();
  return allocExecPlan();
});
ok('매도 방향 판정', r.side==='sell', r.side);
ok('국내주식부터, ISA는 뒤로', r.legs.length===2 && r.legs[0].a.id==='inv1' && r.legs[1].a.id==='inv2',
  JSON.stringify(r.legs.map(l=>l.a.id)));
ok('국내주식은 잔액만큼만(300,000)', r.legs[0].krw===300000, String(r.legs[0].krw));
ok('나머지는 ISA에서(2,100,000)', r.legs[1].krw===2100000, String(r.legs[1].krw));
ok('ISA 레그에 절세계좌 표시', r.legs[1].isTax===true);
ok('국내주식 레그는 절세계좌 아님', r.legs[0].isTax===false);
ok('수수료 합계', r.feeTotal===45+210, String(r.feeTotal));

// ③ 투자 계좌가 하나도 없는데 목표 비중이 있으면 → 매수할 곳이 없어 short>0
r = await p.evaluate(() => {
  S.accounts=[
    {id:'chk',type:'checking',name:'주거래',balance:900000,cur:'KRW'},
    {id:'sav',type:'saving',name:'적금',balance:100000,cur:'KRW'},
  ];
  S.alloc={cash:20,safe:20,invest:60};
  _discInvalidate(); save();
  return allocExecPlan();
});
ok('투자 계좌 없음 → short>0', r.short===600000, String(r.short));
ok('레그 없음(살 계좌가 없다)', r.legs.length===0);
ok('side는 매수로 판정', r.side==='buy', r.side);

// ④ 목표에 잘 맞으면(5%p 이내) 실행 계획이 필요 없다
r = await p.evaluate(() => {
  S.accounts=[
    {id:'chk',type:'checking',name:'주거래',balance:2000000,cur:'KRW'},
    {id:'sav',type:'saving',name:'적금',balance:5000000,cur:'KRW'},
    {id:'inv1',type:'invest',name:'국내주식',balance:3000000,cur:'KRW',invKind:'domestic',fees:{}},
  ];
  S.alloc={cash:20,safe:50,invest:30};
  _discInvalidate(); save();
  return allocExecPlan();
});
ok('5%p 이내면 drift 없음', r.drift.length===0, JSON.stringify(r.rows.map(x=>x.gap.toFixed(1))));

// ⑤ 모달 렌더 — 경고 문구·수수료 합계 표시
r = await p.evaluate(() => {
  S.accounts=[
    {id:'chk',type:'checking',name:'주거래',balance:2000000,cur:'KRW'},
    {id:'sav',type:'saving',name:'적금',balance:2000000,cur:'KRW'},
    {id:'inv1',type:'invest',name:'국내주식',balance:300000,cur:'KRW',invKind:'domestic',
      fees:{buy:0.015,sell:0.015,etc:0,min:0,from:'',to:''}},
    {id:'inv2',type:'invest',name:'ISA',balance:3700000,cur:'KRW',invKind:'tax',
      fees:{buy:0.01,sell:0.01,etc:0,min:0,from:'',to:''}},
  ];
  S.alloc={cash:20,safe:20,invest:20};
  _discInvalidate(); save();
  openAllocExecModal();
  const html=$('sheet').innerHTML; closeModal();
  return html;
});
ok('모달에 절세계좌 경고 표시', /중도 인출/.test(r));
ok('모달에 수수료 합계 표시', /수수료 합계/.test(r));
ok('모달에 매수·매도 배지 표시', /매도/.test(r));

// ⑥ 목표 미설정이면 toast만 뜨고 모달은 안 열린다
r = await p.evaluate(() => {
  S.alloc=null; save();
  $('toast').textContent='';
  const before=document.getElementById('modal').classList.contains('open');
  openAllocExecModal();
  const after=document.getElementById('modal').classList.contains('open');
  return {before,after,toast:$('toast').textContent};
});
ok('목표 없으면 모달 안 열림', r.before===false && r.after===false, JSON.stringify(r));

/* ══════════ C) 과거 패턴 기반 AI 예측 ══════════ */

// 6개월치 수입·지출 시드: 최근 3개월은 지출이 이전 3개월보다 뚜렷이 늘어남 + 반복되는 비고정 지출(경조사비)
r = await p.evaluate(() => {
  S.accounts=[]; S.cards=[]; S.fixed=[]; S.tx=[]; S.invLogs=[]; S.flowForecast=null;
  for(let i=1;i<=6;i++){
    const d=new Date(); d.setMonth(d.getMonth()-i);
    const ym=`${d.getFullYear()}-${pad(d.getMonth()+1)}`;
    const expBase = i<=3 ? 2200000 : 1600000;  // 최근(i 작을수록 최근) 3개월이 더 높음
    S.tx.push({id:uid(),type:'income',date:ym+'-25',amount:3000000,cat:'급여',memo:'월급',payKind:'account',payId:'x'});
    S.tx.push({id:uid(),type:'expense',date:ym+'-10',amount:expBase,cat:'식비',memo:'생활비',payKind:'cash'});
    if(i%2===0)S.tx.push({id:uid(),type:'expense',date:ym+'-15',amount:150000,cat:'경조사비',memo:'축의금',payKind:'cash'});
  }
  _discInvalidate(); save();
  return cashflowHistory();
});
ok('6개월 데이터 인식', r.months===6, String(r.months));
ok('지출 증가 추세 감지', r.trendPct>0, r.trendPct+'%');
ok('비정기 반복 지출 감지(경조사비)', r.irregular.some(x=>x.cat==='경조사비'&&x.count===3), JSON.stringify(r.irregular));
ok('고정 등록된 카테고리는 반복지출에서 제외', !r.irregular.some(x=>x.cat==='식비'));

// 데이터 1개월 이하면 예측 불가 안내만
r = await p.evaluate(() => { S.tx=[]; _discInvalidate(); save(); return cashflowHistory(); });
ok('데이터 부족 시 0개월', r.months===0);

// AI 호출 — gemini 모킹, 원본 거래가 아니라 요약만 넘기는지 확인
r = await p.evaluate(async () => {
  // 다시 6개월 시드
  S.tx=[];
  for(let i=1;i<=6;i++){
    const d=new Date(); d.setMonth(d.getMonth()-i);
    const ym=`${d.getFullYear()}-${pad(d.getMonth()+1)}`;
    S.tx.push({id:uid(),type:'income',date:ym+'-25',amount:3000000,cat:'급여',memo:'월급',payKind:'account',payId:'x'});
    S.tx.push({id:uid(),type:'expense',date:ym+'-10',amount:2000000,cat:'식비',memo:'생활비',payKind:'cash'});
  }
  S.settings.gemini='test-key'; _discInvalidate(); save();
  window.gemini = async (prompt) => { window.__fcPrompt=prompt; return '다음 달 예상: 수입 300만원, 지출 200만원\n\n- 큰 변화 없어요\n\n다음 달 준비할 것: 여유자금 확보'; };
  openFlowAI();
  await flowForecast();
  const out=$('flow-fc-out').innerHTML;
  closeModal();
  return {out, prompt: window.__fcPrompt, saved: S.flowForecast};
});
ok('예측 결과 렌더', /다음 달 예상/.test(r.out), r.out.slice(0,60));
ok('결과 저장(S.flowForecast)', !!r.saved && r.saved.months===6, JSON.stringify(r.saved && {months:r.saved.months}));
ok('프롬프트에 월별 요약 포함', r.prompt.includes('월별수입지출') && r.prompt.includes('지출추세'));
ok('프롬프트에 개별 거래(memo) 미포함', !r.prompt.includes('생활비') && !r.prompt.includes('memo'),
  '프롬프트 길이 '+r.prompt.length+'자');

// 다시 열면 저장된 예측이 바로 보이는지
r = await p.evaluate(() => { openFlowAI(); const html=$('sheet').innerHTML; closeModal(); return html; });
ok('다시 열면 저장된 예측 표시', /다시 예측받기/.test(r) && /다음 달 예상/.test(r));

// 데이터 부족하면 버튼 비활성 + 안내문
r = await p.evaluate(() => {
  S.tx=[]; S.flowForecast=null; _discInvalidate(); save();
  openFlowAI();
  const disabled=$('flow-fc-btn').hasAttribute('disabled');
  const html=$('flow-fc-out').innerHTML;
  closeModal();
  return {disabled, html};
});
ok('기록 부족하면 버튼 비활성', r.disabled===true);
ok('기록 부족 안내 문구', /2개월 이상/.test(r.html));

console.log(errs.length? '❌ 콘솔/페이지 오류:\n'+errs.join('\n') : '✅ 오류 없음');
if(errs.length)process.exitCode=1;
await b.close();
