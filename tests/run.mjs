/* 전체 테스트 러너.
 *   node tests/run.mjs            전부
 *   node tests/run.mjs prepay ui  이름에 그 글자가 든 것만
 *
 * 정적 서버를 직접 띄운다 — 외부 의존성 없이 돌아가야 저장소에 넣는 의미가 있다. */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = +(process.env.CF_TEST_PORT || 8199);

/* 하위 경로 배포(GitHub Pages /Claude-Flow/) 검증용 포트 */
const SUB_PORT = +(process.env.CF_TEST_SUBPORT || 8201);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.pdf': 'application/pdf',
};

/* prefix 를 주면 그 경로 아래에 앱이 있는 것처럼 서빙한다 (서브패스 테스트용) */
function serve(port, prefix = '') {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(req.url.split('?')[0]);
    if (prefix) {
      if (!p.startsWith(prefix)) { res.writeHead(404); return res.end('not found'); }
      p = p.slice(prefix.length) || '/';
    }
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(ROOT, p);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((ok, no) => {
    srv.on('error', no);
    srv.listen(port, '127.0.0.1', () => ok(srv));
  });
}

/* 순서: 빠르고 넓은 것 먼저 — 깨졌으면 일찍 알 수 있게 */
const SUITES = [
  'smoke.mjs', 'invariants.mjs', 'fmt.test.mjs', 'sync.test.mjs', 'edge.test.mjs',
  'cats.test.mjs', 'entry.test.mjs', 'q.test.mjs',
  'perk.test.mjs', 'exempt.test.mjs', 'prepay.test.mjs', 'hana.check.mjs',
  'home.test.mjs', 'ui.test.mjs', 'start.test.mjs', 'feat.test.mjs', 'feat2.test.mjs',
  'inv.test.mjs', 'flow.test.mjs', 'final.mjs',
  'click.test.mjs', 'pc.test.mjs', 'subpath.test.mjs', 'audit.mjs',
  'digest.test.mjs', 'digest2.test.mjs', 'webpush.test.mjs',
];

const filters = process.argv.slice(2);
const picked = filters.length
  ? SUITES.filter((s) => filters.some((f) => s.includes(f)))
  : SUITES;

if (!picked.length) {
  console.error(`맞는 테스트가 없어요: ${filters.join(' ')}`);
  console.error(`있는 것: ${SUITES.join(' ')}`);
  process.exit(1);
}

const run = (file) => new Promise((done) => {
  const kid = spawn(process.execPath, [path.join(HERE, file)], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  kid.stdout.on('data', (d) => { out += d; });
  kid.stderr.on('data', (d) => { out += d; });
  kid.on('close', (code) => done({ out, code }));
});

const srv = await serve(PORT);
const sub = await serve(SUB_PORT, '/Claude-Flow');
console.log(`서버 ${PORT} · 하위경로 ${SUB_PORT}\n`);

let pass = 0, fail = 0, broke = 0;
const t0 = Date.now();
for (const file of picked) {
  const { out, code } = await run(file);
  const p = (out.match(/^✅/gm) || []).length;
  const f = (out.match(/^❌/gm) || []).length;
  pass += p; fail += f;
  const crashed = code !== 0 && f === 0;
  if (crashed) broke++;
  const mark = f || crashed ? '❌' : '✅';
  console.log(`${mark} ${file.replace(/\.(test\.)?mjs$/, '').padEnd(14)} ✅${String(p).padEnd(4)} ${f ? '❌' + f : ''}${crashed ? ' 실행 실패' : ''}`);
  if (f) out.split('\n').filter((l) => l.startsWith('❌')).forEach((l) => console.log('   ' + l));
  if (crashed) console.log(out.split('\n').slice(-12).map((l) => '   ' + l).join('\n'));
}

srv.close(); sub.close();
const sec = ((Date.now() - t0) / 1000).toFixed(1);
console.log(`\n═══ ✅${pass}  ❌${fail}${broke ? `  실행실패 ${broke}` : ''}  (${sec}초) ═══`);
process.exit(fail || broke ? 1 : 0);
