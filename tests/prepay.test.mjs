/* 선결제 — ① 건별 ② 매주 자동 */
import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

// 공통 시드: 입출금 100만 + 신용카드 + 이번 달 결제 4건(할부 1건 포함)
const seed = () => {
  const ym=thisYM();
  S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:1000000,cur:'KRW'}];
  S.cards=[{id:'c1',type:'credit',name:'테스트카드',accountId:'chk',payDay:14,tiers:[],exclCats:[],
    perks:[],annualFee:0,prepays:[],autoPre:{on:false,weekday:5,min:300000,lastRun:''}}];
  S.tx=[
    {id:'t1',type:'expense',date:`${ym}-02`,amount:50000, cat:'식비',memo:'점심',  payKind:'card',payId:'c1',months:1,paidPortions:0},
    {id:'t2',type:'expense',date:`${ym}-04`,amount:120000,cat:'쇼핑',memo:'무신사',payKind:'card',payId:'c1',months:1,paidPortions:0},
    {id:'t3',type:'expense',date:`${ym}-06`,amount:30000, cat:'교통',memo:'주유',  payKind:'card',payId:'c1',months:1,paidPortions:0},
    {id:'t4',type:'expense',date:`${ym}-08`,amount:300000,cat:'쇼핑',memo:'노트북',payKind:'card',payId:'c1',months:3,paidPortions:0},
  ];
  _discInvalidate(); save();
};

/* ══════ ① 건별 선결제 ══════ */
let r = await p.evaluate(() => { seedFn(); const c=cardById('c1');
  return {list:prepayables(c).map(t=>({id:t.id,pend:pendingOfTx(t)})), pend:creditPending(c)};
}, ).catch(()=>null);
// seed 를 페이지 안에 정의해서 재사용
await p.evaluate(`window.seedFn = ${seed.toString()}`);

r = await p.evaluate(() => { seedFn(); const c=cardById('c1');
  return {list:prepayables(c).map(t=>({id:t.id,pend:pendingOfTx(t)})), pend:creditPending(c)}; });
ok('미결제 대상 4건 인식', r.list.length===4, `${r.list.length}건`);
ok('  할부는 이번 회차분만 대상', r.list.find(x=>x.id==='t4').pend===100000,
   `노트북 30만 3개월 → ${r.list.find(x=>x.id==='t4').pend}원`);
ok('  미결제 합계 = 50+120+30+10만', r.pend===300000, `${r.pend}원`);

// 2건만 골라 선결제
r = await p.evaluate(() => {
  const c=cardById('c1');
  const sel=prepayables(c).filter(t=>['t1','t3'].includes(t.id));
  const amt=prepayAmount(c,sel);
  applyPrepay(c,sel,'manual');
  return {amt, bal:accById('chk').balance, pend:creditPending(c),
    t1:S.tx.find(t=>t.id==='t1').paidPortions, t2:S.tx.find(t=>t.id==='t2').paidPortions,
    prepays:c.prepays.length, how:c.prepays[0].how};
});
ok('고른 2건만 결제 처리', r.amt.gross===80000 && r.amt.net===80000, `${r.amt.net}원`);
ok('  계좌에서 그만큼 빠짐', r.bal===920000, `${r.bal}원`);
ok('  미결제 잔액 감소 (30만 → 22만)', r.pend===220000, `${r.pend}원`);
ok('  고른 건만 납부 표시', r.t1===1 && r.t2===0, `t1=${r.t1} t2=${r.t2}`);
ok('  선결제 이력 기록', r.prepays===1 && r.how==='manual');

// 이미 갚은 건은 다시 대상에 안 뜬다
r = await p.evaluate(() => prepayables(cardById('c1')).map(t=>t.id));
ok('갚은 건은 목록에서 빠짐', !r.includes('t1') && !r.includes('t3') && r.length===2, r.join(','));

