/* ① 쓸 수 있는 돈(safeSpend)  ② 홈 3단 재구성 */
import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

/* ══════ ① safeSpend ══════ */

// 오늘 기준으로 확정적인 시드를 만든다: 급여 +12일, 월세 +3일, 적금 +5일, 카드결제 +7일
let r = await p.evaluate(() => {
  const t=todayStr(), D=n=>+addDays(t,n).slice(8,10);
  S.accounts=[
    {id:'chk',type:'checking',name:'주거래',balance:2000000,cur:'KRW'},
    {id:'sav',type:'saving',name:'청년적금',balance:5000000,cur:'KRW',monthly:300000,payDay:D(5),payFrom:'chk'},
  ];
  S.cards=[{id:'c1',type:'credit',name:'주카드',accountId:'chk',payDay:D(7),tiers:[],exclCats:[],perks:[]}];
  S.fixed=[
    {id:'f1',kind:'income',name:'급여',amount:3000000,day:D(12),cat:'급여',payKind:'account',payId:'chk',active:true},
    {id:'f2',kind:'expense',name:'월세',amount:600000,day:D(3),cat:'주거',payKind:'account',payId:'chk',active:true},
    {id:'f3',kind:'expense',name:'넷플릭스',amount:13500,day:D(4),cat:'구독',payKind:'card',payId:'c1',active:true},
  ];
  // 카드 미결제 30만원
  S.tx=[{id:uid(),type:'expense',date:t,amount:300000,cat:'식비',memo:'장보기',payKind:'card',payId:'c1',months:1,paidPortions:0}];
  S.budgets={}; S.settings.buffer=0;
  _discInvalidate(); save();
  return {s:safeSpend(), hz:nextIncomeDate()};
});
ok('지평 = 다음 급여일', r.hz.kind==='income' && r.hz.name==='급여', `${r.hz.name} ${r.hz.date}`);
ok('남은 일수 = 12일', r.s.days===12, String(r.s.days));
ok('입출금 잔액 인식', r.s.start===2000000, String(r.s.start));
ok('지평 당일 급여는 더하지 않음', r.s.plus===0, `+${r.s.plus}`);
ok('나갈 돈 = 월세60만 + 적금30만 + 카드30만', r.s.minus===600000+300000+300000, String(r.s.minus));
ok('  카드로 내는 고정비는 따로 빼지 않음(이중 차감 방지)',
   !r.s.items.some(x=>x.t==='fixed'&&x.n==='넷플릭스'), r.s.items.map(x=>x.n).join(','));
ok('쓸 수 있는 돈 = 200만 − 120만', r.s.usable===800000, String(r.s.usable));
ok('하루 권장 = 쓸수있는돈 / 남은일수', r.s.perDay===Math.floor(800000/12), String(r.s.perDay));

// 남겨둘 돈(버퍼)이 실제로 빠지는지
r = await p.evaluate(() => { S.settings.buffer=500000; save(); return safeSpend(); });
ok('남겨둘 돈만큼 줄어듦', r.usable===300000 && r.buffer===500000, `${r.usable}원`);

// 예산이 더 빡빡하면 그 사실을 알려주는지
r = await p.evaluate(() => {
  S.settings.buffer=0;
  S.budgets={[thisYM()]:{total:400000,cats:{},rollover:false}};
  _discInvalidate(); save();
  return safeSpend();
});
ok('예산 잔액도 함께 계산', r.budgetLeft!==null && r.budgetLeft<r.usable, `예산 ${r.budgetLeft} < 통장 ${r.usable}`);

// 입출금 계좌가 없으면 계산하지 않고 이유를 말한다
r = await p.evaluate(() => {
  S.accounts=S.accounts.filter(a=>a.type!=='checking'); _discInvalidate(); save();
  return safeSpend();
});
ok('입출금 계좌 없으면 계산 안 함', r.ok===false && r.why==='no-checking');

