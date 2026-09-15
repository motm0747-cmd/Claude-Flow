import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(600);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

const r = await p.evaluate(() => {
  const YM = thisYM();
  const D = n => `${YM}-${String(n).padStart(2,'0')}`;
  const out = {};
  // 프리셋 그대로 카드 구성
  const ps = PERK_PRESETS[0];
  S.accounts=[{id:'a1',type:'checking',name:'주',balance:5000000,cur:'KRW'}];
  S.cards=[{id:'c1',type:'credit',name:'하나 3일2배',accountId:'a1',payDay:14,
    tiers:ps.tiers.slice(),target:ps.tiers[0],exclCats:[],annualFee:0,
    perks:ps.perks.map(x=>({...x,id:uid()}))}];
  out.presetPerks = S.cards[0].perks.length;

  const tx=(date,amount,cat,memo,via)=>({id:uid(),type:'expense',date,amount,cat,memo,
    payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:0,via:via||''});

  // ── 전월 실적 60만원 (ONLINE 적립 조건 50만 충족) ──
  const pm = prevYM(YM);
  S.tx=[{id:'pm1',type:'expense',date:pm+'-10',amount:600000,cat:'쇼핑',memo:'전월실적',
         payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:0}];

  // ── 이번 달 ──
  // 국내외 일반결제 3일 연속 (1,2,3일) 각 10,000원
  S.tx.push(tx(D(1),10000,'식비','동네식당'));
  S.tx.push(tx(D(2),10000,'식비','동네식당'));
  S.tx.push(tx(D(3),10000,'식비','동네식당'));
  // 간편결제 3일 연속 (5,6,7일) 각 20,000원
  S.tx.push(tx(D(5),20000,'쇼핑','쿠팡',              'simple'));
  S.tx.push(tx(D(6),20000,'쇼핑','쿠팡',              'simple'));
  S.tx.push(tx(D(7),20000,'쇼핑','쿠팡',              'simple'));
  // AI 구독 (Claude) 29,000 → 50% = 14,500 이지만 한도 1만
  S.tx.push(tx(D(10),29000,'구독','Claude Pro'));
  // 택시 8,000 → 50% = 4,000 (한도 5천 미만)
  S.tx.push(tx(D(11),8000,'교통','카카오T 택시'));
  // 푸드 스타벅스 6,000 + 맥도날드 9,000 → 50% = 7,500 이지만 한도 5천
  S.tx.push(tx(D(12),6000,'카페/간식','스타벅스 강남'));
  S.tx.push(tx(D(13),9000,'식비','맥도날드'));
  _discInvalidate();

  const E = perkEstimates(S.cards[0], YM);
  const byName = {}; E.forEach(e=>byName[e.p.name]={est:e.est,n:e.n,boostN:e.boostN,active:e.active,capped:e.capped});
  out.E = byName;
  out.total = E.reduce((s,e)=>s+e.est,0);

  // ── 연속 조건이 끊기면? (1,2,4일) ──
  S.tx=S.tx.filter(t=>t.date!==D(3));
  S.tx.push(tx(D(4),10000,'식비','동네식당'));
  _discInvalidate();
  out.brokenStreak = perkEstimates(S.cards[0],YM).find(e=>e.p.name==='국내외 가맹점 기본적립');

  // ── 전월 실적 미달이면 ONLINE 적립이 잠기는가 ──
  S.tx=S.tx.filter(t=>t.id!=='pm1');
  S.tx.push({id:'pm2',type:'expense',date:pm+'-10',amount:100000,cat:'쇼핑',memo:'전월실적',
             payKind:'card',payId:'c1',fxAt:1380,months:1,paidPortions:0});
  _discInvalidate();
  const E2=perkEstimates(S.cards[0],YM);
  out.locked = { ai:E2.find(e=>e.p.name==='AI 구독').active,
                 base:E2.find(e=>e.p.name==='국내외 가맹점 기본적립').active,
                 simple:E2.find(e=>e.p.name==='온라인 간편결제').active };
  return out;
});

ok('프리셋 혜택 7개', r.presetPerks===7, String(r.presetPerks));

const b1 = r.E['국내외 가맹점 기본적립'];
ok('기본적립: 간편결제 건은 제외됨', b1.n===7, `대상 ${b1.n}건 (간편결제 3건 빠져야 함)`);
ok('  3일 연속 → 3일째만 2배', b1.boostN>=1, `부스트 적용 ${b1.boostN}건`);

const sp = r.E['온라인 간편결제'];
ok('간편결제: 간편결제 건만 3건', sp.n===3, `${sp.n}건`);
ok('  3일 연속 → 3일째 3.0% 적용', sp.boostN===1, `부스트 ${sp.boostN}건`);
// 20,000×1.5% ×2 + 20,000×3.0% ×1 = 300+300+600 = 1,200
ok('  적립액 1,200원', sp.est===1200, `${sp.est}원`);

const ai = r.E['AI 구독'];
ok('AI 구독: 가맹점 이름으로 매칭', ai.n===1, `${ai.n}건`);
ok('  월 한도 1만에서 잘림', ai.est===10000 && ai.capped===true, `${ai.est}원`);

const taxi = r.E['택시'];
ok('택시: 50% = 4,000원', taxi.est===4000, `${taxi.est}원`);

const food = r.E['푸드 (커피·패스트푸드)'];
ok('푸드: 2건 매칭 후 한도 5천에서 잘림', food.n===2 && food.est===5000, `${food.n}건 ${food.est}원`);

// 연속 판정 자체를 직접 검증 (기본적립은 '전체' 카테고리라 다른 결제로 연속이 이어진다)
const sq = await p.evaluate(() => ({
  run3:      [...streakQualified(['2026-08-01','2026-08-02','2026-08-03'],3)],
  broken:    [...streakQualified(['2026-08-01','2026-08-02','2026-08-04'],3)],
  long:      [...streakQualified(['2026-08-01','2026-08-02','2026-08-03','2026-08-04'],3)],
  dupSameDay:[...streakQualified(['2026-08-01','2026-08-01','2026-08-02','2026-08-03'],3)],
  monthEdge: [...streakQualified(['2026-07-30','2026-07-31','2026-08-01'],3)],
  noCond:    [...streakQualified(['2026-08-05'],1)],
}));
ok('연속 3일 → 3일째만 부스트', sq.run3.length===1 && sq.run3[0]==='2026-08-03', sq.run3.join(','));
ok('  하루 건너뛰면 부스트 없음', sq.broken.length===0, sq.broken.join(',')||'없음');
ok('  4일 연속이면 3·4일째', sq.long.length===2, sq.long.join(','));
ok('  같은 날 2건은 하루로 셈', sq.dupSameDay.length===1 && sq.dupSameDay[0]==='2026-08-03', sq.dupSameDay.join(','));
ok('  월을 넘겨도 연속 인정', sq.monthEdge.length===1 && sq.monthEdge[0]==='2026-08-01', sq.monthEdge.join(','));
ok('  조건 없으면(1일) 전부 적용', sq.noCond.length===1);

ok('전월 실적 미달 → AI 구독 잠김', r.locked.ai===false);
ok('  실적 무관 혜택은 계속 열림', r.locked.base===true && r.locked.simple===true);

ok('오류 없음', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
if(errs.length)errs.forEach(e=>console.log(' '+e));