// 할부 선결제 후 다음 회차는 남아 있어야 한다
r = await p.evaluate(() => {
  const c=cardById('c1'), t4=[S.tx.find(t=>t.id==='t4')];
  applyPrepay(c,t4,'manual');
  const t=S.tx.find(x=>x.id==='t4');
  return {paid:t.paidPortions, months:t.months, pendNow:pendingOfTx(t), remain:installRemain(c)};
});
ok('할부 1회차 선결제', r.paid===1 && r.pendNow===0, `${r.paid}/${r.months}회차 납부`);
ok('  남은 할부는 유지 (20만)', r.remain===200000, `${r.remain}원`);

/* ══════ 청구할인 회계 ══════ */
r = await p.evaluate(() => {
  seedFn();
  const c=cardById('c1');
  c.perks=[{id:'p1',name:'쇼핑 청구할인',cat:'쇼핑',merchants:'',kind:'percent',value:10,boost:0,
    streakDays:0,via:'',minAmt:0,capM:0,maxCnt:0,tier:0,bill:true}];
  _discInvalidate(); save();
  const before=billedDiscount(c);
  const sel=prepayables(c).filter(t=>t.id==='t2');     // 무신사 12만 (10% 청구할인 대상)
  const amt=prepayAmount(c,sel);
  applyPrepay(c,sel,'manual');
  return {before, amt, bal:accById('chk').balance,
    discTx:S.tx.filter(t=>t.type==='discount').map(t=>({amt:t.amount,memo:t.memo}))};
});
ok('청구할인이 선결제 금액에 반영', r.amt.disc>0 && r.amt.net===r.amt.gross-r.amt.disc,
   `${r.amt.gross} − ${r.amt.disc} = ${r.amt.net}`);
ok('  할인만큼 덜 빠짐', r.bal===1000000-r.amt.net, `${r.bal}원`);
ok('  할인 내역이 별도 기록됨(정기 결제와 같은 회계)', r.discTx.length===1 && /선결제/.test(r.discTx[0].memo),
   r.discTx[0]?`${r.discTx[0].amt}원 "${r.discTx[0].memo}"`:'없음');

/* ══════ ② 매주 자동 선결제 ══════ */

// 지정 요일이 오늘이고 기준 이상 → 실행
r = await p.evaluate(() => {
  seedFn();
  const c=cardById('c1'), dow=new Date().getDay();
  c.autoPre={on:true,weekday:dow,min:200000,lastRun:''};
  save();
  autoPrepayCards();
  return {bal:accById('chk').balance, pend:creditPending(c), lastRun:c.autoPre.lastRun,
    today:todayStr(), prepays:c.prepays.map(x=>({how:x.how,net:x.net,date:x.date}))};
});
ok('지정 요일 + 기준 이상 → 자동 실행', r.pend===0 && r.bal===700000, `잔액 ${r.bal} · 미결제 ${r.pend}`);
ok('  자동으로 표시', r.prepays.length===1 && r.prepays[0].how==='auto', JSON.stringify(r.prepays[0]||{}));
ok('  실행일 기록', r.lastRun===r.today, r.lastRun);

// 같은 날 다시 열어도 두 번 실행되지 않는다
r = await p.evaluate(() => {
  const c=cardById('c1');
  S.tx.push({id:'t9',type:'expense',date:todayStr(),amount:400000,cat:'쇼핑',memo:'추가결제',
    payKind:'card',payId:'c1',months:1,paidPortions:0});
  _discInvalidate(); save();
  autoPrepayCards();
  return {pend:creditPending(c), prepays:c.prepays.length, bal:accById('chk').balance};
});
ok('같은 날 재실행 안 함', r.prepays===1 && r.pend===400000, `이력 ${r.prepays}건 · 미결제 ${r.pend}`);

