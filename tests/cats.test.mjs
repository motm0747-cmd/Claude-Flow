/* 카테고리 추가 + 기존 사용자 보강(migrateCats) + 카드 한도 미확인 경고 */
import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

const NEW=['데이트','골프','배달','편의점','택시','생활용품','보험','선물'];

// ① 기본 목록에 새 카테고리가 있는지
let r = await p.evaluate(NEW => {
  S.cats=null; save();
  const names=EXP_CATS.map(x=>x[1]);
  return {names, emo:Object.fromEntries(NEW.map(n=>[n,CAT_EMO[n]||''])), total:names.length};
}, NEW);
ok('새 카테고리 8종 모두 등록', NEW.every(n=>r.names.includes(n)),
   NEW.filter(n=>!r.names.includes(n)).join(',')||'전부 있음');
ok('  이모지 지정됨', NEW.every(n=>r.emo[n]&&r.emo[n]!=='💸'), JSON.stringify(r.emo));
ok('  지출 카테고리 32개', r.total===32, String(r.total));
ok('  비슷한 것끼리 인접 배치', r.names.indexOf('배달')===r.names.indexOf('카페/간식')+1
   && r.names.indexOf('택시')===r.names.indexOf('교통')+1, r.names.slice(0,9).join(' > '));

// ② 거래 입력 화면 카테고리 선택지에 나오는지
r = await p.evaluate(() => {
  openTxModal(); txDraft.type='expense'; renderTxModal();
  // 격자는 접혀 있는 게 기본 — 매일 쓰는 칸이 32칸에 밀리지 않게
  const collapsed = document.querySelectorAll('#sheet .cat-cell').length;
  txToggleCat();                       // '바꾸기'를 누른 상태
  const html=$('sheet').innerHTML, cells=document.querySelectorAll('#sheet .cat-cell').length;
  closeModal(); return {html, collapsed, cells};
});
ok('카테고리 격자는 기본으로 접혀 있음', r.collapsed===0, `${r.collapsed}칸`);
ok('  한 번 누르면 32칸이 전부 나옴', r.cells===32, `${r.cells}칸`);
ok('지출 입력 화면에 노출', /데이트/.test(r.html) && /골프/.test(r.html) && /편의점/.test(r.html));

// ③ 이미 카테고리를 손댄 사용자에게도 한 번은 들어가는지 (migrateCats)
r = await p.evaluate(() => {
  S.cats={exp:[['🍚','식비'],['🍻','술/유흥'],['🐙','내가만든칸']],inc:[['💼','급여']]};
  S.catsV=0; save();
  migrateCats();
  const names=EXP_CATS.map(x=>x[1]);
  return {names, mine:names.includes('내가만든칸'), v:S.catsV};
});
ok('커스텀 목록에도 새 카테고리 보강', NEW.every(n=>r.names.includes(n)),
   NEW.filter(n=>!r.names.includes(n)).join(',')||'전부 있음');
ok('  사용자가 만든 칸은 유지', r.mine===true);
ok('  버전 표시 저장', r.v===2, String(r.v));

// ④ 직접 지운 카테고리가 되살아나지 않는지
r = await p.evaluate(() => {
  S.cats={exp:EXP_CATS.filter(x=>x[1]!=='골프').map(x=>x.slice())}; save();  // 골프 삭제 (버전은 이미 2)
  migrateCats();
  return {has:EXP_CATS.map(x=>x[1]).includes('골프'), v:S.catsV};
});
ok('지운 카테고리는 되살아나지 않음', r.has===false);

// ⑤ 기본 상수를 오염시키지 않는지 (참조 공유 사고 방지)
r = await p.evaluate(() => {
  S.cats={exp:[['🍚','식비']],inc:[['💼','급여']]}; S.catsV=0; save();
  migrateCats();
  const mine=S.cats.exp.find(x=>x[1]==='데이트');
  mine[0]='🔥';                      // 사용자가 이모지를 바꿨다고 가정
  S.cats=null; save();               // 기본값으로 되돌림
  return CAT_EMO['데이트'];
});
ok('기본 카테고리 상수가 오염되지 않음', r==='💕', `기본 이모지 ${r}`);

// ⑥ 카드: 한도 미입력 고율 혜택에 경고가 뜨는지
r = await p.evaluate(() => {
  S.cats=null;
  S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:3000000,cur:'KRW'}];
  S.cards=[]; S.tx=[];
  openCardModal();
  cardDraft.name='하나 MOVING ONLINE'; cardDraft.type='credit'; cardDraft.payDay=14; cardDraft.accountId='chk';
  applyPerkPreset('hana-3day-2x'); saveCard();
  const ym=thisYM(), pm=prevYM(ym), cid=S.cards[0].id;
  S.tx=[{id:uid(),type:'expense',date:`${pm}-05`,amount:600000,cat:'쇼핑',memo:'실적',payKind:'card',payId:cid,months:1,paidPortions:0},
        {id:uid(),type:'expense',date:`${ym}-09`,amount:17000,cat:'구독',memo:'넷플릭스',payKind:'card',payId:cid,months:1,paidPortions:0}];
  _discInvalidate(); save(); switchView('cards'); renderCards();
  const html=$('card-list').innerHTML;
  const taxi=S.cards[0].perks.find(x=>x.name==='택시');
  return {html, taxiCat:taxi.cat, name:PERK_PRESETS[0].name};
});
ok('한도 미입력 혜택에 경고 표시', /무제한으로 계산/.test(r.html));
ok('  해당 결제가 없는 혜택엔 경고 안 뜸(노이즈 방지)',
   (r.html.match(/무제한으로 계산/g)||[]).length===1, `${(r.html.match(/무제한으로 계산/g)||[]).length}건 (넷플릭스 결제가 있는 스트리밍만)`);
ok('택시 혜택 카테고리 갱신', r.taxiCat==='택시', r.taxiCat);
ok('프리셋 이름에 카드명 반영', /MOVING ONLINE/.test(r.name), r.name);

console.log(errs.length? '❌ 콘솔/페이지 오류:\n'+errs.join('\n') : '✅ 오류 없음');
if(errs.length)process.exitCode=1;
await b.close();
