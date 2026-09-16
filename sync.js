/* ═══════════════════════════════════════════════════════════════════════
 * Claude Flow Pro — 클라우드 동기화 엔진 (Supabase)
 *
 * 설계 원칙
 *  1) 로컬 우선(local-first): localStorage 가 항상 로컬의 진실.
 *     클라우드는 그 위에 얹는 "동기화 레이어"일 뿐이다.
 *  2) 옵트인: 사용자가 URL/키를 넣고 로그인하기 전에는 아무 일도 하지 않는다.
 *     설정 전에는 앱이 예전과 100% 동일하게 동작한다.
 *  3) 절대 앱을 멈추지 않는다: 모든 네트워크 동작은 try/catch 로 감싸고,
 *     실패해도 로컬 동작에는 영향을 주지 않는다.
 *  4) 데이터 안전: 비어 있는/오래된 원격 데이터로 로컬을 절대 덮어쓰지 않는다.
 *     충돌 시 항상 로컬 스냅샷을 백업한 뒤 처리한다.
 *
 * 이 파일은 순수 엔진이다. DOM 을 만지지 않으며, UI 는 index.html 이
 * window.Sync 상태를 읽어 그린다(Sync.on(...) 리스너 사용).
 * ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CFG_KEY  = 'claudeflow_sync_cfg';    // { url, anonKey } — 이 기기의 연결 설정
  var REV_KEY  = 'claudeflow_sync_rev';    // 마지막으로 동기화한 리비전(number)
  var DATA_KEY = 'claudeflow_v1';          // ⚠️ index.html 의 KEY 와 반드시 동일
  var BACKUP_KEY = 'claudeflow_conflict_backup';
  var BASE_KEY = 'claudeflow_sync_base';   // 마지막으로 동기화가 끝난 시점의 데이터(3-way 병합 기준)
  var TABLE    = 'flow_state';
  var DEBOUNCE = 1500;                      // 저장 후 클라우드 업로드까지 대기(ms)

  /* ═══════════════════════════════════════════════════════════════════
   * 3-way 병합
   *
   * 두 기기가 같은 시점에서 각자 기록하면, 예전에는 나중에 저장한 쪽이 상대 것을
   * 통째로 덮어썼다. 이제 서버가 거절하므로 여기서 합친다.
   *
   * 기준(base) = 마지막으로 동기화가 끝난 시점의 데이터. 이게 있어야
   * "내가 지운 것"과 "상대가 추가한 것"을 구분할 수 있다 —
   * 기준 없이 합치면 지운 항목이 되살아난다.
   * ═══════════════════════════════════════════════════════════════════ */

  // id 를 가진 레코드 배열들 (거래·계좌·카드 …)
  var ID_LISTS = ['tx', 'accounts', 'cards', 'fixed', 'goals', 'debts', 'invLogs',
                  'wish', 'quick', 'recon', 'askLog'];
  // 키(YYYY-MM 등)로 찾는 맵들
  var KEY_MAPS = ['reports', 'briefs', 'budgets', 'netHist', 'scores'];

  var eq = function (a, b) { return JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b); };
  var byId = function (arr) {
    var m = {};
    (arr || []).forEach(function (x) { if (x && x.id != null) m[x.id] = x; });
    return m;
  };

  /* 한 항목의 3-way 판정. 없으면 undefined 를 반환(= 삭제) */
  function pick3(base, mine, theirs) {
    var hasB = base !== undefined, hasM = mine !== undefined, hasT = theirs !== undefined;
    if (!hasB) {                                   // 기준에 없던 것 = 누군가 새로 추가
      if (hasM && hasT) return eq(mine, theirs) ? mine : theirs;  // 둘 다 추가(드묾) → 서버 것
      return hasM ? mine : theirs;
    }
    if (!hasM && !hasT) return undefined;          // 둘 다 지움
    if (!hasM) return eq(base, theirs) ? undefined : theirs;  // 내가 지움 (상대가 안 건드렸으면 삭제 확정)
    if (!hasT) return eq(base, mine) ? undefined : mine;      // 상대가 지움
    if (eq(mine, theirs)) return mine;
    if (eq(base, mine))  return theirs;            // 나는 그대로 → 상대 변경 채택
    if (eq(base, theirs)) return mine;             // 상대는 그대로 → 내 변경 채택
    return theirs;                                 // 둘 다 바꿈 → 서버 쪽을 택하고 개수를 보고한다
  }

  /* base·mine·theirs 를 합친다. 두 번째 반환값은 사용자에게 보여줄 요약. */
  function merge3(base, mine, theirs) {
    base = base || {}; mine = mine || {}; theirs = theirs || {};
    var out = {}, sum = { added: 0, fromCloud: 0, removed: 0, clashed: 0, fields: [] };
    var keys = {};
    [base, mine, theirs].forEach(function (o) { Object.keys(o || {}).forEach(function (k) { keys[k] = 1; }); });

    Object.keys(keys).forEach(function (k) {
      var b = base[k], m = mine[k], t = theirs[k];

      if (ID_LISTS.indexOf(k) >= 0) {
        var mb = byId(b), mm = byId(m), mt = byId(t), ids = {};
        [mb, mm, mt].forEach(function (o) { Object.keys(o).forEach(function (i) { ids[i] = 1; }); });
        var list = [];
        Object.keys(ids).forEach(function (i) {
          var v = pick3(mb[i], mm[i], mt[i]);
          if (v === undefined) { if (mb[i] !== undefined) sum.removed++; return; }
          list.push(v);
          if (mb[i] === undefined) { if (mm[i] === undefined) sum.fromCloud++; else sum.added++; }
          else if (mm[i] !== undefined && mt[i] !== undefined && !eq(mm[i], mt[i]) &&
                   !eq(mb[i], mm[i]) && !eq(mb[i], mt[i])) sum.clashed++;
        });
        // 원래 순서(날짜·추가 순)를 최대한 지킨다 — 상대 것을 뒤에 붙인다
        var order = {}, n = 0;
        (m || []).concat(t || []).forEach(function (x) { if (x && x.id != null && order[x.id] === undefined) order[x.id] = n++; });
        list.sort(function (a, b2) { return (order[a.id] == null ? 1e9 : order[a.id]) - (order[b2.id] == null ? 1e9 : order[b2.id]); });
        out[k] = list;
        return;
      }

      if (KEY_MAPS.indexOf(k) >= 0) {
        var o = {}, kk = {};
        [b, m, t].forEach(function (x) { Object.keys(x || {}).forEach(function (i) { kk[i] = 1; }); });
        Object.keys(kk).forEach(function (i) {
          var v = pick3((b || {})[i], (m || {})[i], (t || {})[i]);
          if (v !== undefined) o[i] = v;
        });
        out[k] = o;
        return;
      }

      // 그 밖(settings·alloc·cats·flowAI …) — 통째로 3-way
      var v2 = pick3(b, m, t);
      if (v2 !== undefined) out[k] = v2;
      if (m !== undefined && t !== undefined && !eq(m, t) && !eq(b, m) && !eq(b, t)) sum.fields.push(k);
    });
    return { data: out, summary: sum };
  }

  // VAPID 공개키(base64url) → Uint8Array (pushManager.subscribe 용)
  function urlB64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  var Sync = {
    client: null,
    session: null,
    cfg: null,
    knownRev: 0,
    dirty: false,
    _timer: null,
    realtimeChannel: null,
    // off | connecting | signedout | syncing | synced | error
    status: 'off',
    lastError: '',
    listeners: [],

    /* ── 설정 저장소(연결 정보는 동기화 대상 밖의 별도 키) ── */
    // 이 기기에 저장된 설정이 없으면 앱에 내장된 기본 프로젝트(config.js)를 쓴다
    builtinCfg: function () {
      var c = window.CLAUDE_FLOW_CONFIG;
      if (!c) return null;
      var url = String(c.supabaseUrl || '').trim().replace(/\/+$/, '');
      var key = String(c.supabaseAnonKey || '').trim();
      // 예시/자리표시자가 그대로 남아 있으면 '설정 안 된 것'으로 본다.
      // (그대로 두면 연결된 척하다가 로그인 단계에서 알 수 없는 오류가 남)
      var placeholder = !/^https:\/\/[a-z0-9-]+\.supabase\.co$/i.test(url)
        || key.length < 60 || key.split('.').length !== 3;
      if (placeholder) return null;
      return { url: url, anonKey: key, builtin: true };
    },
    hasBuiltin: function () { return !!this.builtinCfg(); },
    // 지금 쓰는 설정이 내장 기본값인지(사용자가 직접 넣은 게 아닌지)
    usingBuiltin: function () { return !!(this.cfg && this.cfg.builtin); },
    allowCustom: function () {
      var c = window.CLAUDE_FLOW_CONFIG;
      return !this.hasBuiltin() || !c || c.allowCustomProject !== false;
    },
    loadCfg: function () {
      var saved = null;
      try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || 'null'); } catch (e) { saved = null; }
      if (saved && saved.url && saved.anonKey) return saved;
      return this.builtinCfg();
    },
    saveCfg: function (c) { this.cfg = c; try { localStorage.setItem(CFG_KEY, JSON.stringify(c)); } catch (e) {} },
    clearCfg: function () { this.cfg = null; try { localStorage.removeItem(CFG_KEY); } catch (e) {} },

    configured: function () { return !!(this.cfg && this.cfg.url && this.cfg.anonKey); },
    signedIn: function () { return !!this.session; },
    email: function () { return this.session && this.session.user ? this.session.user.email : ''; },

    /* ── 상태 구독 ── */
    on: function (fn) { this.listeners.push(fn); },
    emit: function () { var self = this; this.listeners.forEach(function (f) { try { f(self); } catch (e) {} }); },
    setStatus: function (s, err) {
      this.status = s;
      if (err !== undefined) this.lastError = err || '';
      // 성공했으면 지난 오류 문구는 지운다. 남겨두면 다 나은 뒤에도 경고가 계속 붙는다.
      else if (s === 'synced') this.lastError = '';
      this.emit();
    },

    /* ── 로컬 데이터 헬퍼 ── */
    readLocal: function () { try { return JSON.parse(localStorage.getItem(DATA_KEY) || 'null'); } catch (e) { return null; } },
    isEmpty: function (s) {
      return !s || ((!s.accounts || !s.accounts.length) && (!s.tx || !s.tx.length));
    },
    backupLocal: function (local) {
      try { localStorage.setItem(BACKUP_KEY, JSON.stringify({ at: new Date().toISOString(), rev: this.knownRev, data: local })); } catch (e) {}
    },

    /* ─────────────────────────── 초기화 ─────────────────────────── */
    init: function () {
      this.cfg = this.loadCfg();
      this.knownRev = +(localStorage.getItem(REV_KEY) || 0) || 0;
      if (!this.configured()) { this.setStatus('off'); return; }
      if (!(window.supabase && window.supabase.createClient)) {
        this.setStatus('error', '동기화 라이브러리를 불러오지 못했어요 (오프라인일 수 있어요). 로컬 저장은 정상 동작합니다.');
        return;
      }
      var self = this;
      this.setStatus('connecting');
      try {
        this.client = window.supabase.createClient(this.cfg.url, this.cfg.anonKey, {
          auth: { persistSession: true, autoRefreshToken: true, storageKey: 'claudeflow_auth' }
        });
        this.client.auth.onAuthStateChange(function (_evt, session) {
          self.session = session;
          if (session) { self.pull(true); self._subscribeRealtime(); }
          else { self._unsubscribeRealtime(); self.setStatus('signedout'); }
        });
        this.client.auth.getSession().then(function (res) {
          self.session = (res && res.data) ? res.data.session : null;
          if (self.session) { self.pull(true); self._subscribeRealtime(); }
          else { self.setStatus('signedout'); }
        }).catch(function (e) { self.setStatus('error', self._msg(e)); });

        // 앱이 다시 보이면 최신본 pull, 백그라운드로 가면 밀린 변경 즉시 flush
        document.addEventListener('visibilitychange', function () {
          if (!self.session) return;
          if (document.visibilityState === 'visible') self.pull(true);
          else if (self.dirty) { clearTimeout(self._timer); self.push(); }
        });
        window.addEventListener('pagehide', function () { if (self.session && self.dirty) { clearTimeout(self._timer); self.push(); } });
      } catch (e) { this.setStatus('error', this._msg(e)); }
    },

    /* ─────────────────────────── 인증 ─────────────────────────── */
    _ensureClient: function () {
      if (this.client) return true;
      if (!this.configured()) { this.setStatus('error', '먼저 Supabase 연결 정보를 입력해주세요.'); return false; }
      if (!(window.supabase && window.supabase.createClient)) { this.setStatus('error', '동기화 라이브러리를 불러오지 못했어요.'); return false; }
      this.client = window.supabase.createClient(this.cfg.url, this.cfg.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'claudeflow_auth' }
      });
      return true;
    },

    connect: function (url, anonKey) {
      url = (url || '').trim()
        .replace(/^[A-Za-z_]+\s*=\s*/, '')     // 'SUPABASE_URL=' 같은 접두어 제거
        .replace(/^["']|["']$/g, '').trim();   // 감싼 따옴표 제거
      // 순수 프로젝트 URL(origin)만 남김 → '/rest/v1/' 등 꼬리 경로 자동 제거
      try { url = new URL(url).origin; } catch (e) { url = url.replace(/\/+$/, ''); }
      anonKey = (anonKey || '').trim().replace(/^["']|["']$/g, '');
      if (!/^https:\/\/.+/.test(url)) return Promise.reject(new Error('올바른 Supabase URL(https://…)을 입력해주세요.'));
      if (anonKey.length < 20) return Promise.reject(new Error('anon key 를 다시 확인해주세요.'));
      this.saveCfg({ url: url, anonKey: anonKey });
      this.client = null;
      this.setStatus('connecting');
      this.init();
      return Promise.resolve();
    },

    signUp: function (email, pw) {
      if (!this._ensureClient()) return Promise.reject(new Error(this.lastError));
      var self = this;
      this.setStatus('connecting');
      return this.client.auth.signUp({ email: email, password: pw }).then(function (res) {
        if (res.error) throw res.error;
        // 이메일 인증이 꺼져 있으면 즉시 세션이 생김. 켜져 있으면 확인 메일 필요.
        if (res.data && res.data.session) { self.session = res.data.session; self.pull(true); return { needConfirm: false }; }
        self.setStatus('signedout');
        return { needConfirm: true };
      }).catch(function (e) { self.setStatus('error', self._msg(e)); throw e; });
    },

    signIn: function (email, pw) {
      if (!this._ensureClient()) return Promise.reject(new Error(this.lastError));
      var self = this;
      this.setStatus('connecting');
      return this.client.auth.signInWithPassword({ email: email, password: pw }).then(function (res) {
        if (res.error) throw res.error;
        self.session = res.data.session;
        return self.pull(true);
      }).catch(function (e) { self.setStatus('error', self._msg(e)); throw e; });
    },

    signOut: function () {
      var self = this;
      this._unsubscribeRealtime();
      if (!this.client) { this.session = null; this.setStatus('signedout'); return Promise.resolve(); }
      return this.client.auth.signOut().then(function () {
        self.session = null; self.setStatus('signedout');
      }).catch(function () { self.session = null; self.setStatus('signedout'); });
    },

    disconnect: function () {
      // 로그아웃 + 이 기기의 연결 설정 제거(로컬 데이터는 그대로 둔다)
      var self = this;
      this._unsubscribeRealtime();
      var done = function () {
        self.clearCfg();                 // 이 기기에 저장된 '직접 입력' 설정만 제거
        self.client = null; self.session = null; self.knownRev = 0;
        try { localStorage.removeItem(REV_KEY); } catch (e) {}
        // 앱에 기본 프로젝트가 내장돼 있으면 그쪽으로 되돌아가 '로그인 필요' 상태가 된다
        self.cfg = self.builtinCfg();
        self.setStatus(self.cfg ? 'signedout' : 'off');
      };
      if (this.client) return this.client.auth.signOut().then(done).catch(done);
      done(); return Promise.resolve();
    },

    /* ─────────────────────────── 내려받기(pull) ─────────────────────────── */
    pull: function (applyToApp) {
      if (!this.session || !this.client) return Promise.resolve();
      var self = this;
      this.setStatus('syncing');
      return this.client.from(TABLE).select('data,rev').eq('user_id', this.session.user.id).maybeSingle()
        .then(function (res) {
          if (res.error) throw res.error;
          var row = res.data;                 // { data, rev } | null
          var local = self.readLocal();
          var remoteRev = row ? (row.rev || 0) : 0;

          // 1) 클라우드에 행 자체가 없음 → 로컬이 있으면 올려서 시드
          if (!row) {
            if (!self.isEmpty(local)) { self.dirty = true; return self.push(true); }
            self.setStatus('synced'); return;
          }
          // 2) 비었고 한 번도 기록된 적 없음(rev 0) → 첫 동기화이므로 로컬로 시드
          //    ⚠️ rev가 올라가 있는데 비어 있으면 '다른 기기에서 일부러 초기화한 것'이므로
          //       여기서 되돌려 올리면 안 된다. 아래 리비전 비교로 넘어간다.
          if (self.isEmpty(row.data) && remoteRev === 0) {
            if (!self.isEmpty(local)) { self.dirty = true; return self.push(true); }
            self.setStatus('synced'); return;
          }

          // 3) 리비전 비교 — 초기화(빈 상태)도 하나의 정상 리비전으로 취급
          if (remoteRev > self.knownRev) {
            // 원격이 더 최신 → 로컬 백업 후 채택 (비어 있으면 이 기기도 초기화됨)
            if (!self.isEmpty(local)) self.backupLocal(local);
            return self.adopt(row, applyToApp);
          } else if (remoteRev < self.knownRev) {
            // 로컬이 더 최신 → 올림. 단 로컬이 비어 있으면 클라우드를 지우지 않고 받아온다.
            if (self.isEmpty(local)) return self.adopt(row, applyToApp);
            self.dirty = true; return self.push(true);
          } else {
            self.setStatus('synced'); // 같은 리비전 → 동일하다고 간주
          }
        })
        .catch(function (e) { self.setStatus('error', self._msg(e)); });
    },

    adopt: function (row, applyToApp) {
      try {
        localStorage.setItem(DATA_KEY, JSON.stringify(row.data));
        this.knownRev = row.rev || 0;
        localStorage.setItem(REV_KEY, String(this.knownRev));
        localStorage.setItem(BASE_KEY, JSON.stringify(row.data));   // 다음 병합의 기준
      } catch (e) {}
      if (applyToApp && typeof window.reloadStateFromStorage === 'function') {
        try { window.reloadStateFromStorage(); } catch (e) {}
      }
      this.setStatus('synced');
    },

    /* ─────────────────────────── 실시간(Realtime) ─────────────────────────── */
    // 다른 기기가 클라우드에 저장하면 그 즉시 이 기기로 받아온다.
    // (Supabase에서 flow_state 테이블 realtime 을 켜야 동작 — schema.sql 참고)
    _subscribeRealtime: function () {
      if (!this.client || !this.session || this.realtimeChannel) return;
      var self = this, uid = this.session.user.id;
      try {
        this.realtimeChannel = this.client
          .channel('flow_state_' + uid)
          .on('postgres_changes',
            { event: '*', schema: 'public', table: 'flow_state', filter: 'user_id=eq.' + uid },
            function (payload) {
              var r = (payload && payload.new && typeof payload.new.rev === 'number') ? payload.new.rev : Infinity;
              /* 내가 방금 올린 것(내 knownRev 와 같은 rev)만 무시하고, 나머지는 받아온다.
                 예전엔 'r > knownRev' 였는데, 두 기기가 같은 rev 를 만들 수 있었기 때문에
                 상대의 변경을 영영 못 받는 구멍이 있었다. */
              if (r !== self.knownRev) self.pull(true);
            })
          .subscribe();
      } catch (e) { /* realtime 실패해도 앱·동기화는 정상 */ }
    },
    _unsubscribeRealtime: function () {
      if (this.realtimeChannel && this.client) {
        try { this.client.removeChannel(this.realtimeChannel); } catch (e) {}
      }
      this.realtimeChannel = null;
    },

    /* ─────────────────────────── 올리기(push) ─────────────────────────── */
    // 저장이 일어날 때마다 호출 → 디바운스 후 업로드
    markDirty: function () {
      if (!this.session || !this.client) return;
      this.dirty = true;
      var self = this;
      clearTimeout(this._timer);
      this._timer = setTimeout(function () { self.push(); }, DEBOUNCE);
    },

    /* 조건부 저장 — 내가 알고 있던 리비전일 때만 쓴다.
       그 사이 다른 기기가 바꿨으면 서버가 거절하고 현재 값을 돌려주며, 여기서 합친다. */
    /* ── 조건부 저장 (compare-and-swap) ─────────────────────────────────
     * "내가 알던 리비전일 때만 쓴다". 그 사이 다른 기기가 바꿨으면 아무것도 쓰지 않는다.
     *
     * 이걸 DB 함수 없이 한다 — UPDATE 에 `rev = 내가 알던 값` 조건을 같이 걸면
     * 그 자체가 한 문장짜리 원자적 CAS 다. 따로 SQL 을 실행할 필요가 없고,
     * 이미 있는 rev 컬럼과 RLS 만으로 동작한다.
     *
     * .select() 를 붙이면 실제로 바뀐 행이 돌아온다 — 0건이면 조건이 안 맞은 것. */
    _casWrite: function (data, expected) {
      var self = this, uid = this.session.user.id, next = expected + 1;
      return this.client.from(TABLE)
        .update({ data: data, rev: next, updated_at: new Date().toISOString() })
        .eq('user_id', uid).eq('rev', expected).select('rev')
        .then(function (res) {
          if (res.error) throw res.error;
          if (res.data && res.data.length) return { ok: true, rev: next };
          // 0건 — 행이 아예 없거나(첫 저장), 그 사이 누가 바꿨거나
          return self.client.from(TABLE).select('data,rev').eq('user_id', uid).maybeSingle()
            .then(function (cur) {
              if (cur.error) throw cur.error;
              if (cur.data) return { ok: false, rev: cur.data.rev || 0, data: cur.data.data };
              // 아직 행이 없다 → 만든다. 그 찰나에 다른 기기가 먼저 만들었으면 충돌로 넘긴다
              return self.client.from(TABLE)
                .insert({ user_id: uid, data: data, rev: 1, updated_at: new Date().toISOString() })
                .select('rev')
                .then(function (ins) {
                  if (!ins.error) return { ok: true, rev: 1 };
                  if (String(ins.error.code) === '23505') return { ok: false, rev: -1 };  // 동시 생성
                  throw ins.error;
                });
            });
        });
    },

    push: function (force) {
      if (!this.session || !this.client) return Promise.resolve();
      if (!this.dirty && !force) return Promise.resolve();
      var local = this.readLocal();
      // 실수로 빈 데이터를 올려 클라우드를 날리는 것 방지(강제 시드는 예외)
      if (this.isEmpty(local) && !force) { this.dirty = false; this.setStatus('synced'); return Promise.resolve(); }
      var self = this, expected = this.knownRev || 0;
      this.setStatus('syncing');

      return this._casWrite(local, expected)
        .then(function (r) {
          if (r.ok) { self._retry = 0; self._afterPush(local, r.rev); return; }
          if (r.rev < 0) return self.pull(true).then(function () { return self.push(true); });
          return self._resolveConflict(local, r);          // ← 동시 편집
        })
        .catch(function (e) { self.setStatus('error', self._msg(e)); });
    },

    _afterPush: function (data, rev) {
      this.knownRev = rev;
      try {
        localStorage.setItem(REV_KEY, String(rev));
        localStorage.setItem(BASE_KEY, JSON.stringify(data));   // 다음 병합의 기준
      } catch (e) {}
      this.dirty = false;
      this.setStatus('synced');
    },

    readBase: function () { try { return JSON.parse(localStorage.getItem(BASE_KEY) || 'null'); } catch (e) { return null; } },

    /* 동시 편집 — 양쪽을 합쳐서 다시 올린다. 무엇이 합쳐졌는지는 사용자에게 알린다. */
    _resolveConflict: function (local, row) {
      var self = this;
      var theirs = row.data;
      if (theirs == null) {                        // 서버가 값을 못 준 경우 → 받아와서 다시 시도
        return this.pull(true);
      }
      this.backupLocal(local);                     // 합치기 전 내 상태는 항상 남긴다
      var base = this.readBase();
      var merged = merge3(base, local, theirs);
      var s = merged.summary;

      return this._casWrite(merged.data, row.rev)
        .then(function (r2) {
          if (!r2.ok) {                            // 합치는 사이 또 바뀜 → 한 번 더
            if ((self._retry = (self._retry || 0) + 1) > 3) throw new Error('동기화가 계속 부딪혀요. 잠시 후 다시 시도해주세요');
            return self.push(true);
          }
          self._retry = 0;
          try { localStorage.setItem(DATA_KEY, JSON.stringify(merged.data)); } catch (e) {}
          self._afterPush(merged.data, r2.rev);
          if (typeof window.reloadStateFromStorage === 'function') {
            try { window.reloadStateFromStorage(); } catch (e) {}
          }
          self.lastMerge = s;
          self._emitMerge(s);
        });
    },

    /* 합친 결과를 앱에 알린다 — 조용히 지나가면 사용자는 뭐가 바뀌었는지 알 수 없다 */
    _emitMerge: function (s) {
      var parts = [];
      if (s.fromCloud) parts.push('다른 기기 ' + s.fromCloud + '건');
      if (s.added)     parts.push('이 기기 ' + s.added + '건');
      if (s.removed)   parts.push('삭제 ' + s.removed + '건');
      var msg = parts.length ? ('동기화 충돌을 합쳤어요 — ' + parts.join(' · ')) : '동기화 충돌을 합쳤어요';
      if (s.clashed || s.fields.length) msg += ' · 같은 항목 ' + (s.clashed + s.fields.length) + '건은 다른 기기 것을 따랐어요';
      try { if (typeof window.toast === 'function') window.toast(msg); } catch (e) {}
      try { console.info('[Sync] merge', s); } catch (e) {}
    },

    /* 클라우드 데이터 비우기 — 전체 초기화용.
     * 빈 상태를 새 리비전으로 올려서, 다른 기기들도 다음 접속 때 초기화된다. */
    wipeCloud: function () {
      if (!this.client || !this.session) return Promise.reject(new Error('로그인이 필요해요'));
      var self = this;
      var empty = { accounts: [], cards: [], tx: [], fixed: [], invLogs: [], reports: {}, settings: {} };
      // 다른 기기가 먼저 올려둔 리비전이 있을 수 있으므로 현재 값을 읽고 그 위로 올린다
      return this._nextRev().then(function (nextRev) {
        return self.client.from(TABLE).upsert({
          user_id: self.session.user.id, data: empty, rev: nextRev, updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' }).then(function (res) {
          if (res.error) throw res.error;
          self.knownRev = nextRev;
          self.dirty = false;
          clearTimeout(self._timer);                  // 대기 중이던 업로드 취소
          try {
            localStorage.setItem(REV_KEY, String(nextRev));
            localStorage.setItem(BASE_KEY, JSON.stringify(empty));
          } catch (e) {}
        });
      });
    },

    // 클라우드의 현재 리비전 +1 (내 knownRev 보다도 항상 크게)
    _nextRev: function () {
      var self = this;
      return this.client.from(TABLE).select('rev').eq('user_id', this.session.user.id).maybeSingle()
        .then(function (res) {
          var cur = (res && res.data && res.data.rev) || 0;
          return Math.max(cur, self.knownRev || 0) + 1;
        })
        .catch(function () { return (self.knownRev || 0) + 1; });
    },

    /* 이 기기 내용을 클라우드와 모든 기기에 강제로 덮어쓰기 — 충돌 복구용 */
    forcePush: function () {
      if (!this.client || !this.session) return Promise.reject(new Error('로그인이 필요해요'));
      var self = this, local = this.readLocal();
      this.setStatus('syncing');
      return this._nextRev().then(function (nextRev) {
        return self.client.from(TABLE).upsert({
          user_id: self.session.user.id, data: local, rev: nextRev, updated_at: new Date().toISOString()
        }, { onConflict: 'user_id' }).then(function (res) {
          if (res.error) throw res.error;
          self._afterPush(local, nextRev);
        });
      }).catch(function (e) { self.setStatus('error', self._msg(e)); throw e; });
    },

    /* 사용자가 수동으로 "지금 동기화" 눌렀을 때 */
    syncNow: function () {
      if (!this.session) return Promise.resolve();
      if (this.dirty) return this.push(true);
      return this.pull(true);
    },

    /* ─────────── 서버 AI 호출(Edge Function) ───────────
     * 로그인한 사용자만 호출 가능(JWT는 supabase-js가 자동 첨부).
     * 서버에 저장된 키를 쓰므로 브라우저에 키가 노출되지 않고, 모든 기기 공용. */
    aiReady: function () { return !!(this.client && this.session); },
    callAI: function (prompt) {
      if (!this.client || !this.session) return Promise.reject(new Error('로그인이 필요해요'));
      var self = this;
      return this.client.functions.invoke('ai', { body: { prompt: prompt } }).then(function (res) {
        if (res.error) return self._fnError(res, '서버 AI 호출 실패');
        if (res.data && res.data.error) throw new Error(res.data.error);
        return (res.data && res.data.text) || '';
      });
    },

    /* supabase-js 는 Edge Function 이 4xx/5xx 를 주면 'non-2xx status code' 라는
       일반 메시지만 준다. 실제 사유는 응답 본문에 있으므로 꺼내서 그대로 보여준다. */
    _fnError: function (res, fallback) {
      var ctx = res && res.error && res.error.context;
      var base = (res && res.error && res.error.message) || fallback || '호출 실패';
      if (ctx && typeof ctx.json === 'function') {
        return ctx.json().then(
          function (b) { throw new Error((b && (b.error || b.message)) || base); },
          function () { throw new Error(base); }
        );
      }
      if (ctx && typeof ctx.text === 'function') {
        return ctx.text().then(
          function (t) { throw new Error(t || base); },
          function () { throw new Error(base); }
        );
      }
      return Promise.reject(new Error(base));
    },
    /* ─────────── 서버 자동화: 오늘의 리마인더(daily_digest) 조회 ───────────
     * 서버 스케줄 함수가 매일 계산해 둔 요약/리마인더를 읽어온다. (없으면 null) */
    getDigest: function () {
      if (!this.client || !this.session) return Promise.resolve(null);
      return this.client.from('daily_digest').select('digest,computed_at')
        .eq('user_id', this.session.user.id).maybeSingle()
        .then(function (res) { return (res && !res.error && res.data) ? res.data : null; })
        .catch(function () { return null; });
    },

    /* ─────────────────────────── 푸시 알림 ─────────────────────────── */
    pushSupported: function () {
      return ('serviceWorker' in navigator) && ('PushManager' in window) && ('Notification' in window);
    },
    // 홈 화면에 설치된 앱인지(iOS는 설치된 앱에서만 푸시 가능)
    isStandalone: function () {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (navigator.standalone === true);
    },
    pushSubscribed: function () {
      if (!this.pushSupported()) return Promise.resolve(false);
      return navigator.serviceWorker.ready
        .then(function (reg) { return reg.pushManager.getSubscription(); })
        .then(function (s) { return !!s; }).catch(function () { return false; });
    },
    enablePush: function (vapidPublic) {
      var self = this;
      if (!this.client || !this.session) return Promise.reject(new Error('로그인이 필요해요'));
      if (!this.pushSupported()) return Promise.reject(new Error('이 브라우저는 푸시를 지원하지 않아요'));
      return Notification.requestPermission().then(function (perm) {
        if (perm !== 'granted') throw new Error('알림 권한이 필요해요 (브라우저/기기 설정에서 허용)');
        return navigator.serviceWorker.ready;
      }).then(function (reg) {
        return reg.pushManager.getSubscription().then(function (existing) {
          return existing || reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlB64ToUint8Array(vapidPublic),
          });
        });
      }).then(function (sub) {
        return self.client.from('push_subscriptions').upsert(
          { user_id: self.session.user.id, endpoint: sub.endpoint, subscription: sub.toJSON() },
          { onConflict: 'user_id,endpoint' }
        ).then(function (res) { if (res.error) throw res.error; return true; });
      });
    },
    disablePush: function () {
      var self = this;
      if (!this.pushSupported()) return Promise.resolve();
      return navigator.serviceWorker.ready.then(function (reg) {
        return reg.pushManager.getSubscription().then(function (sub) {
          if (!sub) return;
          var ep = sub.endpoint;
          return sub.unsubscribe().then(function () {
            if (self.client && self.session) {
              return self.client.from('push_subscriptions').delete()
                .eq('user_id', self.session.user.id).eq('endpoint', ep);
            }
          });
        });
      });
    },

    /* 서버 자동화 함수 직접 호출 — 알림 점검(status) / 테스트 발송(test) / 지금 계산(run) */
    callDigest: function (action) {
      if (!this.client || !this.session) return Promise.reject(new Error('로그인이 필요해요'));
      var self = this;
      return this.client.functions.invoke('digest', { body: { action: action || 'run' } })
        .then(function (res) {
          if (res.error) return self._fnError(res, '알림 서버 호출 실패');
          return res.data || {};
        });
    },

    /* ─────────────────────────── 버전 복원(타임머신) ─────────────────────────── */
    // 서버의 flow_state_history(최근 30개 자동 백업) 목록/복원. (schema.sql 필요)
    listVersions: function () {
      if (!this.session || !this.client) return Promise.resolve({ error: 'not-signed-in', data: null });
      return this.client.from('flow_state_history')
        .select('id,rev,saved_at')
        .eq('user_id', this.session.user.id)
        .order('id', { ascending: false })
        .limit(30);
    },
    restoreVersion: function (id) {
      var self = this;
      if (!this.session || !this.client) return Promise.reject(new Error('로그인이 필요해요'));
      return this.client.from('flow_state_history')
        .select('data,rev')
        .eq('user_id', this.session.user.id)
        .eq('id', id)
        .maybeSingle()
        .then(function (res) {
          if (res.error) throw res.error;
          if (!res.data) throw new Error('그 버전을 찾을 수 없어요');
          self.backupLocal(self.readLocal());              // 현재 상태 먼저 백업
          try { localStorage.setItem(DATA_KEY, JSON.stringify(res.data.data)); } catch (e) {}
          if (typeof window.reloadStateFromStorage === 'function') { try { window.reloadStateFromStorage(); } catch (e) {} }
          self.dirty = true;
          return self.push(true);                          // 복원본을 새 버전으로 업로드
        });
    },

    _msg: function (e) {
      if (!e) return '알 수 없는 오류';
      return e.message || e.error_description || (typeof e === 'string' ? e : JSON.stringify(e));
    }
  };

  window.Sync = Sync;
})();