// 기준 미달이면 건너뛴다 (그 주는 넘어감)
r = await p.evaluate(() => {
  seedFn();
  const c=cardById('c1'), dow=new Date().getDay();
  c.autoPre={on:true,weekday:dow,min:500000,lastRun:''};   // 미결제 30만 < 기준 50만
  save(); autoPrepayCards();
  return {pend:creditPending(c), bal:accById('chk').balance, lastRun:c.autoPre.lastRun, today:todayStr()};
});
ok('기준 미달이면 실행 안 함', r.pend===300000 && r.bal===1000000, `미결제 ${r.pend} · 잔액 ${r.bal}`);
ok('  그 주는 넘어간 것으로 표시', r.lastRun===r.today);

// 지정 요일이 아직 안 왔으면 실행 안 함
r = await p.evaluate(() => {
  seedFn();
  const c=cardById('c1'), tomorrow=(new Date().getDay()+1)%7;
  // 지난주 그 요일 몫까지는 이미 처리한, 정상적으로 돌고 있는 설정
  c.autoPre={on:true,weekday:tomorrow,min:100000,lastRun:weekdayDate(tomorrow)};
  save(); autoPrepayCards();
  return {pend:creditPending(c), n:(c.prepays||[]).length, next:nextPrepayDate(c),
    expect:addDays(todayStr(),1)};
});
ok('지정 요일 전이면 대기', r.pend===300000 && r.n===0, `미결제 ${r.pend} · 이력 ${r.n}건`);
ok('  다음 예정일은 내일', r.next===r.expect, `${r.next} (기대 ${r.expect})`);

/* 켠 시점 이전의 요일까지 소급해서 출금하면 안 된다.
   (예전엔 lastRun 이 비어 있으면 지난 요일 몫을 즉시 털어가서, 켜자마자 돈이 빠졌다) */
r = await p.evaluate(() => {
  seedFn();
  const c=cardById('c1'), yst=(new Date().getDay()+6)%7;
  c.autoPre={on:true,weekday:yst,min:100000,lastRun:''};    // 방금 켠 상태
  save(); autoPrepayCards();
  return {pend:creditPending(c), bal:accById('chk').balance, n:(c.prepays||[]).length,
    next:nextPrepayDate(c), expect:addDays(todayStr(),6)};
});
ok('방금 켰으면 지나간 요일은 소급 안 함', r.n===0 && r.pend===300000 && r.bal===1000000,
   `이력 ${r.n}건 · 잔액 ${r.bal}`);
ok('  다음 예정일은 다음 주 그 요일', r.next===r.expect, `${r.next} (기대 ${r.expect})`);

// 이미 돌고 있던 설정이면, 지정 요일을 놓쳐도(앱을 늦게 열어도) 그 요일 날짜로 처리
r = await p.evaluate(() => {
  seedFn();
  const c=cardById('c1'), yst=(new Date().getDay()+6)%7;   // 어제 요일
  c.autoPre={on:true,weekday:yst,min:100000,lastRun:addDays(todayStr(),-8)};
  save(); autoPrepayCards();
  return {pend:creditPending(c), date:c.prepays[0]&&c.prepays[0].date, expect:addDays(todayStr(),-1)};
});
ok('놓친 요일도 열었을 때 처리', r.pend===0);
ok('  기록 날짜는 지정 요일 (오늘 아님)', r.date===r.expect, `${r.date} (기대 ${r.expect})`);

// 잔액 부족이면 마이너스 만들지 않고 보류 → 다음에 재시도
r = await p.evaluate(() => {
  seedFn();
  const c=cardById('c1'), dow=new Date().getDay();
  accById('chk').balance=50000;                            // 미결제 30만 > 잔액 5만
  c.autoPre={on:true,weekday:dow,min:100000,lastRun:''};
  save(); autoPrepayCards();
  const held={pend:creditPending(c), bal:accById('chk').balance, lastRun:c.autoPre.lastRun,
    today:todayStr()};
  accById('chk').balance=1000000; save(); autoPrepayCards();  // 입금 후 재시도
  return {held, after:{pend:creditPending(c), bal:accById('chk').balance}};
});
ok('잔액 부족 → 보류(마이너스 안 만듦)', r.held.pend===300000 && r.held.bal===50000, `잔액 ${r.held.bal}`);
ok('  lastRun 안 올려서 재시도 가능', r.held.lastRun<r.held.today, r.held.lastRun);
ok('  잔액 채우면 다음 열 때 실행', r.after.pend===0 && r.after.bal===700000, `잔액 ${r.after.bal}`);

