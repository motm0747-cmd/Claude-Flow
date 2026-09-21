/* 실제 '손가락으로 누르는' 경로 검증 — 함수 직접 호출이 아니라 DOM 클릭으로만 조작한다.
   onclick 속성이 깨져도 기존 테스트는 통과하므로 이 층이 따로 필요하다. */
import { chromium, APP, BASE } from './lib/env.mjs';
const b = await chromium.launch();
const results = [];
const ok = (n, v, x='') => { console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v) process.exitCode = 1; };

for (const dev of [
  { w:390,  h:844,  label:'아이폰',   mobile:true  },
  { w:1024, h:1366, label:'아이패드', mobile:false },
  { w:1512, h:982,  label:'PC',      mobile:false },
]) {
  console.log(`\n──────── ${dev.label} (${dev.w}×${dev.h}) ────────`);
  const errs = [];
  const p = await b.newPage({ viewport:{width:dev.w,height:dev.h}, isMobile:dev.mobile, hasTouch:dev.mobile });
  p.on('pageerror', e => errs.push('PAGEERROR: '+e.message));
  p.on('console', m => { const t=m.text(); if(m.type()==='error'&&!/net::|ERR_|Failed to load/.test(t)) errs.push(t); });
  await p.goto(BASE + '/', { waitUntil:'domcontentloaded' });
  await p.waitForTimeout(400);

  // 계좌·카드 한 개씩은 있어야 결제수단이 나온다
  await p.evaluate(() => {
    S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:1000000,cur:'KRW'}];
    S.cards=[{id:'c1',type:'credit',name:'테스트카드',accountId:'chk',payDay:14,tiers:[],exclCats:[],perks:[]}];
    S.tx=[]; S.fixed=[]; _discInvalidate(); save(); renderAll();
  });
  await p.waitForTimeout(150);

  // ① 탭 이동 — 실제 탭 버튼 클릭
  let tabOk = true;
  for (const [v, name] of [['cal','내역'],['assets','자산'],['cards','카드'],['report','리포트'],['home','홈']]) {
    await p.click(`.tabbar button[data-v="${v}"]`);
    await p.waitForTimeout(120);
    const shown = await p.evaluate(x => document.getElementById('view-'+x).classList.contains('on'), v);
    const marked = await p.evaluate(x => document.querySelector(`.tabbar button[data-v="${x}"]`).classList.contains('on'), v);
    if (!shown || !marked) { tabOk = false; ok(`탭 이동 ${name}`, false, `표시 ${shown} / 활성표시 ${marked}`); }
  }
  ok('탭 5개 클릭 이동', tabOk);

  // ② FAB(＋) 클릭 → 입력 모달
  await p.click('.fab');
  await p.waitForTimeout(200);
  ok('＋ 버튼으로 입력창 열림', await p.evaluate(() => document.getElementById('modal').classList.contains('open')));

  // ③ 금액 입력 + 카테고리 클릭 + 저장 — 전부 실제 조작
  await p.fill('#tx-amt', '23000');
  // 카테고리는 칩으로 접혀 있다 — 눌러서 펼친 다음 고른다
  await p.click('.pick-chip');
  await p.waitForTimeout(150);
  const catCell = p.locator('.cat-cell', { hasText:'데이트' }).first();
  await catCell.click();
  await p.waitForTimeout(150);
  ok('  고르면 격자가 다시 접힘', await p.evaluate(() => document.querySelectorAll('.cat-cell').length===0));
  ok('새 카테고리(데이트) 클릭 선택', await p.evaluate(() => txDraft.cat === '데이트'), await p.evaluate(()=>txDraft.cat));
  await p.fill('#tx-memo', '영화관');
  await p.click('button:has-text("저장")');
  await p.waitForTimeout(250);

  const after = await p.evaluate(() => ({
    n:S.tx.length, t:S.tx[0], modalOpen:document.getElementById('modal').classList.contains('open'),
    bal:accById('chk').balance,
  }));
  ok('저장 버튼으로 거래 기록됨', after.n===1 && after.t.amount===23000 && after.t.cat==='데이트' && after.t.memo==='영화관',
     after.n ? `${after.t.cat} ${after.t.amount}원 "${after.t.memo}"` : '기록 없음');
  ok('  저장 후 모달 닫힘', after.modalOpen===false);
  ok('  신용카드 결제라 계좌 잔액 그대로', after.bal===1000000, `${after.bal}원`);

  // ④ 홈 최근 내역에 뜨는지 + 그 항목을 눌러 수정창 열기
  await p.click('.tabbar button[data-v="home"]');
  await p.waitForTimeout(200);
  const recentTxt = await p.evaluate(() => document.getElementById('recent-tx').textContent);
  ok('홈 최근 내역에 반영', /영화관/.test(recentTxt));
  await p.click('#recent-tx .tx');
  await p.waitForTimeout(200);
  ok('내역 눌러서 수정창 열림',
     await p.evaluate(() => document.getElementById('modal').classList.contains('open') &&
                            document.getElementById('sheet').textContent.includes('내역 수정')));

  // ⑤ 삭제 — confirm 자동 수락
  p.once('dialog', d => d.accept());
  await p.click('button:has-text("삭제")');
  await p.waitForTimeout(250);
  ok('삭제 버튼 동작', await p.evaluate(() => S.tx.length === 0));

  // ⑥ 홈 히어로 '계산 근거 보기' 클릭
  await p.evaluate(() => {
    S.fixed=[{id:'f1',kind:'income',name:'급여',amount:2800000,day:+addDays(todayStr(),10).slice(8,10),
      cat:'급여',payKind:'account',payId:'chk',active:true}];
    _discInvalidate(); save(); renderHome();
  });
  await p.waitForTimeout(150);
  await p.click('#h-lead-btn');
  await p.waitForTimeout(200);
  ok('히어로 → 계산 근거 모달',
     await p.evaluate(() => document.getElementById('sheet').textContent.includes('쓸 수 있는 돈')));
  await p.click('.sheet .x');            // ✕ 버튼으로 닫기
  await p.waitForTimeout(150);
  ok('  ✕ 버튼으로 닫힘', await p.evaluate(() => !document.getElementById('modal').classList.contains('open')));

  // ⑦ '더 보기' 접기/펼치기 클릭
  const before = await p.evaluate(() => document.getElementById('home-more').style.display);
  await p.click('#more-label');
  await p.waitForTimeout(150);
  const opened = await p.evaluate(() => document.getElementById('home-more').style.display);
  ok('더 보기 클릭으로 펼쳐짐', before==='none' && opened!=='none', `${before} → ${opened}`);

  // ⑧ 설정 버튼 → 설정 모달
  await p.click('button[onclick*="openSettings"]');
  await p.waitForTimeout(250);
  const setTxt = await p.evaluate(() => document.getElementById('sheet').textContent);
  ok('설정 버튼 동작', /설정/.test(setTxt));
  ok('  클라우드 동기화 섹션 노출(새 프로젝트 인식)', /동기화/.test(setTxt) && !/직접 입력해/.test(setTxt));
  await p.evaluate(() => closeModal());

  // ⑨ 모달 바깥 눌러서 닫기
  await p.click('.fab'); await p.waitForTimeout(200);
  await p.mouse.click(dev.w/2, 12);      // 오버레이 최상단
  await p.waitForTimeout(200);
  ok('바깥 눌러 모달 닫힘', await p.evaluate(() => !document.getElementById('modal').classList.contains('open')));

  ok('콘솔/페이지 오류 없음', errs.length===0, errs.slice(0,2).join(' | '));
  await p.close();
}

await b.close();