// 고정수입이 없으면 이달 말까지로 본다
r = await p.evaluate(() => {
  S.accounts.push({id:'chk',type:'checking',name:'주거래',balance:1000000,cur:'KRW'});
  S.fixed=S.fixed.filter(f=>(f.kind||'expense')!=='income');
  _discInvalidate(); save();
  return {s:safeSpend(), end:`${thisYM()}-${pad(daysIn(thisYM()))}`};
});
ok('고정수입 없으면 지평 = 이달 말', r.s.hz.kind==='monthend' && r.s.hz.date===r.end, r.s.hz.date);

// 31일 급여인데 30일까지인 달이면 말일로 본다
r = await p.evaluate(() => {
  S.fixed.push({id:'fx',kind:'income',name:'급여',amount:3000000,day:31,cat:'급여',payKind:'account',payId:'chk',active:true});
  save();
  const hz=nextIncomeDate();
  return {hz, dim:daysIn(hz.date.slice(0,7))};
});
ok('31일 급여 → 짧은 달은 말일', +r.hz.date.slice(8,10)===Math.min(31,r.dim), `${r.hz.date} (그 달 ${r.dim}일)`);

/* ══════ ② 홈 3단 구조 ══════ */

r = await p.evaluate(() => {
  const t=todayStr(), D=n=>+addDays(t,n).slice(8,10);
  S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:2000000,cur:'KRW'}];
  S.cards=[]; S.tx=[]; S.budgets={}; S.settings.buffer=0;
  S.fixed=[{id:'f1',kind:'income',name:'급여',amount:3000000,day:D(10),cat:'급여',payKind:'account',payId:'chk',active:true}];
  _discInvalidate(); save(); switchView('home'); renderHome();
  return {label:$('h-lead-label').textContent, lead:$('h-lead').textContent,
          sub:$('h-lead-sub').textContent, c1:$('h-c1-k').textContent,
          btn:$('h-lead-btn').style.display};
});
ok('히어로 대표 숫자 = 쓸 수 있는 돈', /쓸 수 있는 돈/.test(r.label) && r.lead==='2,000,000원', `${r.label} / ${r.lead}`);
ok('  남은 일수·하루 권장 표시', /10일 남음/.test(r.sub) && /하루/.test(r.sub), r.sub);
ok('  순자산은 보조 칸으로', r.c1==='순자산', r.c1);
ok('  계산 근거 버튼 노출', r.btn!=='none');

// 입출금 계좌가 없으면 순자산으로 물러선다
r = await p.evaluate(() => {
  S.accounts=[{id:'d1',type:'deposit',name:'예금',balance:5000000,cur:'KRW'}];
  _discInvalidate(); save(); renderHome();
  return {label:$('h-lead-label').textContent, lead:$('h-lead').textContent,
          sub:$('h-lead-sub').innerHTML, c1:$('h-c1-k').textContent, btn:$('h-lead-btn').style.display};
});
ok('계좌 없으면 순자산으로 대체', r.label==='순자산' && r.lead==='5,000,000원', `${r.label} / ${r.lead}`);
ok('  이유를 알려줌', /입출금 계좌를 등록하면/.test(r.sub));
ok('  보조 칸은 수지로 전환', r.c1==='이번 달 수지', r.c1);
ok('  계산 근거 버튼 숨김', r.btn==='none');

