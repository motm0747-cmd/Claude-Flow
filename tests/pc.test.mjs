/* 넓은 화면(PC) 배치 검증.
   기존 audit.mjs 는 '넘침·겹침'만 봤기 때문에 다단(column) 레이아웃이 만든 아래 두 가지를
   놓쳤다. 실제로 사용자가 발견한 문제라 회귀로 박아둔다.
     ① 형제 알림 배너인데 하나는 전체 폭, 옆은 한 칸 폭 — 줄이 어긋나 보인다
     ② 섹션 제목만 딴 칸으로 떨어져서 아래에 아무 내용도 없이 홀로 남는다 */
import { chromium, APP, BASE } from './lib/env.mjs';
const b = await chromium.launch();
const ok = (n, v, x = '') => { console.log(`${v ? '✅' : '❌'} ${n}${x ? ' — ' + x : ''}`); if (!v) process.exitCode = 1; };

const SEED = () => {
  const d = todayStr(), day = n => addDays(d, -n);
  S.accounts = [{ id:'chk', type:'checking', name:'생활비 통장', balance:1160300, cur:'KRW' },
                { id:'dep', type:'deposit', name:'정기예금', balance:5000000, cur:'KRW', rate:3.5 }];
  S.cards = [{ id:'c1', type:'credit', name:'하나 MOVING', accountId:'chk', payDay:14, tiers:[500000], exclCats:[],
    perks:[{ name:'기본적립', cat:'전체', kind:'percent', value:1, tier:0 }], prepays:[] }];
  S.fixed = [{ id:'f1', name:'월세', kind:'expense', amount:600000, day:25, cat:'주거', active:true },
             { id:'f2', name:'정기 용돈', kind:'income', amount:240000, day:1, cat:'용돈', active:true }];
  S.tx = [];
  const memos = ['스타벅스','배민','GS25','올리브영'], cats = ['카페/간식','배달','편의점','미용'];
  for (let i = 0; i < 45; i++) S.tx.push({ id:'t'+i, type:'expense', date:day(i%22),
    amount:30000+(i*2700)%60000, cat:cats[i%4], memo:memos[i%4], payKind:'card', payId:'c1', months:1, paidPortions:0 });
  S.tx.push({ id:'inc', type:'income', date:day(13), amount:240000, cat:'용돈', memo:'정기 용돈', payKind:'account', payId:'chk' });
  _discInvalidate(); save(); renderAll();
};

for (const W of [1024, 1512, 1920]) {
  console.log(`\n════ ${W}px ════`);
  const p = await b.newPage({ viewport: { width: W, height: 1000 } });
  await p.goto(APP, { waitUntil: 'load' });
  await p.waitForTimeout(900);
  await p.evaluate(SEED);
  await p.waitForTimeout(500);

  // ① 할 일 배너들은 모두 같은 폭이어야 한다
  let r = await p.evaluate(() => {
    switchView('home');
    return [...document.getElementById('todo-zone').children]
      .filter(e => e.innerHTML.trim() && e.offsetHeight > 0)
      .map(e => ({ id: e.id, w: Math.round(e.getBoundingClientRect().width) }));
  });
  const ws = [...new Set(r.map(x => x.w))];
  ok('할 일 배너 폭이 모두 같음', r.length > 1 && ws.length === 1,
     r.map(x => `${x.id}:${x.w}`).join(' '));

  // ② 섹션 제목은 자기 내용과 같은 칸에 있어야 한다 (제목만 홀로 떨어지면 안 됨)
  r = await p.evaluate(() => {
    const bad = [];
    for (const v of ['home', 'assets', 'cards', 'report']) {
      switchView(v);
      const root = document.getElementById('view-' + v);
      // 묶음 머리(.ag-head)는 일부러 전체 폭이라 제외
      for (const t of root.querySelectorAll('.sec-title:not(.ag-head)')) {
        if (!t.offsetHeight) continue;
        // 바로 다음에 오는, 내용이 있는 형제
        let n = t.nextElementSibling;
        while (n && (!n.offsetHeight || !n.innerHTML.trim())) n = n.nextElementSibling;
        if (!n) continue;
        const a = t.getBoundingClientRect(), c = n.getBoundingClientRect();
        // 같은 칸이면 왼쪽이 거의 맞고, 제목이 내용보다 위에 있어야 한다
        if (Math.abs(a.left - c.left) > 6 || c.top < a.top)
          bad.push(`${v}:"${t.innerText.split('\n')[0].trim()}" 제목(${Math.round(a.left)},${Math.round(a.top)}) ≠ 내용(${Math.round(c.left)},${Math.round(c.top)})`);
      }
    }
    return bad;
  });
  ok('섹션 제목이 제 내용과 같은 칸에 있음', r.length === 0, r.slice(0, 3).join(' | '));

  // ③ 홈은 다단을 쓰지 않는다 (섹션 화면이라 다단과 맞지 않음)
  r = await p.evaluate(() => {
    switchView('home');
    return getComputedStyle(document.getElementById('view-home')).columnCount;
  });
  ok('홈은 다단(column)을 쓰지 않음', r === 'auto', r);

  // ④ 어떤 블록도 화면 밖으로 나가지 않는다
  r = await p.evaluate(() => {
    const bad = [];
    for (const v of ['home', 'cal', 'assets', 'cards', 'report']) {
      switchView(v);
      const root = document.getElementById('view-' + v);
      for (const e of root.querySelectorAll('*')) {
        if (!e.offsetHeight) continue;
        const b = e.getBoundingClientRect();
        if (b.width > 0 && (b.left < -1 || b.right > innerWidth + 1))
          bad.push(`${v}:${(e.id || e.className).slice(0, 18)} ${Math.round(b.left)}~${Math.round(b.right)}`);
      }
    }
    return [...new Set(bad)];
  });
  ok('가로로 넘치는 블록 없음', r.length === 0, r.slice(0, 3).join(' | '));

  await p.close();
}
await b.close();
