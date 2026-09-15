/* 입력 편의 — ② 직전 결제수단·시간대 카테고리 ④ 메모 자동완성·가맹점 학습 ③ 빠른 입력 묶기 */
import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

await p.evaluate(`window.seedFn = ${(()=>{
  const ym=thisYM();
  S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:2000000,cur:'KRW'}];
  S.cards=[{id:'c1',type:'credit',name:'하나카드',accountId:'chk',payDay:14,tiers:[],exclCats:[],perks:[],prepays:[]},
           {id:'c2',type:'check',name:'카카오체크',accountId:'chk',tiers:[],exclCats:[],perks:[],prepays:[]}];
  S.tx=[]; S.quick=[]; S.quickHide=[]; S.settings.lastPay=null;
  // 스타벅스를 카카오체크 + 카페/간식 으로 5번 (금액은 매번 다름)
  [4500,5000,5500,4800,5200].forEach((a,i)=>S.tx.push({id:uid(),type:'expense',date:`${ym}-0${i+1}`,
    amount:a,cat:'카페/간식',memo:'스타벅스',payKind:'card',payId:'c2',months:1,paidPortions:0}));
  // 넷플릭스는 하나카드 + 구독 으로 3번 (금액 동일)
  [13500,13500,13500].forEach((a,i)=>S.tx.push({id:uid(),type:'expense',date:`${ym}-1${i}`,
    amount:a,cat:'구독',memo:'넷플릭스',payKind:'card',payId:'c1',months:1,paidPortions:0}));
  _discInvalidate(); save();
}).toString()}`);

/* ══════ ④ 가맹점 학습 ══════ */
let r = await p.evaluate(() => { seedFn();
  const mm=merchantMemory();
  return {n:mm.length, sb:mm.find(x=>x.label==='스타벅스'), nf:mm.find(x=>x.label==='넷플릭스')}; });
ok('가맹점 기억 생성', r.n===2, `${r.n}곳`);
ok('  스타벅스 → 카페/간식 · 카카오체크', r.sb.cat==='카페/간식' && r.sb.payId==='c2', `${r.sb.cat}/${r.sb.payId}`);
ok('  금액이 매번 달라 fixed=false', r.sb.fixed===false && r.sb.last===5200, `최근 ${r.sb.last}`);
ok('  넷플릭스는 금액 고정', r.nf.fixed===true && r.nf.last===13500);

// 메모를 치면 카테고리·결제수단이 자동으로 채워진다
r = await p.evaluate(async () => {
  openTxModal();
  const before={cat:txDraft.cat, pay:txDraft.payId};
  $('tx-memo').value='스타벅스'; onMemoInput();
  return {before, after:{cat:txDraft.cat, pay:txDraft.payId},
    sel:$('tx-pay').value, hint:$('tx-memo-hint').textContent,
    onCell:[...document.querySelectorAll('#sheet .cat-cell.on')].map(c=>c.textContent.trim())};
});
ok('메모 입력 → 카테고리 자동 선택', r.after.cat==='카페/간식', `${r.before.cat} → ${r.after.cat}`);
ok('  결제수단도 자동 선택', r.after.pay==='c2' && r.sel==='card|c2', r.sel);
ok('  화면의 카테고리 칸도 함께 갱신', r.onCell.some(t=>t.includes('카페/간식')), r.onCell.join(','));
ok('  무엇이 채워졌는지 알려줌', /자동 선택/.test(r.hint), r.hint.slice(0,50));
ok('  지난번 금액도 힌트로', /지난번/.test(r.hint));

// 사용자가 직접 고른 값은 절대 덮지 않는다
r = await p.evaluate(() => {
  openTxModal();
  syncTxDraft(); txDraft.cat='골프'; txDraft.autoCat=false; renderTxModal();   // 직접 고름
  $('tx-memo').value='스타벅스'; onMemoInput();
  return {cat:txDraft.cat, hint:$('tx-memo-hint').textContent};
});
ok('직접 고른 카테고리는 안 덮음', r.cat==='골프', r.cat);

