// =====================================================================
// HUB GOV TI v2 CLOUD — configuração do Supabase
// Mesmo projeto gratuito usado no financeiro-pessoal.
// A chave abaixo é a PUBLICÁVEL (anon) — feita para ficar no frontend.
// A segurança de escrita é garantida pelas políticas RLS (setup.sql).
// =====================================================================
window.HUB_SUPABASE = {
  URL: 'https://eqvyklhrpkooytykebmu.supabase.co',
  ANON_KEY: 'sb_publishable_CPa_nZDwdAT7DTgIwkj-ow_YfeyttFM',
  // Usuário admin criado no painel: Authentication → Users → Add user (auto confirm)
  ADMIN_EMAIL: 'wanderson@cyberecords.com.br',
  // Sessão admin expira após 15 min sem atividade; bloqueio: 5 tentativas → 15 min
  SESSION_MINUTES: 15,
  MAX_ATTEMPTS: 5
};
