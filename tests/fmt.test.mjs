import { chromium, APP, BASE } from './lib/env.mjs';
const b=await chromium.launch(); const p=await b.newPage();
await p.goto(BASE + '/',{waitUntil:'domcontentloaded'}); await p.waitForTimeout(500);
const ok=(n,v,x='')=>{console.log(`${v?'✅':'❌'} ${n}${x?' — '+x:''}`); if(!v)process.exitCode=1;};
const r = await p.evaluate(() => ({
  headList: fmtAI('이번 달에 할 일:\n- 청약 옮기기\n- 실적 채우기'),
  pureList: fmtAI('- 하나\n- 둘'),
  para:     fmtAI('첫 문단이에요.\n\n둘째 문단이에요.'),
  oneLine:  fmtAI('문장 하나. 문장 둘. 문장 셋. 문장 넷.'),
  mixed:    fmtAI('머리말\n- 항목\n\n다음 문단'),
  empty:    fmtAI(''),
  md:       fmtAI('**굵게** 지운다'),
  esc:      fmtAI('- <script>x</script>'),
}));
ok('머리말 + 목록 → p + ul', r.headList.includes('<p')&&r.headList.includes('<ul')&&/<li[^>]*>청약 옮기기/.test(r.headList), '');
ok('순수 목록 → ul만', r.pureList.includes('<ul')&&!r.pureList.includes('<p'), '');
ok('문단 분리 유지', (r.para.match(/<p/g)||[]).length===2);
ok('개행 없는 긴 글도 문단화', (r.oneLine.match(/<p/g)||[]).length>=2);
ok('문단+목록 혼합', r.mixed.includes('<ul')&&r.mixed.includes('다음 문단'));
ok('빈 값', r.empty==='');
ok('마크다운 강조 제거', !r.md.includes('**'));
ok('HTML 이스케이프', r.esc.includes('&lt;script&gt;')&&!r.esc.includes('<script>'));
await b.close();