r = await p.evaluate(() => {
  openTxModal();
  txDraft.autoPay=false; txDraft.payKind='card'; txDraft.payId='c1';
  $('tx-memo').value='스타벅스'; onMemoInput();
  return txDraft.payId;
});
ok('직접 고른 결제수단도 안 덮음', r==='c1', r);

// 모르는 가맹점이면 아무것도 안 건드린다
r = await p.evaluate(() => {
  openTxModal();
  const before=txDraft.cat;
  $('tx-memo').value='처음가보는집'; onMemoInput();
  return {before, after:txDraft.cat, hint:$('tx-memo-hint').textContent};
});
ok('모르는 가맹점이면 그대로', r.before===r.after && r.hint==='');

// 자동완성 목록(datalist)
r = await p.evaluate(() => {
  openTxModal();
  return [...document.querySelectorAll('#tx-memo-list option')].map(o=>o.value);
});
ok('메모 자동완성 목록 제공', r.includes('스타벅스') && r.includes('넷플릭스'), r.join(','));

// 입력 도중 포커스가 날아가지 않아야 한다 (renderTxModal 을 부르면 안 됨)
r = await p.evaluate(async () => {
  openTxModal();
  const el=$('tx-memo'); el.focus();
  el.value='스타벅'; el.dispatchEvent(new Event('input',{bubbles:true}));
  const keptFocus=document.activeElement===$('tx-memo');
  const sameNode=el===$('tx-memo');
  return {keptFocus,sameNode};
});
ok('입력 중 포커스 유지 (입력칸이 다시 그려지지 않음)', r.keptFocus && r.sameNode,
   `focus=${r.keptFocus} sameNode=${r.sameNode}`);

/* ══════ ② 직전 결제수단 · 시간대 카테고리 ══════ */
r = await p.evaluate(() => {
  seedFn();
  openTxModal(); $('tx-amt').value='9000';
  syncTxDraft(); txDraft.cat='식비'; txDraft.payKind='card'; txDraft.payId='c1';
  saveTx();
  return S.settings.lastPay;
});
ok('저장하면 결제수단을 기억', r && r.payKind==='card' && r.payId==='c1', JSON.stringify(r));

r = await p.evaluate(() => { openTxModal(); return {kind:txDraft.payKind, id:txDraft.payId}; });
ok('  다음 입력이 그 결제수단으로 시작', r.kind==='card' && r.id==='c1', `${r.kind}/${r.id}`);

// 지운 카드로는 되돌아가지 않는다
r = await p.evaluate(() => {
  S.settings.lastPay={payKind:'card',payId:'삭제된카드'}; save();
  openTxModal(); return txDraft.payId;
});
ok('  없어진 결제수단이면 무시', r!=='삭제된카드', r||'(비움)');

// 시각 기록 — 시간대 학습의 재료
r = await p.evaluate(() => {
  seedFn();
  openTxModal(); $('tx-amt').value='5000'; syncTxDraft(); saveTx();
  const t=S.tx[S.tx.length-1];
  return {at:t.at, hasAuto:('autoCat' in t)||('autoPay' in t)||('catWhy' in t)};
});
ok('새 내역에 시각 기록', /^\d\d:\d\d$/.test(r.at||''), r.at);
ok('  입력 보조용 임시 필드는 저장 안 됨', r.hasAuto===false);

// 시간대 표본이 쌓이면 그 시간대 카테고리를 추천
r = await p.evaluate(() => {
  seedFn();
  const ym=thisYM(), h=pad(new Date().getHours());
  for(let i=0;i<6;i++)S.tx.push({id:uid(),type:'expense',date:`${ym}-0${i+1}`,amount:9000,
    cat:'술/유흥',memo:'',payKind:'card',payId:'c1',at:`${h}:10`,months:1,paidPortions:0});
  _discInvalidate(); save();
  return suggestCat();
});
ok('시간대 표본이 쌓이면 그 카테고리 추천', r.cat==='술/유흥' && /에 자주/.test(r.why), `${r.cat} (${r.why})`);

