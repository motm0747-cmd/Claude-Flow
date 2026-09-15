import { chromium, APP, BASE } from './lib/env.mjs';
const b=await chromium.launch();
const errs=[];
const modals=['openTxModal','openSettings','openCardModal','openFxModal','openCatModal','openResetModal',
  'openBudgetModal','openWishModal','openGoalModal','openDebtModal','openReconModal','openFixedModal',
  'openAccModal','openDcaTargetModal','openFxFailModal','openInvLogModal','openVersionsModal',
  'openAskModal','openFixCheckModal'];

for (const [w,h,label] of [[390,844,'폰'],[1024,1366,'패드'],[1512,982,'노트북']]) {
  for (const theme of ['light','dark']) {
    const p=await b.newPage({viewport:{width:w,height:h}});
    p.on('pageerror',e=>errs.push(`[${label}/${theme}] PAGEERROR: ${e.message}`));
    p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push(`[${label}/${theme}] ${t}`);});
    await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
    await p.evaluate(t=>localStorage.setItem('claudeflow_theme',t),theme);
    await p.reload({waitUntil:'domcontentloaded'}); await p.waitForTimeout(400);

    // 빈 상태
    for(const v of ['home','cal','assets','cards','report']){ await p.evaluate(x=>switchView(x),v); await p.waitForTimeout(60); }
    for(const m of modals){
      const res=await p.evaluate(n=>{try{window[n]();return 'ok'}catch(e){return 'THROW:'+e.message}},m);
      if(res!=='ok') errs.push(`[${label}/${theme}] 빈상태 ${m} → ${res}`);
      await p.evaluate(()=>{try{closeModal()}catch(e){}});
    }
    // 데이터 있는 상태
    await p.evaluate(()=>{
      S.accounts=[{id:'a1',type:'checking',name:'주계좌',balance:3000000,cur:'KRW'},
        {id:'a2',type:'saving',name:'적금',balance:2400000,cur:'KRW',monthly:300000,rate:3.5,payFrom:'a1',payDay:25},
        {id:'a3',type:'housing',name:'청약',balance:1500000,cur:'KRW',monthly:100000,joinDate:'2024-01-10',payFrom:'a1',payDay:5},
        {id:'a4',type:'invest',name:'해외투자',balance:5200,cur:'USD'}];
      S.cards=[{id:'c1',type:'check',name:'체크',accountId:'a1',perks:[],exclCats:[],tiers:[],annualFee:0},
        {id:'c2',type:'credit',name:'신용',accountId:'a1',payDay:14,tiers:[300000],target:300000,
         perks:[{id:'p1',name:'교통',cat:'교통',kind:'percent',value:10,capM:5000,tier:1,bill:true}],
         exclCats:[],annualFee:15000}];
      S.tx=[]; for(let i=0;i<300;i++){S.tx.push({id:'t'+i,type:i%7===0?'income':'expense',
        date:`${thisYM()}-${String((i%27)+1).padStart(2,'0')}`,amount:(i%40+1)*1300,
        cat:i%7===0?INC_CATS[i%INC_CATS.length][1]:EXP_CATS[i%EXP_CATS.length][1],
        memo:'항목'+i,payKind:['cash','card','account'][i%3],payId:['','c2','a1'][i%3],fxAt:1380,months:1,paidPortions:0});}
      S.fixed=[{id:'f1',kind:'expense',name:'월세',amount:500000,day:5,cat:'주거',payKind:'account',payId:'a1',active:true},
        {id:'f2',kind:'income',name:'급여',amount:2800000,day:25,cat:'급여',payKind:'account',payId:'a1',active:true}];
      S.budgets[thisYM()]={total:1500000}; S.goals=[{id:'g1',name:'여행',target:3000000,saved:800000}];
      S.debts=[{id:'d1',kind:'lend',name:'친구',amount:200000,date:todayStr(),settled:false}];
      S.wish=[{id:'w1',name:'노트북',amount:1800000,date:todayStr(),cool:14,status:'open'}];
      _discInvalidate(); save(); renderAll();
    });
    for(const v of ['home','cal','assets','cards','report']){ await p.evaluate(x=>switchView(x),v); await p.waitForTimeout(80); }
    for(const m of modals){
      const res=await p.evaluate(n=>{try{window[n]();return 'ok'}catch(e){return 'THROW:'+e.message}},m);
      if(res!=='ok') errs.push(`[${label}/${theme}] 데이터 ${m} → ${res}`);
      await p.evaluate(()=>{try{closeModal()}catch(e){}});
    }
    // 개별 항목 편집 모달
    for(const [fn,arg] of [['openTxModal','t1'],['openCardModal','c2'],['openAccModal','a2'],['openInvLogModal','a4']]){
      const res=await p.evaluate(([n,a])=>{try{window[n](a);return 'ok'}catch(e){return 'THROW:'+e.message}},[fn,arg]);
      if(res!=='ok') errs.push(`[${label}/${theme}] ${fn}(${arg}) → ${res}`);
      await p.evaluate(()=>{try{closeModal()}catch(e){}});
    }
    // 가로 스크롤 없어야 함
    const overflow=await p.evaluate(()=>document.documentElement.scrollWidth>document.documentElement.clientWidth+1);
    if(overflow) errs.push(`[${label}/${theme}] 가로 스크롤 발생`);
    if(theme==='light'&&label==='폰'){ await p.evaluate(()=>{closeModal();switchView('home')}); await p.waitForTimeout(200);
      await p.screenshot({path:'final-home.png'});
      await p.evaluate(()=>openSettings()); await p.waitForTimeout(250);
      await p.screenshot({path:'final-settings.png',fullPage:true}); }
    await p.close();
  }
}
await b.close();
console.log(errs.length? `❌ ${errs.length}건\n`+errs.slice(0,15).map(e=>' '+e).join('\n')
                       : '✅ 3개 화면폭 × 2테마 × (빈 상태 + 300건 데이터) × 5화면 · 23모달 — 오류 없음');
