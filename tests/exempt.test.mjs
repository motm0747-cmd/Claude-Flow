/* 발급 첫 달 전월실적 면제 */
import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

// 실적 50만 카드 · 전월 사용 0원(=미달) · 이번 달 구독 결제 2만원(실적형 혜택 대상)
await p.evaluate(`window.seedFn = ${(()=>{
  const ym=thisYM();
  S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:1000000,cur:'KRW'}];
  S.cards=[{id:'c1',type:'credit',name:'신규카드',accountId:'chk',payDay:14,tiers:[500000],exclCats:[],
    annualFee:0,prepays:[],issued:'',exemptM:1,
    perks:[{id:'p1',name:'구독 50%',cat:'구독',merchants:'',kind:'percent',value:50,boost:0,streakDays:0,
      via:'',minAmt:0,capM:10000,maxCnt:0,tier:1,bill:false}]}];
  S.tx=[{id:'t1',type:'expense',date:`${ym}-05`,amount:20000,cat:'구독',memo:'넷플릭스',
    payKind:'card',payId:'c1',months:1,paidPortions:0}];
  _discInvalidate(); save();
}).toString()}`);

/* ══════ 기본 동작 ══════ */
let r = await p.evaluate(() => { seedFn(); const c=cardById('c1');
  return {perfPrev:perfSpend(c,prevYM(thisYM())), tier:activeTierOf(c,thisYM()),
    est:perkEstimates(c,thisYM())[0], exempt:tierExempt(c,thisYM())}; });
ok('발급일 없으면 예전 그대로 — 실적 미달 → 잠김',
   r.exempt===false && r.tier===0 && r.est.active===false && r.est.est===0, `구간 ${r.tier}`);

// 이번 달에 발급 → 면제
r = await p.evaluate(() => {
  seedFn(); const c=cardById('c1');
  c.issued=`${thisYM()}-01`; c.exemptM=1; save();
  return {exempt:tierExempt(c,thisYM()), left:tierExemptLeft(c,thisYM()),
    tier:activeTierOf(c,thisYM()), est:perkEstimates(c,thisYM())[0]};
});
ok('이번 달 발급 → 면제 적용', r.exempt===true && r.left===1, `${r.left}개월 남음`);
ok('  실적 미달이어도 혜택 열림', r.est.active===true, `active=${r.est.active}`);
ok('  적립도 실제로 계산됨 (2만의 50% = 1만)', r.est.est===10000, `${r.est.est}원`);
ok('  최고 구간으로 열어줌', r.tier===1, `구간 ${r.tier}`);

// 다음 달이면 면제 끝 (1개월 설정)
r = await p.evaluate(() => {
  const c=cardById('c1');
  c.issued=`${prevYM(thisYM())}-01`; c.exemptM=1; save();
  return {left:tierExemptLeft(c,thisYM()), tier:activeTierOf(c,thisYM()),
    est:perkEstimates(c,thisYM())[0].active};
});
ok('1개월 설정 → 다음 달엔 면제 끝', r.left===0 && r.tier===0 && r.est===false);

// 2개월 설정이면 다음 달까지 면제
r = await p.evaluate(() => {
  const c=cardById('c1');
  c.issued=`${prevYM(thisYM())}-01`; c.exemptM=2; save();
  return {left:tierExemptLeft(c,thisYM()), est:perkEstimates(c,thisYM())[0].active};
});
ok('2개월 설정 → 발급 다음 달도 면제', r.left===1 && r.est===true, `${r.left}개월 남음`);

// 면제 0 = 끄기
r = await p.evaluate(() => {
  const c=cardById('c1'); c.issued=`${thisYM()}-01`; c.exemptM=0; save();
  return {left:tierExemptLeft(c,thisYM()), est:perkEstimates(c,thisYM())[0].active};
});
ok('면제 0개월 = 끄기', r.left===0 && r.est===false);

// 발급 전 달(발급일보다 과거)은 면제 아님
r = await p.evaluate(() => {
  const c=cardById('c1'); c.issued=`${thisYM()}-01`; c.exemptM=3; save();
  return {past:tierExemptLeft(c,prevYM(thisYM())), now:tierExemptLeft(c,thisYM())};
});
ok('발급월 이전 달은 면제 아님', r.past===0 && r.now===3, `이전 ${r.past} · 이번 ${r.now}`);