// 체크카드는 대상 아님
r = await p.evaluate(() => {
  seedFn();
  S.cards.push({id:'c2',type:'check',name:'체크',accountId:'chk',tiers:[],exclCats:[],perks:[],
    autoPre:{on:true,weekday:new Date().getDay(),min:0,lastRun:''},prepays:[]});
  save(); autoPrepayCards();
  return (cardById('c2').prepays||[]).length;
});
ok('체크카드는 자동 선결제 대상 아님', r===0);

/* ══════ UI ══════ */
r = await p.evaluate(() => {
  seedFn();
  openPrepayModal('c1');
  const html=$('sheet').innerHTML;
  const boxes=document.querySelectorAll('#sheet input[type=checkbox]').length;
  return {html, boxes};
});
ok('선결제 모달 열림', /선결제/.test(r.html) && /미결제 4건/.test(r.html));
ok('  건별 체크박스 4개', r.boxes===4, `${r.boxes}개`);
ok('  아무것도 안 고르면 버튼 비활성', /disabled/.test(r.html.split('선결제하기')[0].slice(-200))
   || /갚을 내역을 골라주세요/.test(r.html));

r = await p.evaluate(() => {
  ppToggleAll();
  const html=$('sheet').innerHTML;
  const done=doPrepaySelected();
  return {html, pend:creditPending(cardById('c1')), bal:accById('chk').balance};
});
ok('  전체 선택 → 합계 표시', /300,000/.test(r.html));
ok('  버튼 눌러 실제 처리', r.pend===0 && r.bal===700000, `잔액 ${r.bal} · 미결제 ${r.pend}`);

// 카드 화면에 선결제 버튼 + 자동 선결제 안내
r = await p.evaluate(() => {
  seedFn();
  cardById('c1').autoPre={on:true,weekday:5,min:300000,lastRun:''};
  save(); switchView('cards'); renderCards();
  return $('card-list').innerHTML;
});
ok('카드 화면에 선결제 버튼', /openPrepayModal/.test(r));
ok('  자동 선결제 설정 표시', /자동 선결제/.test(r) && /금요일/.test(r), (r.match(/⚡[^<]*/)||[''])[0].slice(0,50));

// 카드 관리 모달의 설정 UI
r = await p.evaluate(() => {
  openCardModal('c1');
  const html=$('sheet').innerHTML;
  const wd=$('cd-ap-wd')?$('cd-ap-wd').value:null;
  const min=$('cd-ap-min')?$('cd-ap-min').value:null;
  return {html,wd,min};
});
ok('카드 관리에 자동 선결제 설정', /매주 자동 선결제/.test(r.html));
ok('  요일·기준액 입력칸', r.wd==='5' && r.min==='300000', `요일 ${r.wd} · 기준 ${r.min}`);

// 설정 저장 왕복
r = await p.evaluate(() => {
  $('cd-ap-wd').value='2'; $('cd-ap-min').value='150000';
  saveCard();
  const ap=cardById('c1').autoPre;
  return {on:ap.on, wd:ap.weekday, min:ap.min};
});
ok('설정 저장 왕복', r.on===true && r.wd===2 && r.min===150000, JSON.stringify(r));

console.log(errs.length? '❌ 콘솔/페이지 오류:\n'+errs.join('\n') : '✅ 오류 없음');
if(errs.length)process.exitCode=1;
await b.close();
