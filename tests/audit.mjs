/* 최종 점검 — PC / 아이패드 / 아이폰 × 라이트·다크 × 빈 상태·데이터 상태
   화면이 깨지는지(가로 스크롤·넘침·겹침), 모달이 죽는지, 콘솔 오류가 나는지 본다. */
import { chromium, APP, BASE } from './lib/env.mjs';
const b = await chromium.launch();
const issues = [];
const add = (dev, theme, state, msg) => issues.push({ dev, theme, state, msg });

const DEVICES = [
  { w: 390,  h: 844,  label: '아이폰 (390×844)',    mobile: true },
  { w: 430,  h: 932,  label: '아이폰 Max (430×932)', mobile: true },
  { w: 834,  h: 1194, label: '아이패드 (834×1194)',  mobile: false },
  { w: 1024, h: 1366, label: '아이패드 Pro (1024×1366)', mobile: false },
  { w: 1512, h: 982,  label: 'PC 노트북 (1512×982)', mobile: false },
  { w: 1920, h: 1080, label: 'PC 대형 (1920×1080)',  mobile: false },
];

const MODALS = [
  'openTxModal','openSettings','openCardModal','openFxModal','openCatModal','openResetModal',
  'openBudgetModal','openWishModal','openGoalModal','openDebtModal','openReconModal','openFixedModal',
  'openAccModal','openDcaTargetModal','openFxFailModal','openVersionsModal','openAskModal',
  'openFixCheckModal','openSafeModal','openAllocExecModal','openCardPickModal','openFlowAI','openPerkPreset','openPrepayModal',
];

const VIEWS = ['home','cal','assets','cards','report'];

