/* ═══════════════════════════════════════════════════════════════════════
 * Claude Flow — 앱 기본 설정
 *
 * 여기에 Supabase 프로젝트 정보를 넣어두면, 사용자는 URL·키를 입력할 필요 없이
 * 이메일·비밀번호만으로 바로 가입/로그인할 수 있다.
 *
 * ⚠️ anon key 를 여기에 두는 것은 안전한가?
 *    그렇다. anon key는 Supabase가 '브라우저에 공개되는 것을 전제로' 설계한 키다.
 *    실제 데이터 보호는 키가 아니라 RLS(Row Level Security) 정책이 담당하며,
 *    supabase/schema.sql 의 정책에 따라 로그인한 사용자는 자기 행만 읽고 쓸 수 있다.
 *    ❌ 절대 넣지 말 것: service_role / secret 키 (RLS를 우회하므로 유출 시 위험)
 *
 * 값을 비워두면 앱은 예전처럼 '설정에서 사용자가 직접 입력' 방식으로 동작한다.
 * ═══════════════════════════════════════════════════════════════════════ */
window.CLAUDE_FLOW_CONFIG = {
  // 예: 'https://abcdefghijklm.supabase.co'
  supabaseUrl: '',

  // Project Settings → API Keys → anon / public (eyJ… 로 시작하는 긴 문자열)
  supabaseAnonKey: '',

  // 사용자가 설정에서 '다른 Supabase 프로젝트'를 직접 쓸 수 있게 할지 여부
  allowCustomProject: true
};
