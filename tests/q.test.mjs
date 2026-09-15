import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

// ══ ① 결제수단 추천 ══
let r = await p.evaluate(() => {
  const ps=PERK_PRESETS[0], YM=thisYM(), pm=prevYM(YM);
  S.accounts=[{id:'a1',type:'checking',name:'주',balance:9000000,cur:'KRW'}];
  S.cards=[
    {id:'c1',type:'credit',name:'하나 3일2배',accountId:'a1',payDay:14,tiers:ps.tiers.slice(),target:ps.tiers[0],
     exclCats:[],annualFee:0,perks:ps.perks.map(x=>({...x,id:uid()}))},
    {id:'c2',type:'check',name:'토스 체크',accountId:'a1',exclCats:[],tiers:[],annualFee:0,
     perks:[{id:'p9',name:'전 가맹점 1%',cat:'전체',merchants:'',kind:'percent',value:1,boost:0,
             streakDays:0,via:'',minAmt:0,capM:5000,maxCnt:0,tier:1,bill:false}]}];
  // 전월 실적 충족
  S.tx=[{id:'pm',type:'expense',date:pm+'-10',amount:700000,cat:'쇼핑',memo:'전월',payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:0}];
  _discInvalidate();
  return {
    ai:   cardPick({amount:29000,cat:'구독',memo:'Claude Pro'}),
    food: cardPick({amount:8000,cat:'식비',memo:'맥도날드'}),
    plain:cardPick({amount:50000,cat:'쇼핑',memo:'동네가게'}),
    simple:cardPick({amount:50000,cat:'쇼핑',memo:'쿠팡',via:'simple'}),
  };
});
// 10,000(AI 한도) + 145(기본적립 0.5%) — 기본 적립은 영역 적립에 겹쳐 붙는다
ok('AI 구독 → 하나카드 추천', r.ai[0].card.name==='하나 3일2배' && r.ai[0].gain===10145,
   `${r.ai[0].card.name} +${r.ai[0].gain}`);
ok('  이유에 혜택명 포함', r.ai[0].from[0].p.name==='AI 구독');
// 4,000(푸드 50%) + 40(기본적립 0.5%)
ok('푸드 → 하나카드 (50%, 한도 5천)', r.food[0].card.name==='하나 3일2배'&&r.food[0].gain===4040,
   `+${r.food[0].gain}`);
ok('혜택 없는 결제 → 체크카드가 유리', r.plain[0].card.name==='토스 체크'&&r.plain[0].gain===500,
   `${r.plain[0].card.name} +${r.plain[0].gain}`);
ok('  하나카드는 기본적립만', r.plain.find(x=>x.card.id==='c1').gain===250, `+${r.plain.find(x=>x.card.id==='c1').gain}`);
ok('간편결제 → 하나카드 1.5%', r.simple[0].card.name==='하나 3일2배'&&r.simple[0].gain===750,
   `${r.simple[0].card.name} +${r.simple[0].gain}`);

// 한도를 다 채우면 추천이 바뀌는가
r = await p.evaluate(() => {
  const YM=thisYM();
  S.tx.push({id:'x1',type:'expense',date:`${YM}-05`,amount:30000,cat:'구독',memo:'ChatGPT',
    payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:0});
  _discInvalidate();
  return cardPick({amount:29000,cat:'구독',memo:'Claude Pro'});
});
ok('AI 한도 소진 후 → 하나카드 이득 급감', r[0].card.name==='토스 체크', `1위 ${r[0].card.name} +${r[0].gain}`);
ok('  막힌 이유 표시', r.find(x=>x.card.id==='c1').blocked.some(b=>b.p.name==='AI 구독'));

// ══ ② 연속 스트릭 ══
r = await p.evaluate(() => {
  const t=todayStr();
  const mk=(d,memo)=>({id:uid(),type:'expense',date:d,amount:10000,cat:'식비',memo,
    payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:0});
  const out={};
  const set=dates=>{S.tx=S.tx.filter(x=>x.id==='pm').concat(dates.map(d=>mk(d,'동네백반')));_discInvalidate();};
  set([addDays(t,-2),addDays(t,-1)]);
  out.ready=cardStreaks(cardById('c1')).find(s=>s.p.name==='국내외 가맹점 기본적립');
  set([addDays(t,-1)]);
  out.building=cardStreaks(cardById('c1')).find(s=>s.p.name==='국내외 가맹점 기본적립');
  set([addDays(t,-2),addDays(t,-1),t]);
  out.done=cardStreaks(cardById('c1')).find(s=>s.p.name==='국내외 가맹점 기본적립');
  set([addDays(t,-5)]);
  out.none=cardStreaks(cardById('c1')).find(s=>s.p.name==='국내외 가맹점 기본적립');
  set([t]);
  out.partial=cardStreaks(cardById('c1')).find(s=>s.p.name==='국내외 가맹점 기본적립');
  set([addDays(t,-2),addDays(t,-1)]);
  out.actionable=streakActionable().length;
  return out;
});
ok('어제까지 2일 → 오늘 1건이면 달성', r.ready.state==='ready'&&r.ready.rYst===2, r.ready.state);
ok('어제만 → 진행 중', r.building.state==='building'&&r.building.left===1, `${r.building.state}/${r.building.left}일 더`);
ok('오늘 포함 3일 → 달성', r.done.state==='done'&&r.done.rToday===3, r.done.state);
ok('5일 전뿐 → 끊김', r.none.state==='none', r.none.state);
ok('오늘만 → 2일 더 필요', r.partial.state==='partial'&&r.partial.left===2, `${r.partial.state}/${r.partial.left}`);
ok('오늘 움직일 것 수집', r.actionable>=1, String(r.actionable));