/* ══════ 다른 화면들도 같은 답을 내는지 ══════ */
r = await p.evaluate(() => {
  seedFn(); const c=cardById('c1');
  c.issued=`${thisYM()}-01`; c.exemptM=1;
  // 연속일 혜택도 하나 추가 (스트릭 판정 경로 확인)
  c.perks.push({id:'p2',name:'3일 연속',cat:'전체',merchants:'',kind:'percent',value:1,boost:2,
    streakDays:3,via:'',minAmt:0,capM:0,maxCnt:0,tier:1,bill:false});
  _discInvalidate(); save();
  return {streak:cardStreaks(c,thisYM()).map(s=>s.active),
          advice:pickAdvice(c,thisYM()).map(a=>a.t)};
});
ok('스트릭 판정도 면제 반영', r.streak.every(Boolean), JSON.stringify(r.streak));
ok('개선 제안이 "잠김" 대신 면제 안내', r.advice.some(t=>/실적이 면제/.test(t)) && !r.advice.some(t=>/잠겼어요/.test(t)),
   r.advice[0]||'');

r = await p.evaluate(() => { switchView('cards'); renderCards(); return $('card-list').innerHTML; });
ok('카드 화면 배지 = 면제 중', /실적 면제/.test(r) && !/혜택 잠김/.test(r),
   (r.match(/발급 첫 달[^<]*/)||[''])[0]);

// 면제가 끝나면 다시 잠김 배지
r = await p.evaluate(() => {
  cardById('c1').issued=`${prevYM(thisYM())}-01`; cardById('c1').exemptM=1;
  _discInvalidate(); save(); renderCards(); return $('card-list').innerHTML;
});
ok('면제 끝나면 원래대로 잠김 표시', /혜택 잠김/.test(r) && !/실적 면제/.test(r));

/* ══════ 카드 추천도 면제를 반영하는지 ══════ */
r = await p.evaluate(() => {
  seedFn(); const c=cardById('c1');
  S.tx=[];                       // 월 한도(1만)에 여유가 있어야 추가 결제 이득이 보인다
  c.issued=`${thisYM()}-01`; c.exemptM=1; _discInvalidate(); save();
  const withEx=cardPick({amount:12000,cat:'구독',memo:'유튜브'})[0];
  c.issued=''; _discInvalidate(); save();
  const without=cardPick({amount:12000,cat:'구독',memo:'유튜브'})[0];
  return {withEx:withEx.gain, without:without.gain};
});
ok('추천 계산에도 면제 반영', r.withEx===6000 && r.without===0,
   `면제 시 +${r.withEx} / 면제 없을 때 +${r.without}`);

/* ══════ UI 왕복 ══════ */
r = await p.evaluate(() => {
  openCardModal('c1');
  const html=$('sheet').innerHTML;
  const hasDate=!!$('cd-issued'), hasSel=!!$('cd-exempt');
  const disabled=$('cd-exempt')?$('cd-exempt').disabled:null;
  return {html,hasDate,hasSel,disabled};
});
ok('카드 관리에 발급일·면제 입력칸', r.hasDate && r.hasSel);
ok('  발급일 없으면 면제 선택 비활성', r.disabled===true);
ok('  안내 문구', /첫 달 실적을 면제/.test(r.html));

r = await p.evaluate(() => {
  $('cd-issued').value=`${thisYM()}-03`;
  syncCardDraft(); renderCardModal();
  $('cd-exempt').value='2'; syncCardDraft();
  saveCard();
  const c=cardById('c1');
  return {issued:c.issued, exemptM:c.exemptM, left:tierExemptLeft(c,thisYM())};
});
ok('발급일·면제 저장 왕복', r.issued===`${await p.evaluate(()=>thisYM())}-03` && r.exemptM===2,
   `${r.issued} · ${r.exemptM}개월`);
ok('  저장 후 즉시 면제 적용', r.left===2, `${r.left}개월 남음`);

// 체크카드는 이 설정이 안 보인다
r = await p.evaluate(() => {
  S.cards.push({id:'c2',type:'check',name:'체크',accountId:'chk',tiers:[],exclCats:[],perks:[],prepays:[]});
  save(); openCardModal('c2');
  return {hasDate:!!$('cd-issued')};
});
ok('체크카드엔 해당 없음', r.hasDate===false);

console.log(errs.length? '❌ 콘솔/페이지 오류:\n'+errs.join('\n') : '✅ 오류 없음');
if(errs.length)process.exitCode=1;
await b.close();