// 실제 사용 상황에 가까운 시드
const SEED = () => {
  const t = todayStr(), D = n => +addDays(t, n).slice(8, 10);
  S.accounts = [
    { id:'chk', type:'checking', name:'카카오뱅크 입출금', balance:2400000, cur:'KRW' },
    { id:'sav', type:'saving',   name:'청년도약계좌', balance:8400000, cur:'KRW', monthly:700000, payDay:D(6), payFrom:'chk', rate:4.5, maturity:'2028-06-30' },
    { id:'hou', type:'housing',  name:'주택청약종합저축', balance:2600000, cur:'KRW', monthly:100000, payDay:D(6), payFrom:'chk', joinDate:'2023-03-10' },
    { id:'dep', type:'deposit',  name:'정기예금', balance:5000000, cur:'KRW', rate:3.8, maturity:'2027-01-15' },
    { id:'inv1',type:'invest',   name:'국내주식(키움)', balance:3200000, cur:'KRW', invKind:'domestic',
      fees:{buy:0.015,sell:0.015,etc:0.0036,min:0,from:'',to:''} },
    { id:'inv2',type:'invest',   name:'미국주식(토스)', balance:4300, cur:'USD', invKind:'overseas',
      fees:{buy:0.07,sell:0.07,etc:0,min:0,from:'2026-01-01',to:'2026-12-31'},
      fxPref:{spread:1,pref:90,from:'2026-01-01',to:'2026-10-15'} },
    { id:'isa', type:'invest',   name:'ISA (중개형)', balance:2100000, cur:'KRW', invKind:'tax', taxKind:'isa', yearCap:20000000,
      fees:{buy:0.01,sell:0.01,etc:0,min:0,from:'',to:''} },
  ];
  S.cards = [
    { id:'c1', type:'credit', name:'하나 MOVING ONLINE', accountId:'chk', payDay:D(9), tiers:[500000], exclCats:[], perks:[], annualFee:15000 },
    { id:'c2', type:'check',  name:'카카오 체크', accountId:'chk', tiers:[], exclCats:[], perks:[] },
  ];
  // 하나카드 프리셋 적용
  cardDraft = { ...S.cards[0], tiersText:'500000', perks:[] };
  applyPerkPreset('hana-3day-2x');
  S.cards[0].perks = cardDraft.perks;

  S.fixed = [
    { id:'f1', kind:'income',  name:'급여',    amount:2850000, day:D(13), cat:'급여',  payKind:'account', payId:'chk', active:true },
    { id:'f2', kind:'expense', name:'월세',    amount:550000,  day:D(4),  cat:'주거',  payKind:'account', payId:'chk', active:true },
    { id:'f3', kind:'expense', name:'통신비',  amount:39000,   day:D(8),  cat:'통신',  payKind:'account', payId:'chk', active:true },
    { id:'f4', kind:'expense', name:'넷플릭스',amount:13500,   day:D(11), cat:'구독',  payKind:'card',    payId:'c1',  active:true },
  ];
  S.tx = [];
  const cats = ['식비','카페/간식','배달','편의점','교통','택시','쇼핑','생활용품','데이트','골프','문화/여가','의료'];
  const memos = ['점심','스타벅스','배민','GS25','지하철','카카오T','무신사','다이소','영화관','스크린골프','넷플릭스','약국'];
  for (let m = 0; m < 6; m++) {
    const d = new Date(); d.setMonth(d.getMonth() - m);
    const ym = `${d.getFullYear()}-${pad(d.getMonth()+1)}`;
    S.tx.push({ id:uid(), type:'income', date:`${ym}-13`, amount:2850000, cat:'급여', memo:'월급', payKind:'account', payId:'chk' });
    for (let k = 0; k < 14; k++) {
      S.tx.push({ id:uid(), type:'expense', date:`${ym}-${pad((k*2)+1)}`, amount:9000+k*3700,
        cat:cats[k%cats.length], memo:memos[k%memos.length], payKind:'card', payId:k%3===0?'c2':'c1',
        via:k%5===0?'simple':'', months:k===7?3:1, paidPortions:m>0?1:0 });
    }
  }
  S.budgets = { [thisYM()]: { total:1200000, cats:{ '식비':400000, '카페/간식':120000, '데이트':200000 }, rollover:true } };
  S.goals = [{ id:uid(), name:'유럽 여행자금', target:3000000, saved:900000, due:'2027-06-30' }];
  S.debts = [
    { id:uid(), dir:'payable',    person:'한국장학재단', amount:12000000, date:'2024-03-02', memo:'학자금대출',
      due:'2029-03-31', accountId:'', settled:false, settledDate:'' },
    { id:uid(), dir:'receivable', person:'김민수', amount:150000, date:addDays(todayStr(),-40), memo:'여행비',
      due:addDays(todayStr(),-5), accountId:'chk', settled:false, settledDate:'' },   // 기한 지난 케이스
  ];
  S.wish  = [
    { id:uid(), name:'아이패드 프로', amount:1500000, date:todayStr(), cool:14, status:'open', decidedAt:'' },
    // 쿨다운이 끝난 항목(버튼 3개가 한 줄에 들어가는지 확인용)
    { id:uid(), name:'무선 이어폰', amount:329000, date:addDays(todayStr(),-30), cool:14, status:'open', decidedAt:'' },
  ];
  S.alloc = { cash:20, safe:50, invest:30 };
  S.settings.buffer = 300000;
  S.settings.fx = { usdkrw:1385, hist:{} };
  for (let i=0;i<40;i++){ const d=new Date(); d.setDate(d.getDate()-i);
    S.settings.fx.hist[`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`]=1350+Math.round(Math.sin(i/4)*40); }
  S.invLogs = [];
  for (let m=0;m<4;m++){ const d=new Date(); d.setMonth(d.getMonth()-m);
    S.invLogs.push({ id:uid(), accountId:'inv1', date:`${d.getFullYear()}-${pad(d.getMonth()+1)}-10`, amount:300000, cur:'KRW', fxAt:1 }); }
  _discInvalidate(); save();
};

// 레이아웃 문제 탐지
const LAYOUT_PROBE = () => {
  const out = { hScroll:null, overflow:[], tiny:[], offscreen:[] };
  const de = document.documentElement;
  if (de.scrollWidth > de.clientWidth + 1)
    out.hScroll = { scrollWidth:de.scrollWidth, clientWidth:de.clientWidth };

  const vw = de.clientWidth;
  document.querySelectorAll('.card, .banner, .hero, .sheet, .tabbar, .bar-row, .tx, .a-row, button, input, select')
    .forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden') return;
      // 화면 밖으로 삐져나감
      if (r.right > vw + 1 || r.left < -1) {
        const id = el.id ? '#'+el.id : (el.className && typeof el.className==='string' ? '.'+el.className.split(' ')[0] : el.tagName);
        out.offscreen.push({ sel:id, left:Math.round(r.left), right:Math.round(r.right), vw,
          text:(el.textContent||'').trim().slice(0,28) });
      }
      // 내용이 컨테이너를 넘침(잘림)
      if (el.scrollWidth > el.clientWidth + 2 && st.overflowX !== 'auto' && st.overflowX !== 'scroll') {
        const id = el.id ? '#'+el.id : (el.className && typeof el.className==='string' ? '.'+el.className.split(' ')[0] : el.tagName);
        out.overflow.push({ sel:id, scrollW:el.scrollWidth, clientW:el.clientWidth,
          text:(el.textContent||'').trim().slice(0,28) });
      }
    });
  // 모바일 터치 타깃(44px 권장) — 실제로 누르는 버튼만
  document.querySelectorAll('button:not([disabled])').forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    if (r.height < 30) out.tiny.push({ text:(el.textContent||'').trim().slice(0,20), h:Math.round(r.height) });
  });
  return out;
};

