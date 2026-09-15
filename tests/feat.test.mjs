import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

// ══ 3. 순자산 타임라인 ══
let r = await p.evaluate(() => {
  S.accounts=[{id:'a1',type:'checking',name:'주',balance:3000000,cur:'KRW'},
              {id:'a2',type:'saving',name:'적금',balance:5000000,cur:'KRW',monthly:500000},
              {id:'a3',type:'invest',name:'투자',balance:2000000,cur:'KRW'}];
  S.cards=[];S.tx=[];S.netHist={};S.alloc=null;S.goals=[];
  save();
  return {afterSave:Object.keys(S.netHist).length, today:S.netHist[todayStr()]};
});
ok('저장하면 오늘 순자산이 기록됨', r.afterSave===1 && r.today===10000000, `${r.today}원`);

r = await p.evaluate(() => {
  // 6개월치 과거 스냅샷 주입
  const base=new Date();
  for(let i=6;i>=1;i--){
    const d=new Date(base.getFullYear(),base.getMonth()-i,15);
    S.netHist[`${d.getFullYear()}-${pad(d.getMonth()+1)}-15`]=10000000-i*800000;
  }
  save(); switchView('report'); setRepView('fore');   // 순자산 흐름은 '예측' 탭
  return {series:netSeries(13).length, html:$('nethist-card').textContent};
});
ok('월별 시계열 생성', r.series===7, `${r.series}개월`);
ok('  카드에 흐름 표시', r.html.includes('순자산 흐름')&&r.html.includes('개월'), r.html.slice(0,60));
ok('  증감 표시', /\+|−/.test(r.html));

r = await p.evaluate(() => { S.netHist={}; save(); switchView('report'); setRepView('fore'); return $('nethist-card').textContent; });
ok('데이터 없을 때 안내', r.includes('오늘부터'), r.slice(0,40));

// ══ 5. 자산 배분 ══
r = await p.evaluate(() => {
  const a=allocNow();
  return {tot:a.tot, cash:a.g.cash, safe:a.g.safe, invest:a.g.invest};
});
ok('배분 집계', r.tot===10000000&&r.cash===3000000&&r.safe===5000000&&r.invest===2000000, JSON.stringify(r));

r = await p.evaluate(() => { switchView('assets'); return $('alloc-card').textContent; });
ok('목표 미설정 시 안내', r.includes('목표 정하기')&&r.includes('30%'), r.slice(0,60));

r = await p.evaluate(() => {
  S.alloc={cash:30,safe:50,invest:20}; save(); switchView('assets');
  return $('alloc-card').textContent;
});
ok('목표대로면 제안 없음', r.includes('잘 맞춰져'), r.slice(-60));

r = await p.evaluate(() => {
  S.alloc={cash:10,safe:30,invest:60}; save(); switchView('assets');
  return $('alloc-card').textContent;
});
// 투자 목표 60% = 600만, 현재 200만 → 400만 옮겨야
ok('이탈 시 옮길 금액 계산', r.includes('400만')&&r.includes('투자'), r.slice(-90));

r = await p.evaluate(() => {
  openAllocModal();
  const before=$('al-hint').textContent;
  $('al-cash').value=50; allocHint();
  const after=$('al-hint').textContent;
  closeModal();
  return {before,after};
});
ok('합계 100% 안내', r.before.includes('100%')&&r.after.includes('초과'), r.after);

// ══ 6. 목표 역산 ══
r = await p.evaluate(() => {
  S.alloc=null;
  // 월 저축 여력 = 적금 50만 (수입 미기록 → 추정 모드)
  const cap=Math.round(recentMonthlySaving());
  const due=new Date(); due.setMonth(due.getMonth()+10);
  const dueStr=`${due.getFullYear()}-${pad(due.getMonth()+1)}-${pad(due.getDate())}`;
  S.goals=[{id:'g1',name:'여행',target:3000000,saved:0,due:dueStr},
           {id:'g2',name:'차',  target:30000000,saved:0,due:dueStr},
           {id:'g3',name:'기한없음',target:2000000,saved:500000,due:''},
           {id:'g4',name:'완료',target:1000000,saved:1000000,due:''}];
  save(); switchView('assets');
  return {cap, plans:S.goals.map(g=>goalPlan(g)), html:$('list-goals').textContent};
});
ok('월 저축 여력 계산', r.cap>0, `${r.cap}원/월`);
ok('  달성 가능한 목표 → feasible', r.plans[0].feasible===true, JSON.stringify(r.plans[0]).slice(0,80));
ok('  벅찬 목표 → 부족액 계산', r.plans[1].feasible===false&&r.plans[1].short>0, `월 ${r.plans[1].short}원 부족`);
ok('  기한 없으면 소요 개월 계산', r.plans[2].byPace>0&&!r.plans[2].perMonth, `${r.plans[2].byPace}개월`);
ok('  이미 채운 목표', r.plans[3].done===true);
ok('  화면에 역산 문구 노출', r.html.includes('매달')&&r.html.includes('가능해요'), '');
ok('  부족한 목표 경고', r.html.includes('부족해요'));

r = await p.evaluate(() => {
  const past=new Date(); past.setMonth(past.getMonth()-2);
  S.goals=[{id:'g5',name:'지난목표',target:5000000,saved:1000000,
            due:`${past.getFullYear()}-${pad(past.getMonth()+1)}-01`}];
  save(); switchView('assets');
  return $('list-goals').textContent;
});
ok('기한 지난 목표 안내', r.includes('기한이 지났'), r.slice(-50));

ok('오류 없음', errs.length===0, errs.slice(0,3).join(' | '));
await b.close();
if(errs.length)errs.forEach(e=>console.log(' '+e));
