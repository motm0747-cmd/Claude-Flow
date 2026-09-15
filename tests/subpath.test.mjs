/* GitHub Pages 하위 경로(/Claude-Flow/) 환경 검증 — 서비스워커 등록·PWA 설치·Supabase 인식 */
import { chromium } from './lib/env.mjs';
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
const errs=[], reqFail=[];
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
/* 외부망(폰트 CDN·환율 API)이 막힌 환경에서도 이 테스트는 '하위 경로 배포가 되는가'만 본다.
   차단된 네트워크 오류는 앱 결함이 아니므로 제외한다 — 폴백 동작은 각 기능 테스트가 따로 본다. */
const NET_BLOCKED=/Supabase|supabase\.co|net::ERR_(NAME|CONNECTION|INTERNET|TUNNEL|PROXY|CERT)|Failed to load resource/;
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!NET_BLOCKED.test(t))errs.push(t);});
p.on('requestfailed',r=>{const u=r.url(); if(!/supabase\.co|googleapis|frankfurter|er-api|jsdelivr|currency/.test(u))reqFail.push(`${u} — ${r.failure()?.errorText}`);});
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};

// 하위 경로 배포(GitHub Pages /Claude-Flow/) 를 흉내 낸 서버 — run.mjs 가 띄운다
const SUB_PORT = +(process.env.CF_TEST_SUBPORT || 8201);
const BASE = `http://127.0.0.1:${SUB_PORT}/Claude-Flow/`;
await p.goto(BASE,{waitUntil:'load'});
await p.waitForTimeout(1200);

ok('하위 경로에서 앱 로드', await p.evaluate(()=>typeof S!=='undefined'&&typeof renderHome==='function'));
ok('config.js 로드 (Supabase 설정 인식)',
   await p.evaluate(()=>!!(window.CLAUDE_FLOW_CONFIG&&window.CLAUDE_FLOW_CONFIG.supabaseUrl)),
   await p.evaluate(()=>(window.CLAUDE_FLOW_CONFIG||{}).supabaseUrl||''));
ok('  새 프로젝트를 가리키는지',
   await p.evaluate(()=>((window.CLAUDE_FLOW_CONFIG||{}).supabaseUrl||'').includes('qttsgvmmomjdjqhmlead')));
ok('  Sync 엔진이 설정됨으로 판정',
   await p.evaluate(()=>!!(window.Sync&&Sync.configured&&Sync.configured())));
ok('sync.js 로드', await p.evaluate(()=>typeof window.Sync==='object'));
ok('supabase 라이브러리 로드', await p.evaluate(()=>!!(window.supabase&&window.supabase.createClient)));

// 서비스워커 — 하위 경로에 정확히 등록되는지
const sw=await p.evaluate(async()=>{
  if(!navigator.serviceWorker) return {ok:false,why:'미지원'};
  const r=await navigator.serviceWorker.getRegistration();
  return r?{ok:true,scope:r.scope,active:!!(r.active||r.installing||r.waiting)}:{ok:false,why:'등록 없음'};
});
ok('서비스워커 등록', sw.ok && sw.scope.endsWith('/Claude-Flow/'), sw.ok?`scope ${sw.scope}`:sw.why);

// manifest — PWA 설치 정보가 하위 경로를 가리키는지
const man=await p.evaluate(async()=>{
  const l=document.querySelector('link[rel="manifest"]');
  const res=await fetch(l.href); const j=await res.json();
  return {href:l.href, start:new URL(j.start_url,l.href).pathname, scope:new URL(j.scope,l.href).pathname,
          icon:new URL(j.icons[0].src,l.href).pathname, name:j.name};
});
ok('manifest 로드', !!man.name, man.name);
ok('  start_url이 하위 경로', man.start==='/Claude-Flow/', man.start);
ok('  scope가 하위 경로', man.scope==='/Claude-Flow/', man.scope);
ok('  아이콘 경로', man.icon==='/Claude-Flow/icons/icon-192.png', man.icon);

// 실제 조작 한 바퀴
await p.evaluate(()=>{ S.accounts=[{id:'chk',type:'checking',name:'주거래',balance:500000,cur:'KRW'}];
  S.cards=[]; S.tx=[]; save(); renderAll(); });
await p.click('.fab'); await p.waitForTimeout(200);
await p.fill('#tx-amt','12000');
await p.locator('.cat-cell',{hasText:'편의점'}).first().click(); await p.waitForTimeout(120);
await p.click('button:has-text("저장")'); await p.waitForTimeout(250);
ok('하위 경로에서 거래 입력·저장', await p.evaluate(()=>S.tx.length===1&&S.tx[0].cat==='편의점'));

for(const v of ['cal','assets','cards','report','home']){ await p.click(`.tabbar button[data-v="${v}"]`); await p.waitForTimeout(100); }
ok('하위 경로에서 탭 이동', await p.evaluate(()=>document.getElementById('view-home').classList.contains('on')));

ok('깨진 리소스 요청 없음', reqFail.length===0, reqFail.slice(0,3).join(' | '));
ok('콘솔/페이지 오류 없음', errs.length===0, errs.slice(0,2).join(' | '));
await b.close();
