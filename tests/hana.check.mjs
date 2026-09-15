/* 하나 MOVING ONLINE 프리셋 검증 — 프리셋을 실제로 카드에 넣고 한 달 결제를 돌려
   혜택별로 얼마가 잡히는지, 조건(실적·연속일·간편결제·한도)이 의도대로 걸리는지 본다. */
import { chromium, APP, BASE } from './lib/env.mjs';
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
const errs=[]; p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

// 프리셋을 UI 경로 그대로(카드 모달 → 프리셋 적용 → 저장) 넣는다
let r = await p.evaluate(() => {
  S.cards=[]; S.tx=[]; S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:3000000,cur:'KRW'}];
  openCardModal();
  cardDraft.name='하나 MOVING ONLINE'; cardDraft.type='credit'; cardDraft.payDay=14; cardDraft.accountId='chk';
  applyPerkPreset('hana-3day-2x');
  saveCard();
  const c=S.cards[0];
  return {tiers:c.tiers, perks:(c.perks||[]).map(x=>({name:x.name,cat:x.cat,kind:x.kind,value:x.value,
    boost:x.boost,streak:x.streakDays,via:x.via,cap:x.capM,tier:x.tier,merch:(x.merchants||'').slice(0,28)}))};
});
console.log('\n── 프리셋이 카드에 들어간 모습 ──');
console.table(r.perks);
ok('실적 구간 50만원', JSON.stringify(r.tiers)==='[500000]', JSON.stringify(r.tiers));
ok('혜택 7개', r.perks.length===7, String(r.perks.length));

// 전월 실적 60만 (구간 통과) + 이번 달 결제들
r = await p.evaluate(() => {
  const ym=thisYM(), pm=prevYM(ym), cid=S.cards[0].id;
  const T=(date,amount,cat,memo,via)=>S.tx.push({id:uid(),type:'expense',date,amount,cat,memo:memo||'',
    payKind:'card',payId:cid,via:via||'',months:1,paidPortions:0});
  // 전월 실적 60만원
  T(`${pm}-05`,600000,'쇼핑','전월실적용');
  // 이번 달: 연속 3일 일반결제 (기본적립 0.5% → 3일째 1%)
  T(`${ym}-01`,50000,'식비','김밥천국');
  T(`${ym}-02`,50000,'식비','김밥천국');
  T(`${ym}-03`,50000,'식비','김밥천국');
  // 간편결제 연속 3일 (1.5% → 3일째 3%)
  T(`${ym}-05`,100000,'쇼핑','무신사','simple');
  T(`${ym}-06`,100000,'쇼핑','무신사','simple');
  T(`${ym}-07`,100000,'쇼핑','무신사','simple');
  // 영역 혜택들
  T(`${ym}-08`,30000,'구독','Claude 구독');            // AI 구독 50% → 한도 1만
  T(`${ym}-09`,17000,'구독','넷플릭스');                // 스트리밍 50% (한도 미설정)
  T(`${ym}-10`,20000,'교통','카카오T 택시');            // 택시 50% → 한도 5천
  T(`${ym}-11`,12000,'식비','스타벅스');                // 푸드 50% → 한도 5천
  _discInvalidate(); save();
  const c=S.cards[0];
  return {
    perf:perfSpend(c,prevYM(ym)),
    est:perkEstimates(c,ym).map(e=>({name:e.p.name,active:e.active,건수:e.n,부스트:e.boostN,
      한도걸림:e.capped,적립액:e.est}))
  };
});
console.log('\n── 이번 달 혜택별 계산 결과 (전월 실적 '+r.perf.toLocaleString()+'원) ──');
console.table(r.est);
const get=n=>r.est.find(x=>x.name.startsWith(n));

ok('전월 실적 60만 → 실적형 혜택 열림', get('AI 구독').active===true);
// 기본적립: 15만(연속3일 일반결제) 중 3일째 5만은 1%, 앞 2일은 0.5%
//           + 나머지 일반결제(구독·교통·식비 등)도 cat:'전체'라 함께 잡힌다
ok('기본적립이 간편결제 건을 가져가지 않음', get('국내외').건수===7,
   `${get('국내외').건수}건 (이번 달 10건 중 간편결제 3건 제외)`);
ok('  연속 3일째부터 2배', get('국내외').부스트>=1, `부스트 ${get('국내외').부스트}건`);
ok('간편결제 적립은 간편결제 건만', get('온라인 간편결제').건수===3, `${get('온라인 간편결제').건수}건`);
ok('  간편결제도 3일 연속 → 2배 구간 발생', get('온라인 간편결제').부스트>=1, `부스트 ${get('온라인 간편결제').부스트}건`);
ok('AI 구독 50% → 월 한도 1만원에서 잘림', get('AI 구독').적립액===10000 && get('AI 구독').한도걸림===true,
   `${get('AI 구독').적립액}원`);
ok('택시 50% → 월 한도 5천원에서 잘림', get('택시').적립액===5000, `${get('택시').적립액}원`);
ok('푸드 50% → 6천원이지만 한도 5천', get('푸드').적립액===5000, `${get('푸드').적립액}원`);
ok('스트리밍은 한도 미설정이라 전액', get('디지털 구독 · 스트리밍').적립액===8500,
   `${get('디지털 구독 · 스트리밍').적립액}원 (17,000의 50%)`);

// 전월 실적 미달이면 영역 혜택이 잠기는지
r = await p.evaluate(() => {
  const ym=thisYM(), pm=prevYM(ym);
  S.tx=S.tx.filter(t=>!(t.memo==='전월실적용'));
  _discInvalidate(); save();
  const c=S.cards[0];
  return {perf:perfSpend(c,pm), est:perkEstimates(c,ym).map(e=>({name:e.p.name,active:e.active,적립액:e.est}))};
});
console.log('\n── 전월 실적 0원일 때 ──');
console.table(r.est);
ok('실적 미달 → AI구독·택시·푸드 잠김',
   ['AI 구독','택시','푸드'].every(n=>r.est.find(x=>x.name.startsWith(n)).active===false));
ok('  기본적립·간편결제는 실적과 무관하게 열림',
   r.est.find(x=>x.name.startsWith('국내외')).active===true &&
   r.est.find(x=>x.name.startsWith('온라인')).active===true);

// 같은 결제에 기본적립과 영역적립이 겹치는지 (알려진 설계 — 값이 얼마나 차이나는지 본다)
r = await p.evaluate(() => {
  const ym=thisYM(), pm=prevYM(ym), cid=S.cards[0].id;
  S.tx=[{id:uid(),type:'expense',date:`${pm}-05`,amount:600000,cat:'쇼핑',memo:'실적',payKind:'card',payId:cid,months:1,paidPortions:0},
        {id:uid(),type:'expense',date:`${ym}-08`,amount:20000,cat:'구독',memo:'Claude',payKind:'card',payId:cid,months:1,paidPortions:0}];
  _discInvalidate(); save();
  const e=perkEstimates(S.cards[0],ym);
  return e.filter(x=>x.est>0).map(x=>({name:x.p.name,적립액:x.est}));
});
console.log('\n── 2만원 AI 구독 결제 한 건에 붙는 혜택 ──');
console.table(r);
console.log(`합계 ${r.reduce((s,x)=>s+x.적립액,0).toLocaleString()}원 (영역 50% 1만 + 기본 0.5% 100원이 함께 붙음)`);

console.log(errs.length? '\n❌ 오류:\n'+errs.join('\n') : '\n✅ 오류 없음');
if(errs.length)process.exitCode=1;
await b.close();
