/* ══════════════════════════════════════════════════════════════════════
 * Claude Flow — 카드 결제 문자 파서
 *
 * 국내 카드사 결제 알림 문자에서 금액·가맹점·카드·일시·할부를 뽑아낸다.
 * 브라우저(앱)와 Deno(Edge Function) 양쪽에서 그대로 쓰기 위해
 * 모듈 문법 없이 globalThis.SmsParse 에 붙인다.
 *
 * 설계 원칙
 *  1. 확신이 없으면 지어내지 않는다. 못 읽으면 needsReview 로 넘긴다.
 *  2. 광고·인증번호·결제예정(청구서) 문자는 거래로 만들지 않는다.
 *  3. '누적/잔액/한도' 금액을 결제금액으로 착각하지 않는다.
 * ══════════════════════════════════════════════════════════════════════ */
;(function (root) {
  'use strict';

  /* ── 거래가 아닌 문자 ───────────────────────────────────────────── */
  // 광고·인증 등
  var IGNORE = /(인증번호|인증코드|본인확인|본인인증|[(\[]광고[)\]]|무료수신거부|무료거부|수신거부|당첨|택배|배송조회|채용|설문|투표|가입안내|발급완료|배송예정)/;
  // 청구서·결제예정 안내 (실제 거래가 아니라 예고 문자)
  var STATEMENT = /(결제예정|출금예정|자동납부\s*예정|청구금액|이용대금|명세서|대금이\s|카드대금)/;

  /* ── 거래 성격 ──────────────────────────────────────────────────── */
  var CANCEL = /(승인취소|결제취소|취소|반품|환불)/;
  var INCOME = /(입금|급여|받으셨|이체받)/;

  /* ── 카드사 ─────────────────────────────────────────────────────── */
  // 접두(카드사) + 접미(카드/은행/뱅크…) 가 붙어 있을 때만 카드사로 본다.
  // '하나로마트', '기업은행앞' 같은 가맹점명이 잘려나가지 않게 하기 위함.
  var ISSUER_SRC =
    '(KB국민|국민|신한|삼성|현대|롯데|우리|하나|농협|NH|BC|비씨|씨티|IBK|기업' +
    '|토스|카카오|케이|새마을|수협|광주|전북|제주|대구|iM|부산|경남|SC|씨앤|현대백화점)' +
    '\\s*(체크카드|신용카드|체크|카드|은행|뱅크|페이|Pay|머니)';
  var ISSUER_RE = new RegExp(ISSUER_SRC, 'gi');
  var ISSUER_ONE = new RegExp(ISSUER_SRC, 'i');
  var ISSUER_NAME = {
    'kb국민': 'KB국민', '국민': 'KB국민', '신한': '신한', '삼성': '삼성',
    '현대': '현대', '롯데': '롯데', '우리': '우리', '하나': '하나',
    '농협': 'NH농협', 'nh': 'NH농협', 'bc': 'BC', '비씨': 'BC',
    '씨티': '씨티', 'ibk': 'IBK기업', '기업': 'IBK기업', '토스': '토스',
    '카카오': '카카오', '케이': '케이뱅크', '새마을': '새마을금고',
    '수협': '수협', '광주': '광주', '전북': '전북', '제주': '제주',
    '대구': 'iM', 'im': 'iM', '부산': 'BNK부산', '경남': 'BNK경남', 'sc': 'SC제일'
  };

  /* ── 금액 ───────────────────────────────────────────────────────── */
  // 결제금액이 아닌 금액(누적/잔액/한도/적립…)을 먼저 지운 뒤 첫 금액을 취한다.
  var NOT_AMOUNT = /(누적|잔액|한도|가용|잔여|합계|총액|적립|포인트|캐시백|할인전|정상가)\s*[:\-]?\s*[\d,]+\s*원?/g;
  function parseAmount(s) {
    var cleaned = String(s).replace(NOT_AMOUNT, ' ');
    var m = cleaned.match(/(\d{1,3}(?:,\d{3})+|\d+)\s*원/);
    if (!m) return 0;
    var n = Number(m[1].replace(/,/g, ''));
    return isFinite(n) ? n : 0;
  }

  /* ── 날짜·시각 ──────────────────────────────────────────────────── */
  function pad(v) { return String(v).length < 2 ? '0' + v : String(v); }
  function validMD(mm, dd) { return +mm >= 1 && +mm <= 12 && +dd >= 1 && +dd <= 31; }

  function parseDateTime(s, todayISO) {
    var today = /^\d{4}-\d{2}-\d{2}$/.test(todayISO || '')
      ? todayISO : new Date().toISOString().slice(0, 10);
    var year = today.slice(0, 4), date = '', time = '', m;

    if ((m = s.match(/(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})/))) {
      if (validMD(m[2], m[3])) date = m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    } else if ((m = s.match(/(?:^|\D)(\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})(?!\d)/))) {
      if (validMD(m[2], m[3])) date = '20' + m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    } else if ((m = s.match(/(?:^|\D)(\d{1,2})[.\-\/](\d{1,2})(?!\d)/))) {
      if (validMD(m[1], m[2])) date = year + '-' + pad(m[1]) + '-' + pad(m[2]);
    } else if ((m = s.match(/(\d{1,2})월\s*(\d{1,2})일/))) {
      if (validMD(m[1], m[2])) date = year + '-' + pad(m[1]) + '-' + pad(m[2]);
    }

    var tm = s.match(/(\d{1,2}):(\d{2})(?::\d{2})?/);
    if (tm && +tm[1] <= 23) time = pad(tm[1]) + ':' + tm[2];

    // 연말·연초 경계: 오늘보다 미래면 작년 문자로 본다
    if (date && date > today) date = (+date.slice(0, 4) - 1) + date.slice(4);
    return { date: date || today, time: time, dateFound: !!date };
  }

  /* ── 할부 ───────────────────────────────────────────────────────── */
  function parseMonths(s) {
    var m = s.match(/(\d{1,2})\s*개?월\s*(?:무이자\s*)?할부/)
         || s.match(/할부\s*(\d{1,2})\s*개?월/);
    if (m) {
      var n = Math.max(1, +m[1]);
      return { months: n, installment: n > 1 };
    }
    return { months: 1, installment: false };
  }

  /* ── 카드 뒷 4자리 ──────────────────────────────────────────────── */
  function parseLast4(s) {
    var m = s.match(/\*{2,}\s*[-]?\s*(\d{4})/)
         || s.match(/카드\s*[(\[]?\s*(\d{4})\s*[)\]]?(?!\d)/)
         || s.match(/[(\[]\s*(\d{4})\s*[)\]]/);
    if (!m) return '';
    if (/^(19|20)\d{2}$/.test(m[1])) return '';   // 연도 오인식 방지
    return m[1];
  }

  /* ── 카드사 이름 ────────────────────────────────────────────────── */
  function parseIssuer(s) {
    var m = ISSUER_ONE.exec(s);
    if (!m) return '';
    var key = String(m[1]).toLowerCase();
    return ISSUER_NAME[key] || m[1];
  }

  /* ── 가맹점명 ───────────────────────────────────────────────────── */
  var MASKED_NAME = /[가-힣]\*+[가-힣]?님?/g;
  var HONORIFIC   = /[가-힣]{2,4}님/g;
  var KEYWORDS    = /(승인취소|승인|취소|반품|환불|완료|정상|사용|결제|출금|입금|일시불|할부|무이자|누적|잔액|한도|가용|잔여|합계|체크|신용|국내|해외|매입|취급|이용|알림|안내|적립|포인트|건별|즉시|자동이체|계좌이체|씨티|머니)/g;

  function stripLine(line) {
    return line
      .replace(/\[[^\]]*\]/g, ' ')                                  // [Web발신]
      .replace(/【[^】]*】/g, ' ')
      .replace(NOT_AMOUNT, ' ')                                     // 누적 12,345원
      .replace(ISSUER_RE, ' ')                                      // 신한카드, 토스뱅크
      .replace(/(\d{1,2})\s*개?월\s*(?:무이자\s*)?할부/g, ' ')
      .replace(/할부\s*\d{1,2}\s*개?월/g, ' ')
      .replace(/20\d{2}[.\-\/]\d{1,2}[.\-\/]\d{1,2}/g, ' ')
      .replace(/\d{1,2}[.\-\/]\d{1,2}(?:[.\-\/]\d{1,2})?/g, ' ')    // 08/22
      .replace(/\d{1,2}월\s*\d{1,2}일/g, ' ')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')                    // 14:23
      .replace(/\*{2,}\s*[-]?\s*\d{4}/g, ' ')
      .replace(/[(\[]\s*\d{4}\s*[)\]]/g, ' ')                       // (1234)
      .replace(/\d{1,3}(?:,\d{3})+\s*원?/g, ' ')                     // 12,000원
      .replace(/\d+\s*원/g, ' ')
      .replace(MASKED_NAME, ' ')                                    // 홍*동
      .replace(HONORIFIC, ' ')                                      // 홍길동님
      .replace(KEYWORDS, ' ')
      .replace(/[|│·▶▷★☆:;,\/\\]+/g, ' ')
      .replace(/^[\s\-~=+.]+|[\s\-~=+.]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  function pickMerchant(raw) {
    var lines = String(raw).split(/[\n\r]+/).map(function (l) { return l.trim(); })
      .filter(function (l) { return !!l; });
    if (!lines.length) return '';

    var best = null;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var t = stripLine(line);
      if (!t || t.length < 2) continue;
      if (/^\d+$/.test(t)) continue;                 // 숫자만 남은 줄
      if (t.length > 40) t = t.slice(0, 40);

      var score = 0;
      if (/(누적|잔액|한도|가용|잔여|합계|적립|포인트)/.test(line)) score -= 100;
      if (ISSUER_ONE.test(line)) score -= 30;
      if (/(승인|취소|결제|사용|출금|입금)/.test(line)) score -= 25;
      if (MASKED_NAME.test(line) || /[가-힣]{2,4}님/.test(line)) score -= 25;
      MASKED_NAME.lastIndex = 0;
      if (/\d{1,3}(,\d{3})+|\d+\s*원/.test(line)) score -= 20;
      if (/\d{1,2}[:.\-\/]\d{1,2}/.test(line)) score -= 15;
      if (!/\d/.test(line)) score += 25;             // 숫자 없는 줄 = 가맹점일 확률 높음
      score += Math.min(t.length, 12);
      score += i;                                    // 가맹점은 대개 뒤쪽에 온다

      if (!best || score > best.score) best = { text: t, score: score };
    }
    return best ? best.text : '';
  }

  /* ── 본체 ───────────────────────────────────────────────────────── */
  function fail(raw, reason, kind) {
    return {
      ok: false, kind: kind || 'unknown', amount: 0, merchant: '', issuer: '',
      last4: '', date: '', time: '', months: 1, installment: false,
      foreign: false, needsReview: false, reason: reason, raw: raw
    };
  }

  function parseSms(raw0, todayISO) {
    var raw = String(raw0 == null ? '' : raw0).replace(/ /g, ' ').trim();
    if (!raw) return fail(raw, '빈 문자');
    if (raw.length > 1200) return fail(raw, '너무 긴 문자');
    if (IGNORE.test(raw)) return fail(raw, '결제 문자가 아니에요 (광고·인증 등)', 'ignore');
    if (STATEMENT.test(raw)) return fail(raw, '결제 예정·청구 안내라 거래로 넣지 않았어요', 'statement');

    var amount = parseAmount(raw);
    if (!amount) return fail(raw, '금액을 찾지 못했어요');
    if (amount > 100000000) return fail(raw, '금액이 비정상적으로 커요');

    var isCancel = CANCEL.test(raw);
    var isIncome = !isCancel && INCOME.test(raw) && !/(출금|결제|승인)/.test(raw);
    var kind = isCancel ? 'cancel' : (isIncome ? 'income' : 'expense');

    var dt = parseDateTime(raw, todayISO);
    var inst = parseMonths(raw);
    var merchant = pickMerchant(raw);
    var issuer = parseIssuer(raw);
    var last4 = parseLast4(raw);
    var foreign = /(해외|USD|EUR|JPY|달러|\$)/i.test(raw);

    // 가맹점이 카드사 이름만 남았다면 못 읽은 것으로 본다
    if (merchant && issuer && merchant.replace(/\s/g, '') === issuer.replace(/\s/g, '')) merchant = '';

    var needsReview = !merchant || merchant.length < 2;

    return {
      ok: true,
      kind: kind,
      amount: amount,
      merchant: merchant,
      issuer: issuer,
      last4: last4,
      date: dt.date,
      time: dt.time,
      months: inst.months,
      installment: inst.installment,
      foreign: foreign,
      needsReview: needsReview,
      reason: needsReview ? '가맹점을 확실히 읽지 못했어요' : '',
      raw: raw
    };
  }

  root.SmsParse = { parse: parseSms, version: 2 };
})(typeof globalThis !== 'undefined' ? globalThis : this);