// 표본이 모자라면 '최근 자주 쓰는' 으로 물러선다
r = await p.evaluate(() => { seedFn(); return suggestCat(); });
ok('  표본 부족하면 최근 빈도로 대체', r.cat==='카페/간식' && /최근/.test(r.why), `${r.cat} (${r.why})`);

r = await p.evaluate(() => { S.tx=[]; _discInvalidate(); save(); return suggestCat(); });
ok('  기록이 아예 없으면 식비', r.cat==='식비');

/* ══════ ③ 빠른 입력 묶기 ══════ */
r = await p.evaluate(() => { seedFn(); return quickList(); });
ok('금액이 달라도 한 항목으로 묶임', r.some(q=>q.memo==='스타벅스'),
   r.map(q=>`${q.memo}(${q.n}회)`).join(', '));
ok('  최근 금액을 씀', (r.find(q=>q.memo==='스타벅스')||{}).amount===5200);
ok('  변동/고정 구분', r.find(q=>q.memo==='스타벅스').fixed===false
   && r.find(q=>q.memo==='넷플릭스').fixed===true);

// 고정 금액은 탭하면 바로 기록
r = await p.evaluate(() => {
  seedFn(); switchView('home'); renderHome();
  const i=quickList().findIndex(q=>q.memo==='넷플릭스');
  const before=S.tx.length;
  runQuick(i);
  const t=S.tx[S.tx.length-1];
  return {added:S.tx.length-before, amount:t.amount, modal:$('modal').classList.contains('open'), at:t.at};
});
ok('고정 금액 → 바로 기록', r.added===1 && r.amount===13500 && r.modal===false, `${r.amount}원`);
ok('  빠른 입력에도 시각 기록', /^\d\d:\d\d$/.test(r.at||''), r.at);

// 변동 금액은 입력창을 열어 확인
r = await p.evaluate(() => {
  seedFn(); switchView('home'); renderHome();
  const i=quickList().findIndex(q=>q.memo==='스타벅스');
  const before=S.tx.length;
  runQuick(i);
  return {added:S.tx.length-before, modal:$('modal').classList.contains('open'),
    amt:$('tx-amt')?$('tx-amt').value:null, memo:$('tx-memo')?$('tx-memo').value:null,
    cat:txDraft.cat, pay:txDraft.payId};
});
ok('변동 금액 → 바로 기록하지 않음', r.added===0 && r.modal===true);
ok('  최근 금액을 채워서 열어줌', r.amt==='5200', r.amt);
ok('  가맹점·카테고리·결제수단도 채워짐', r.memo==='스타벅스' && r.cat==='카페/간식' && r.pay==='c2');

// 숨김이 금액 변화로 풀리지 않는다
r = await p.evaluate(() => {
  seedFn();
  const q=quickList().find(x=>x.memo==='스타벅스');
  S.quickHide=[quickKey(q)]; save();
  const gone=!quickList().some(x=>x.memo==='스타벅스');
  // 금액이 다른 결제를 한 건 더 추가해도 되살아나면 안 된다
  S.tx.push({id:uid(),type:'expense',date:todayStr(),amount:6100,cat:'카페/간식',memo:'스타벅스',
    payKind:'card',payId:'c2',months:1,paidPortions:0});
  _discInvalidate(); save();
  return {gone, stillGone:!quickList().some(x=>x.memo==='스타벅스')};
});
ok('숨긴 항목은 금액이 바뀌어도 안 돌아옴', r.gone && r.stillGone);

// 화면 렌더
r = await p.evaluate(() => { seedFn(); switchView('home'); renderHome(); return $('quick-card').innerHTML; });
ok('빠른 입력 카드 렌더', /스타벅스/.test(r) && /넷플릭스/.test(r));
ok('  변동 항목에 ~ 표시', /~5,200|~5,2천|~/.test(r));
ok('  안내 문구', /금액이 매번 달라서/.test(r));

console.log(errs.length? '❌ 콘솔/페이지 오류:\n'+errs.join('\n') : '✅ 오류 없음');
if(errs.length)process.exitCode=1;
await b.close();