for (const dev of DEVICES) {
  for (const theme of ['light','dark']) {
    const p = await b.newPage({ viewport:{ width:dev.w, height:dev.h },
      deviceScaleFactor: dev.mobile ? 3 : 2, isMobile: dev.mobile, hasTouch: dev.mobile });
    const tag = `${dev.label}/${theme}`;
    p.on('pageerror', e => add(dev.label, theme, '-', `PAGEERROR: ${e.message}`));
    p.on('console', m => { const t = m.text();
      if (m.type()==='error' && !/net::|ERR_|Failed to load resource/.test(t)) add(dev.label, theme, '-', `CONSOLE: ${t}`); });

    await p.goto(BASE + '/', { waitUntil:'domcontentloaded' });
    await p.evaluate(t => localStorage.setItem('claudeflow_theme', t), theme);
    await p.reload({ waitUntil:'domcontentloaded' });
    await p.waitForTimeout(350);

    for (const state of ['빈 상태','데이터 있음']) {
      if (state === '데이터 있음') { await p.evaluate(SEED); await p.waitForTimeout(200); }

      for (const v of VIEWS) {
        await p.evaluate(x => switchView(x), v);
        await p.waitForTimeout(90);
        const L = await p.evaluate(LAYOUT_PROBE);
        if (L.hScroll) add(dev.label, theme, state, `[${v}] 가로 스크롤 발생 (${L.hScroll.scrollWidth}px > ${L.hScroll.clientWidth}px)`);
        L.offscreen.slice(0,3).forEach(o => add(dev.label, theme, state, `[${v}] 화면 밖 넘침 ${o.sel} (right ${o.right} > ${o.vw}) "${o.text}"`));
        L.overflow.slice(0,3).forEach(o => add(dev.label, theme, state, `[${v}] 내용 잘림 ${o.sel} (${o.scrollW} > ${o.clientW}) "${o.text}"`));
        if (dev.mobile) L.tiny.slice(0,2).forEach(o => add(dev.label, theme, state, `[${v}] 터치 타깃 작음 "${o.text}" ${o.h}px`));
      }

      // 모달 전수
      for (const m of MODALS) {
        const res = await p.evaluate(n => { try { window[n](); return 'ok'; } catch(e) { return 'THROW: '+e.message; } }, m);
        if (res !== 'ok') { add(dev.label, theme, state, `모달 ${m} → ${res}`); continue; }
        await p.waitForTimeout(70);
        const open = await p.evaluate(() => document.getElementById('modal').classList.contains('open'));
        if (open) {
          const L = await p.evaluate(LAYOUT_PROBE);
          if (L.hScroll) add(dev.label, theme, state, `모달 ${m}: 가로 스크롤 (${L.hScroll.scrollWidth}px)`);
          L.offscreen.slice(0,2).forEach(o => add(dev.label, theme, state, `모달 ${m}: 화면 밖 ${o.sel} "${o.text}"`));
          L.overflow.slice(0,2).forEach(o => add(dev.label, theme, state, `모달 ${m}: 잘림 ${o.sel} "${o.text}"`));
        }
        await p.evaluate(() => { try { closeModal(); } catch(e) {} });
        await p.waitForTimeout(40);
      }
    }
    await p.close();
  }
  process.stdout.write(`  ${dev.label} 완료\n`);
}
await b.close();

console.log('\n════════ 결과 ════════');
if (!issues.length) { console.log('✅ 화면 문제 없음'); }
else {
  // 같은 문제가 여러 기기에서 반복되므로 메시지 기준으로 묶는다
  const byMsg = new Map();
  issues.forEach(i => {
    const k = i.msg.replace(/\d+/g, 'N');
    if (!byMsg.has(k)) byMsg.set(k, { sample:i, devs:new Set(), n:0 });
    const g = byMsg.get(k); g.devs.add(i.dev); g.n++;
  });
  console.log(`⚠️ ${byMsg.size}종류 / 총 ${issues.length}건\n`);
  [...byMsg.values()].sort((a,b)=>b.n-a.n).forEach(g => {
    console.log(`■ ${g.sample.msg}`);
    console.log(`   ${g.n}건 · ${[...g.devs].join(', ')}\n`);
  });
}
process.exitCode = 0;