// 해야 할 일 개수 배지
r = await p.evaluate(() => {
  S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:30000,cur:'KRW'}];
  const t=todayStr(), D=n=>+addDays(t,n).slice(8,10);
  S.fixed=[{id:'f1',kind:'income',name:'급여',amount:3000000,day:D(20),cat:'급여',payKind:'account',payId:'chk',active:true},
           {id:'f2',kind:'expense',name:'월세',amount:600000,day:D(2),cat:'주거',payKind:'account',payId:'chk',active:true}];
  _discInvalidate(); save(); renderHome();
  const zone=$('todo-zone');
  return {count:$('todo-count').textContent, empty:$('todo-empty').innerHTML,
          filled:[...zone.children].filter(el=>el.innerHTML.trim()!==''&&el.style.display!=='none'&&el.dataset.nag!=='1').map(el=>el.id),
          nag:[...zone.children].filter(el=>el.dataset.nag==='1'&&el.innerHTML.trim()!=='').map(el=>el.id)};
});
ok('현금흐름 위험이 할 일로 잡힘', r.filled.includes('flow-slot'), r.filled.join(','));
ok('  개수 배지 표시', r.count!=='' && +r.count===r.filled.length, `배지 ${r.count} / 실제 ${r.filled.length}`);
ok('  할 일 있으면 빈 상태 문구 없음', r.empty==='');
ok('  동기화 로그인 권유는 할 일로 세지 않음', r.nag.includes('sync-banner')&&!r.filled.includes('sync-banner'),
   `nag: ${r.nag.join(',')||'없음'}`);

// 할 일이 하나도 없을 때
r = await p.evaluate(() => {
  S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:9000000,cur:'KRW'}];
  S.fixed=[]; S.tx=[]; S.reports={}; S.briefs={};
  _discInvalidate(); save(); renderHome();
  return {count:$('todo-count').textContent, empty:$('todo-empty').innerHTML};
});
ok('할 일 없으면 배지 없음', r.count==='', r.count);
ok('  "급한 일 없어요" 안내', /급한 일은 없어요/.test(r.empty));

// 더 보기 접기/펼치기 + 상태 저장
r = await p.evaluate(() => {
  const before=$('home-more').style.display;
  toggleHomeMore();
  const after=$('home-more').style.display, saved=S.settings.homeMore, label=$('more-label').textContent;
  toggleHomeMore();
  return {before,after,saved,label,back:$('home-more').style.display};
});
ok('더 보기 기본은 접힘', r.before==='none', r.before);
ok('  펼치면 보이고 상태가 저장됨', r.after!=='none' && r.saved===true && r.label==='접기');
ok('  다시 누르면 접힘', r.back==='none');

// 계산 근거 모달
r = await p.evaluate(() => {
  const t=todayStr(), D=n=>+addDays(t,n).slice(8,10);
  S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:2000000,cur:'KRW'},
              {id:'sav',type:'saving',name:'청년적금',balance:100000,cur:'KRW',monthly:300000,payDay:D(5),payFrom:'chk'}];
  S.fixed=[{id:'f1',kind:'income',name:'급여',amount:3000000,day:D(12),cat:'급여',payKind:'account',payId:'chk',active:true},
           {id:'f2',kind:'expense',name:'월세',amount:600000,day:D(3),cat:'주거',payKind:'account',payId:'chk',active:true}];
  S.settings.buffer=200000;
  _discInvalidate(); save();
  openSafeModal();
  const html=$('sheet').innerHTML;
  const open=$('modal').classList.contains('open');
  closeModal();
  return {html,open};
});
ok('계산 근거 모달 열림', r.open);
ok('  항목별 내역 표시', /입출금 잔액/.test(r.html) && /고정비/.test(r.html) && /적금·청약/.test(r.html));
ok('  남겨둘 돈 반영', /남겨둘 돈/.test(r.html));
ok('  앞으로 나갈 돈 목록', /앞으로 나갈 돈/.test(r.html) && /월세/.test(r.html));

// 버퍼 저장 왕복
r = await p.evaluate(() => {
  openSafeModal();
  $('sf-buf').value='350000';
  saveBuffer();
  const v=S.settings.buffer;
  return {v, usable:safeSpend().usable};
});
ok('남겨둘 돈 저장 왕복', r.v===350000, String(r.v));

console.log(errs.length? '❌ 콘솔/페이지 오류:\n'+errs.join('\n') : '✅ 오류 없음');
if(errs.length)process.exitCode=1;
await b.close();
