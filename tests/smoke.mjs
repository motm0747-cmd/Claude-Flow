import { chromium, APP, BASE } from './lib/env.mjs';
const errs=[];
const b=await chromium.launch();
const p=await b.newPage({viewport:{width:430,height:900}});
p.on('pageerror',e=>errs.push('PAGEERROR: '+e.message));
p.on('console',m=>{const t=m.text(); if(m.type()==='error'&&!/net::|ERR_/.test(t))errs.push('CONSOLE: '+t);});
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'});
await p.waitForTimeout(700);
const ok=(n,v,x='')=>console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`);

// 제거된 심볼이 정말 없는지
const gone = await p.evaluate(()=>['brokerEnabled','brokerReady','renderBrokerCard','renderBrokerDiag','openBrokerModal',
  'smsBoot','smsPoll','renderSmsCard','renderSmsSection','openSmsQueue','openSmsPaste','SmsParse']
  .filter(k=>typeof window[k]!=='undefined'));
ok('제거된 함수 잔존 없음', gone.length===0, gone.join(','));
ok('Sync.callBroker 제거', await p.evaluate(()=>!(window.Sync&&Sync.callBroker)));
ok('Sync.smsClaim 제거', await p.evaluate(()=>!(window.Sync&&Sync.smsClaim)));
ok('Sync.callAI 유지', await p.evaluate(()=>!!(window.Sync&&Sync.callAI)));
ok('Sync._fnError 유지', await p.evaluate(()=>!!(window.Sync&&Sync._fnError)));
ok('config.brokerEnabled 제거', await p.evaluate(()=>window.CLAUDE_FLOW_CONFIG.brokerEnabled===undefined));

// 옛 데이터 청소 동작
await p.evaluate(()=>{
  localStorage.setItem('claudeflow_v1',JSON.stringify({
    accounts:[{id:'a1',type:'invest',name:'토스투자',balance:100,cur:'USD',
      broker:'toss',brokerSeq:3,brokerAt:'2026-08-01',brokerHoldings:[{symbol:'AAPL'}],brokerCashUsd:12}],
    cards:[{id:'c1',type:'check',name:'신한',last4:'1234',perks:[],exclCats:[],tiers:[]}],
    tx:[{id:'t1',type:'expense',date:'2026-08-01',amount:1000,cat:'식비',memo:'x',
      payKind:'cash',payId:'',smsKey:'k',smsRaw:'raw',src:'sms'}],
    fixed:[],invLogs:[],reports:{},settings:{gemini:''},
    sms:{on:true,queue:[{qid:'q'}],rules:{a:1}}}));
});
await p.reload({waitUntil:'domcontentloaded'}); await p.waitForTimeout(700);
ok('S.sms 청소', await p.evaluate(()=>S.sms===undefined));
ok('계좌 broker 필드 청소', await p.evaluate(()=>{const a=S.accounts[0];
  return ['broker','brokerSeq','brokerAt','brokerHoldings','brokerCashUsd'].every(k=>a[k]===undefined);}));
ok('카드 last4 청소', await p.evaluate(()=>S.cards[0].last4===undefined));
ok('거래 sms 필드 청소', await p.evaluate(()=>{const t=S.tx[0];
  return t.smsKey===undefined&&t.smsRaw===undefined&&t.src===undefined;}));
ok('  거래 자체는 보존', await p.evaluate(()=>S.tx.length===1&&S.tx[0].amount===1000));
ok('  계좌·카드 보존', await p.evaluate(()=>S.accounts.length===1&&S.cards.length===1));

// 화면·모달 전수 렌더
for(const v of ['home','cal','assets','cards','report']){ await p.evaluate(x=>switchView(x),v); await p.waitForTimeout(120); }
const modals=['openTxModal','openSettings','openCardModal','openFxModal','openCatModal','openResetModal',
  'openBudgetModal','openWishModal','openGoalModal','openDebtModal','openReconModal','openFixedModal',
  'openAccModal','openDcaTargetModal','openFxFailModal','openInvLogModal',
  'openVersionsModal','openAskModal','openFixCheckModal'];
for(const m of modals){
  const r=await p.evaluate(n=>{ try{ if(typeof window[n]!=='function')return 'MISSING'; window[n](); return 'ok'; }
    catch(e){ return 'THROW: '+e.message; } }, m);
  if(r!=='ok') errs.push(`${m} → ${r}`);
  await p.evaluate(()=>{try{closeModal()}catch(e){}});
}
ok('모든 화면·모달 무오류', errs.length===0, errs.slice(0,5).join(' | '));
await b.close();
if(errs.length){console.log('\n--- 오류 ---'); errs.forEach(e=>console.log(' '+e));}