// 달 경계에서 연속이 끊기지 않는가
r = await p.evaluate(() => {
  const YM=thisYM();
  const first=`${YM}-01`, m1=addDays(first,-1), m2=addDays(first,-2);
  S.tx=[{id:'pm',type:'expense',date:prevYM(YM)+'-10',amount:700000,cat:'쇼핑',memo:'전월',payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:0}];
  [m2,m1,first].forEach(d=>S.tx.push({id:uid(),type:'expense',date:d,amount:10000,cat:'식비',memo:'백반',
    payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:0}));
  _discInvalidate();
  const e=perkEstimates(cardById('c1'),YM).find(x=>x.p.name==='국내외 가맹점 기본적립');
  return {boostN:e.boostN,n:e.n};
});
ok('달을 넘긴 연속도 인정', r.boostN===1&&r.n===1, `이번달 ${r.n}건 중 ${r.boostN}건 2배`);

// ══ ③ 투자 실질 수익률 ══
r = await p.evaluate(() => {
  S.accounts.push({id:'o1',type:'invest',name:'미국주식',balance:8000,cur:'USD',invKind:'overseas',
    fees:{buy:0.07,sell:0.09,etc:0,min:0,from:'',to:''},fxPref:{spread:1.0,pref:95,from:'',to:''}});
  S.invLogs=[{id:'l1',accountId:'o1',date:todayStr(),amount:7000,cur:'USD',fxAt:1380}];
  _discInvalidate(); save();
  const perf=invPerf(accById('o1'));
  switchView('assets');
  return {perf, html:$('invperf-card').textContent};
});
// 납입 7000×1380 = 9,660,000 / 현재 8000×1380 = 11,040,000 → 명목 +1,380,000
// 환전비용 9,660,000×1%×(1−0.95)=4,830 / 매수 9,660,000×0.07%=6,762
ok('명목 손익', r.perf.nominal===1380000, `${r.perf.nominal}원`);
ok('  환전 비용 추정', r.perf.fxCost===4830, `${r.perf.fxCost}원`);
ok('  매수 수수료 추정', r.perf.feeCost===6762, `${r.perf.feeCost}원`);
ok('  실질 = 명목 − 비용', r.perf.real===1380000-4830-6762, `${r.perf.real}원`);
ok('  화면에 명목·실질 표시', r.html.includes('명목 손익')&&r.html.includes('실질 손익'));
ok('  비용 내역 표시', r.html.includes('환전')&&r.html.includes('수수료'));

// ══ ⑤ 환율 타이밍 ══
r = await p.evaluate(() => {
  const t=todayStr();
  S.settings.fx.hist={};
  for(let i=120;i>=1;i--) fxRecord(1300+((i*7)%160), addDays(t,-i));
  S.settings.fx.usdkrw=1310; fxRecord(1310); save();
  const st=fxStats(6);
  return {st, verdict:fxVerdict(st), spark:fxSpark(st).length>50};
});
ok('환율 기록 축적', r.st.enough&&r.st.n>100, `${r.st.n}일`);
ok('  현재값 위치(퍼센타일)', r.st.pct<=20, `하위 ${r.st.pct}%`);
ok('  낮은 편 판정', r.verdict.txt.includes('낮은 편'), r.verdict.txt.replace(/<[^>]*>/g,''));
ok('  스파크라인 생성', r.spark);

r = await p.evaluate(() => { S.settings.fx.usdkrw=1450; save(); const st=fxStats(6); return fxVerdict(st).txt; });
ok('  높은 편 판정', r.includes('높은 편'), r.replace(/<[^>]*>/g,''));
r = await p.evaluate(() => { S.settings.fx.hist={}; save(); return fxVerdict(fxStats(6)).txt; });
ok('  데이터 적으면 판단 보류', r.includes('모으는 중'), r);

// ══ 화면 ══
r = await p.evaluate(() => {
  const t=todayStr();
  S.tx=S.tx.filter(x=>x.id==='pm');
  [addDays(t,-2),addDays(t,-1)].forEach(d=>S.tx.push({id:uid(),type:'expense',date:d,amount:10000,
    cat:'식비',memo:'백반',payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:0}));
  _discInvalidate(); save();
  switchView('cards'); const cards=$('streak-card').textContent;
  switchView('home');  const home=$('streak-slot').textContent;
  return {cards,home};
});
ok('카드 화면 스트릭 카드', r.cards.includes('연속 이용 조건')&&r.cards.includes('오늘 1건이면 달성'), '');
ok('홈 배너', r.home.includes('오늘 한 건만')&&r.home.includes('3일 연속 달성'), '');

r = await p.evaluate(() => {
  openCardPickModal({amount:29000,cat:'구독',memo:'Claude Pro'});
  const out=$('cp-out').textContent; closeModal(); return out;
});
ok('추천 모달 동작', r.includes('추천')&&r.includes('하나 3일2배')&&r.includes('AI 구독'), r.slice(0,60));

r = await p.evaluate(() => {
  openTxModal();
  $('tx-amt').value=29000; txDraft.cat='구독';
  $('tx-memo').value='Claude Pro';
  $('tx-pay').value='card|c2';
  txPickHint();
  const h=$('tx-pick-hint').textContent; closeModal(); return h;
});
ok('내역 입력 중 더 나은 카드 안내', r.includes('더 받아요')&&r.includes('하나'), r.slice(0,60));

ok('오류 없음', errs.length===0, errs.slice(0,3).join(' | '));
await b.close();
if(errs.length)errs.forEach(e=>console.log(' '+e));
