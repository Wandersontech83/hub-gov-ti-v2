/* =====================================================================
   HUB GOV TI v2 CLOUD — supabase-api.js
   Adaptador: implementa o mesmo contrato da API REST do backend Node
   (mesmos paths e formatos de resposta), mas sobre o Supabase.
   O app.js permanece praticamente idêntico — só o api() delega para cá.
   ===================================================================== */
'use strict';

const SB_CFG = window.HUB_SUPABASE;
const sb = supabase.createClient(SB_CFG.URL, SB_CFG.ANON_KEY);

// ---------------- Sessão (15 min de inatividade) + bloqueio ----------------
const LS_LAST = 'hub_admin_last_activity';
const LS_LOCK = 'hub_admin_lock';

function sbTouch() { localStorage.setItem(LS_LAST, String(Date.now())); }

async function sbIsAdmin() {
  const { data } = await sb.auth.getSession();
  if (!data.session) return false;
  const last = Number(localStorage.getItem(LS_LAST) || 0);
  if (Date.now() - last > SB_CFG.SESSION_MINUTES * 60000) {
    await sb.auth.signOut();
    return false;
  }
  sbTouch(); // sessão "rolling": renova a cada verificação/ação
  return true;
}

function sbThrow(error) {
  const msg = error.message || String(error);
  if (/row-level security|JWT|not authenticated|permission/i.test(msg)) {
    throw new Error('Acesso restrito — faça login como Admin');
  }
  throw new Error(msg);
}

async function sbRequireAdmin() {
  if (!(await sbIsAdmin())) throw new Error('Acesso restrito — faça login como Admin');
}

async function sbLog(action, module_) {
  await sb.from('hub_activity_log').insert({ ts: new Date().toISOString(), actor: 'admin', action, module: module_ });
}

// helper: SELECT com erro tratado
async function q(promise) {
  const { data, error } = await promise;
  if (error) sbThrow(error);
  return data;
}

// próximo id sequencial em chaves tipo 'INC-1001'
function nextId(rows, prefix, start) {
  const max = rows.map(r => Number(String(r.id).slice(prefix.length)))
    .filter(n => !isNaN(n)).reduce((a, b) => Math.max(a, b), start);
  return prefix + (max + 1);
}

// =====================================================================
// ROTEADOR — mesmo contrato do backend Node
// =====================================================================
async function sbApi(path, opts = {}) {
  const method = (opts.method || 'GET').toUpperCase();
  const body = opts.body || {};
  const [, seg1, seg2] = path.match(/^\/([^/]+)(?:\/(.+))?$/) || [];

  // ---------------- AUTH ----------------
  if (seg1 === 'auth') {
    if (seg2 === 'status') return { isAdmin: await sbIsAdmin() };
    if (seg2 === 'request-reset') {
      // Supabase envia o e-mail de redefinição gratuitamente; o link volta para o portal
      const { error } = await sb.auth.resetPasswordForEmail(SB_CFG.ADMIN_EMAIL, {
        redirectTo: location.origin + location.pathname
      });
      if (error) sbThrow(error);
      const [u, d] = SB_CFG.ADMIN_EMAIL.split('@');
      return { ok: true, email_masked: u.slice(0, 3) + '***@' + d, sent_via: 'email' };
    }
    if (seg2 === 'update-password') {
      if (!body.new_password || body.new_password.length < 8) {
        throw new Error('A nova senha precisa ter pelo menos 8 caracteres.');
      }
      const { error } = await sb.auth.updateUser({ password: body.new_password });
      if (error) sbThrow(error);
      sbTouch();
      await sbLog('Senha do admin alterada com validação por e-mail', 'auth');
      return { ok: true };
    }
    if (seg2 === 'logout') { await sb.auth.signOut(); localStorage.removeItem(LS_LAST); return { ok: true }; }
    if (seg2 === 'login') {
      const lock = JSON.parse(localStorage.getItem(LS_LOCK) || '{"count":0,"until":0}');
      if (lock.until > Date.now()) {
        const mins = Math.ceil((lock.until - Date.now()) / 60000);
        throw new Error(`Bloqueado por excesso de tentativas. Tente novamente em ${mins} min.`);
      }
      const { error } = await sb.auth.signInWithPassword({ email: SB_CFG.ADMIN_EMAIL, password: body.password || '' });
      if (error) {
        lock.count += 1;
        if (lock.count >= SB_CFG.MAX_ATTEMPTS) {
          localStorage.setItem(LS_LOCK, JSON.stringify({ count: 0, until: Date.now() + 15 * 60000 }));
          throw new Error('Bloqueado por 15 minutos após 5 tentativas inválidas.');
        }
        localStorage.setItem(LS_LOCK, JSON.stringify(lock));
        throw new Error(`Senha incorreta (${lock.count}/${SB_CFG.MAX_ATTEMPTS} tentativas).`);
      }
      localStorage.removeItem(LS_LOCK);
      sbTouch();
      await sbLog('Login admin efetuado', 'auth');
      return { ok: true, role: 'admin', expiresInMinutes: SB_CFG.SESSION_MINUTES };
    }
  }

  // ---------------- CONFIG ----------------
  if (seg1 === 'config') {
    if (method === 'GET') {
      const modules = await q(sb.from('hub_modules_config').select('*').order('position'));
      const n8nRows = await q(sb.from('hub_n8n_config').select('base_url,last_sync').eq('id', 1));
      const n8n = n8nRows[0] || {};
      return { portal: 'HUB GOV TI v2', version: '2.0.0-cloud', modules,
        n8n: { base_url: n8n.base_url || '', configured: !!n8n.base_url, last_sync: n8n.last_sync } };
    }
    if (seg2 === 'modules' && method === 'PUT') {
      await sbRequireAdmin();
      const updates = body.modules || [body];
      for (const m of updates) {
        if (!m || !m.id) continue;
        if (['overview', 'settings'].includes(m.id) && !Number(m.enabled)) {
          throw new Error(`O módulo "${m.id}" não pode ser desabilitado.`);
        }
        await q(sb.from('hub_modules_config').update({ enabled: Number(m.enabled) ? 1 : 0 }).eq('id', m.id).select());
      }
      await sbLog('Módulos do portal atualizados', 'settings');
      return { ok: true, modules: await q(sb.from('hub_modules_config').select('*').order('position')) };
    }
  }

  // ---------------- INCIDENTES ----------------
  if (seg1 === 'incidents') {
    if (method === 'GET') return q(sb.from('hub_incidents').select('*').order('created_at', { ascending: false }));
    if (method === 'POST') {
      await sbRequireAdmin();
      if (!body.title) throw new Error('title é obrigatório');
      const ids = await q(sb.from('hub_incidents').select('id').like('id', 'INC-%'));
      const id = body.id || nextId(ids, 'INC-', 1000);
      const row = { id, title: body.title, priority: body.priority || 'P3', category: body.category || 'Geral',
        status: body.status || 'Aberto', assignee: body.assignee || '', team: body.team || '',
        sla_limit: body.sla_limit || null, created_at: new Date().toISOString(),
        description: body.description || '', rca: body.rca || null };
      const data = await q(sb.from('hub_incidents').insert(row).select().single());
      await sbLog(`Chamado ${id} criado`, 'itsm');
      return data;
    }
    if (method === 'PUT' && seg2) {
      await sbRequireAdmin();
      const allowed = ['title','priority','category','status','assignee','team','sla_limit','description','rca'];
      const upd = {}; allowed.forEach(c => { if (body[c] !== undefined) upd[c] = body[c]; });
      const data = await q(sb.from('hub_incidents').update(upd).eq('id', seg2).select().single());
      await sbLog(`Chamado ${seg2} atualizado`, 'itsm');
      return data;
    }
  }

  // ---------------- PROBLEMAS / RFCs / CAB ----------------
  if (seg1 === 'problems') return q(sb.from('hub_problems').select('*').order('id'));

  if (seg1 === 'rfcs') {
    if (method === 'GET') return q(sb.from('hub_rfcs').select('*').order('window_start'));
    if (method === 'POST') {
      await sbRequireAdmin();
      if (!body.title) throw new Error('title é obrigatório');
      const ids = await q(sb.from('hub_rfcs').select('id').like('id', 'RFC-%'));
      const id = body.id || nextId(ids, 'RFC-', 3000);
      const row = { id, title: body.title, type: body.type || 'Normal', risk: body.risk || 'Médio',
        system: body.system || '', window_start: body.window_start || null, window_end: body.window_end || null,
        cab_meeting: body.cab_meeting || null, manager: body.manager || '', ci_related: body.ci_related || '',
        status: body.status || 'Submetida', dependencies: body.dependencies || '', impact: body.impact || '' };
      const data = await q(sb.from('hub_rfcs').insert(row).select().single());
      await sbLog(`RFC ${id} criada`, 'changes');
      return data;
    }
    if (method === 'PUT' && seg2) {
      await sbRequireAdmin();
      const allowed = ['title','type','risk','system','window_start','window_end','cab_meeting','manager','ci_related','status','dependencies','impact'];
      const upd = {}; allowed.forEach(c => { if (body[c] !== undefined) upd[c] = body[c]; });
      const data = await q(sb.from('hub_rfcs').update(upd).eq('id', seg2).select().single());
      await sbLog(`RFC ${seg2} atualizada`, 'changes');
      return data;
    }
  }

  if (seg1 === 'cab-meetings') return q(sb.from('hub_cab_meetings').select('*').order('meeting_date'));

  // ---------------- CONTRATOS ----------------
  if (seg1 === 'contracts') {
    if (method === 'GET') return q(sb.from('hub_contracts').select('*').order('end_date'));
    if (method === 'POST') {
      await sbRequireAdmin();
      if (!body.title) throw new Error('title é obrigatório');
      const id = body.id || `CTR-${new Date().getFullYear()}-${String(Date.now()).slice(-4)}`;
      const row = { id, title: body.title, supplier: body.supplier || '', type: body.type || 'OPEX',
        value: Number(body.value) || 0, start_date: body.start_date || null, end_date: body.end_date || null,
        renewal: body.renewal || '', responsible: body.responsible || '', scope: body.scope || '', status: body.status || 'Ativo' };
      const data = await q(sb.from('hub_contracts').insert(row).select().single());
      await sbLog(`Contrato ${id} criado`, 'contracts');
      return data;
    }
    if (method === 'PUT' && seg2) {
      await sbRequireAdmin();
      const allowed = ['title','supplier','type','value','start_date','end_date','renewal','responsible','scope','status'];
      const upd = {}; allowed.forEach(c => { if (body[c] !== undefined) upd[c] = body[c]; });
      const data = await q(sb.from('hub_contracts').update(upd).eq('id', seg2).select().single());
      await sbLog(`Contrato ${seg2} editado`, 'contracts');
      return data;
    }
  }

  // ---------------- FORNECEDORES / RISCOS ----------------
  if (seg1 === 'suppliers') return q(sb.from('hub_suppliers').select('*').order('total_value', { ascending: false }));

  if (seg1 === 'risks') {
    if (method === 'GET') {
      const data = await q(sb.from('hub_risks').select('*'));
      return data.sort((a, b) => b.probability * b.impact - a.probability * a.impact);
    }
    if (method === 'POST') {
      await sbRequireAdmin();
      if (!body.description) throw new Error('description é obrigatório');
      const codes = await q(sb.from('hub_risks').select('code').like('code', 'RSC-%'));
      const max = codes.map(r => Number(r.code.slice(4))).filter(n => !isNaN(n)).reduce((a, b) => Math.max(a, b), 0);
      const code = body.code || `RSC-${String(max + 1).padStart(3, '0')}`;
      const row = { code, description: body.description, category: body.category || 'Geral',
        probability: Number(body.probability) || 3, impact: Number(body.impact) || 3,
        kri_score: Number(body.kri_score) || 50, status: body.status || 'Ativo', mitigation_plan: body.mitigation_plan || '' };
      const data = await q(sb.from('hub_risks').insert(row).select().single());
      await sbLog(`Risco ${code} registrado`, 'risks');
      return data;
    }
    if (method === 'PUT' && seg2) {
      await sbRequireAdmin();
      const allowed = ['description','category','probability','impact','kri_score','status','mitigation_plan'];
      const upd = {}; allowed.forEach(c => { if (body[c] !== undefined) upd[c] = body[c]; });
      const data = await q(sb.from('hub_risks').update(upd).eq('id', Number(seg2)).select().single());
      await sbLog(`Risco #${seg2} atualizado`, 'risks');
      return data;
    }
  }

  // ---------------- BUDGET ----------------
  if (seg1 === 'budget') {
    const year = new Date().getFullYear();
    const entries = await q(sb.from('hub_budget_entries').select('*').eq('year', year).order('month'));
    const totals = [];
    for (const cat of ['CAPEX', 'OPEX']) {
      const list = entries.filter(e => e.category === cat);
      totals.push({ category: cat,
        planned: list.reduce((a, e) => a + Number(e.planned), 0),
        realized: list.reduce((a, e) => a + Number(e.realized), 0) });
    }
    const by_tower = [], by_month = [];
    for (const t of [...new Set(entries.map(e => e.tower))]) {
      const list = entries.filter(e => e.tower === t);
      by_tower.push({ tower: t,
        planned: list.reduce((a, e) => a + Number(e.planned), 0),
        realized: list.reduce((a, e) => a + Number(e.realized), 0) });
    }
    by_tower.sort((a, b) => b.planned - a.planned);
    for (let m = 1; m <= 12; m++) {
      const list = entries.filter(e => e.month === m);
      by_month.push({ month: m,
        planned: list.reduce((a, e) => a + Number(e.planned), 0),
        realized: list.reduce((a, e) => a + Number(e.realized), 0) });
    }
    return { year, entries, totals, by_tower, by_month };
  }

  // ---------------- OKRs ----------------
  if (seg1 === 'okrs') {
    if (method === 'GET') {
      const [okrs, krs] = await Promise.all([
        q(sb.from('hub_okrs').select('*').order('id')),
        q(sb.from('hub_key_results').select('*').order('id'))
      ]);
      okrs.forEach(o => o.key_results = krs.filter(k => k.okr_id === o.id));
      return okrs;
    }
    if (method === 'POST') {
      await sbRequireAdmin();
      if (!body.title) throw new Error('title é obrigatório');
      const okr = await q(sb.from('hub_okrs').insert({
        title: body.title, cycle: body.cycle || 'Q2 2026', area: body.area || 'TI',
        strategic_alignment: body.strategic_alignment || '', target_pct: Number(body.target_pct) || 100,
        current_pct: Number(body.current_pct) || 0, status: body.status || 'Em andamento' }).select().single());
      if (Array.isArray(body.key_results) && body.key_results.length) {
        await q(sb.from('hub_key_results').insert(body.key_results.map(k => ({
          okr_id: okr.id, description: k.description || '', target: k.target || '', current: k.current || '',
          responsible: k.responsible || '', status: k.status || 'Em andamento', progress_pct: Number(k.progress_pct) || 0 }))).select());
      }
      await sbLog(`OKR "${body.title}" criado`, 'okrs');
      return { ok: true, id: okr.id };
    }
    if (method === 'PUT' && seg2) {
      await sbRequireAdmin();
      const allowed = ['title','cycle','area','strategic_alignment','target_pct','current_pct','status'];
      const upd = {}; allowed.forEach(c => { if (body[c] !== undefined) upd[c] = body[c]; });
      await q(sb.from('hub_okrs').update(upd).eq('id', Number(seg2)).select());
      await sbLog(`OKR #${seg2} atualizado`, 'okrs');
      return { ok: true };
    }
  }

  // ---------------- SLA ----------------
  if (seg1 === 'sla') {
    const [open, history] = await Promise.all([
      q(sb.from('hub_incidents').select('*').neq('status', 'Resolvido').order('sla_limit')),
      q(sb.from('hub_sla_records').select('*').order('date', { ascending: false }))
    ]);
    const groupBy = (arr, key) => {
      const map = {};
      arr.forEach(r => { (map[r[key]] = map[r[key]] || []).push(r); });
      return map;
    };
    const by_team = Object.entries(groupBy(history, 'team')).map(([team, list]) => ({
      team, total: list.length,
      breaches: list.filter(r => r.breached).length,
      mttr_min: Math.round(list.reduce((a, r) => a + r.resolution_time, 0) / list.length),
      avg_response_min: Math.round(list.reduce((a, r) => a + r.response_time, 0) / list.length)
    })).sort((a, b) => a.breaches - b.breaches);
    const by_category = Object.entries(groupBy(history, 'category')).map(([category, list]) => ({
      category, total: list.length, breaches: list.filter(r => r.breached).length
    })).sort((a, b) => b.total - a.total);
    return { open_incidents: open, history: history.slice(0, 200), by_team, by_category };
  }

  // ---------------- AUDITORIA ----------------
  if (seg1 === 'audit') {
    const [evidences, actions] = await Promise.all([
      q(sb.from('hub_evidences').select('*').order('expires_at')),
      q(sb.from('hub_audit_actions').select('*').order('deadline'))
    ]);
    const by_framework = [...new Set(evidences.map(e => e.framework))].map(fw => {
      const list = evidences.filter(e => e.framework === fw);
      return { framework: fw, total: list.length,
        valid: list.filter(e => e.status === 'Válida').length,
        expiring: list.filter(e => e.status === 'Vencendo').length,
        expired: list.filter(e => e.status === 'Vencida').length };
    });
    return { evidences, actions, by_framework };
  }

  if (seg1 === 'evidences' && method === 'POST') {
    await sbRequireAdmin();
    if (!body.control) throw new Error('control é obrigatório');
    const data = await q(sb.from('hub_evidences').insert({
      framework: body.framework || 'ISO 27001', domain: body.domain || '', control: body.control,
      type: body.type || 'Relatório', responsible: body.responsible || '',
      collected_at: body.collected_at || new Date().toISOString(), expires_at: body.expires_at || null,
      status: body.status || 'Válida', approver: body.approver || '', notes: body.notes || '' }).select().single());
    await sbLog(`Evidência registrada: ${body.control}`, 'audit');
    return { ok: true, id: data.id };
  }

  // ---------------- SEGURANÇA / IA / LISTAS ----------------
  if (seg1 === 'security') {
    const [vulnerabilities, pam_accounts] = await Promise.all([
      q(sb.from('hub_vulnerabilities').select('*').order('cvss', { ascending: false })),
      q(sb.from('hub_pam_accounts').select('*').order('rotation_days', { ascending: false }))
    ]);
    return { vulnerabilities, pam_accounts };
  }
  if (seg1 === 'ai-models') return q(sb.from('hub_ai_models').select('*').order('id'));
  if (seg1 === 'alerts') return q(sb.from('hub_alerts').select('*').order('created_at', { ascending: false }).limit(20));
  if (seg1 === 'activity') return q(sb.from('hub_activity_log').select('*').order('ts', { ascending: false }).limit(100));
  if (seg1 === 'data-sources') return q(sb.from('hub_data_sources').select('*').order('id'));

  // ---------------- KPIs AGREGADOS ----------------
  if (seg1 === 'kpis') {
    const year = new Date().getFullYear();
    const [incidents, budget, contracts, rfcs, risks, slaRecs, okrs, evidences, vulns, aiModels, suppliers] = await Promise.all([
      q(sb.from('hub_incidents').select('priority,status')),
      q(sb.from('hub_budget_entries').select('planned,realized').eq('year', year)),
      q(sb.from('hub_contracts').select('value,status')),
      q(sb.from('hub_rfcs').select('status')),
      q(sb.from('hub_risks').select('probability,impact')),
      q(sb.from('hub_sla_records').select('breached')),
      q(sb.from('hub_okrs').select('current_pct')),
      q(sb.from('hub_evidences').select('status')),
      q(sb.from('hub_vulnerabilities').select('severity,status')),
      q(sb.from('hub_ai_models').select('status,tokens_month')),
      q(sb.from('hub_suppliers').select('sla_pct'))
    ]);
    const activeC = contracts.filter(c => ['Ativo', 'Vencendo', 'Em renegociação'].includes(c.status));
    const slaT = slaRecs.length, slaB = slaRecs.filter(r => r.breached).length;
    const evV = evidences.filter(e => e.status === 'Válida').length;
    return {
      generated_at: new Date().toISOString(),
      incidents_p1_open: incidents.filter(i => i.priority === 'P1' && i.status !== 'Resolvido').length,
      incidents_open: incidents.filter(i => i.status !== 'Resolvido').length,
      budget_annual: budget.reduce((a, e) => a + Number(e.planned), 0),
      budget_realized: budget.reduce((a, e) => a + Number(e.realized), 0),
      contracts_active: activeC.length,
      contracts_value: activeC.reduce((a, c) => a + Number(c.value), 0),
      rfcs_pending: rfcs.filter(r => ['Submetida', 'Em avaliação'].includes(r.status)).length,
      risks_critical: risks.filter(r => r.probability * r.impact >= 15).length,
      sla_pct: slaT ? Math.round((1 - slaB / slaT) * 1000) / 10 : 100,
      okr_avg_pct: okrs.length ? Math.round(okrs.reduce((a, o) => a + Number(o.current_pct), 0) / okrs.length) : 0,
      compliance_pct: evidences.length ? Math.round(evV / evidences.length * 100) : 0,
      vulns_critical: vulns.filter(v => v.severity === 'Crítica' && v.status !== 'Corrigida').length,
      ai_models_prod: aiModels.filter(m => m.status === 'Produção').length,
      ai_tokens_month: aiModels.reduce((a, m) => a + Number(m.tokens_month), 0),
      suppliers_count: suppliers.length,
      suppliers_sla_avg: suppliers.length ? Math.round(suppliers.reduce((a, s) => a + Number(s.sla_pct), 0) / suppliers.length * 100) / 100 : 0,
      assets_inventoried: 1284
    };
  }

  // ---------------- N8N ----------------
  if (seg1 === 'n8n') {
    if (seg2 === 'config' && method === 'GET') {
      // anon não tem grant na coluna api_key — só consulta se for admin
      const admin = await sbIsAdmin();
      const cols = admin ? 'base_url,api_key,last_sync' : 'base_url,last_sync';
      const rows = await q(sb.from('hub_n8n_config').select(cols).eq('id', 1));
      const cfg = rows[0] || {};
      return { base_url: cfg.base_url || '', api_key_set: !!cfg.api_key, last_sync: cfg.last_sync };
    }
    if (seg2 === 'config' && method === 'PUT') {
      await sbRequireAdmin();
      const upd = { base_url: body.base_url || '' };
      if (body.api_key !== undefined) upd.api_key = body.api_key;
      await q(sb.from('hub_n8n_config').update(upd).eq('id', 1).select());
      await sbLog('Configuração N8N atualizada', 'n8n');
      return { ok: true };
    }
    if (seg2 === 'trigger' && method === 'POST') {
      await sbRequireAdmin();
      const rows = await q(sb.from('hub_n8n_config').select('base_url,api_key').eq('id', 1));
      const cfg = rows[0] || {};
      const workflow = body.workflow || 'default';
      if (!cfg.base_url) {
        await sbLog(`Disparo N8N simulado (sem URL configurada): ${workflow}`, 'n8n');
        return { ok: true, simulated: true, message: 'N8N não configurado — disparo simulado registrado no histórico.' };
      }
      const url = cfg.base_url.replace(/\/+$/, '') + '/webhook/' + encodeURIComponent(workflow);
      const payload = JSON.stringify({ source: 'hub_gov_ti_v2_cloud', ts: new Date().toISOString(), ...(body.payload || {}) });
      try {
        const r = await fetch(url, { method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cfg.api_key ? { 'X-N8N-API-KEY': cfg.api_key } : {}) },
          body: payload, signal: AbortSignal.timeout(10000) });
        await sbLog(`Webhook N8N disparado: ${workflow} (HTTP ${r.status})`, 'n8n');
        return { ok: r.ok, status: r.status, workflow };
      } catch (e) {
        // CORS bloqueia leitura da resposta no browser — reenvia em modo opaco
        try {
          await fetch(url, { method: 'POST', mode: 'no-cors',
            headers: { 'Content-Type': 'application/json' }, body: payload });
          await sbLog(`Webhook N8N disparado (no-cors): ${workflow}`, 'n8n');
          return { ok: true, status: 0, workflow, message: 'Disparado (resposta opaca por CORS)' };
        } catch (e2) {
          await sbLog(`Falha no disparo N8N: ${workflow} — ${e2.message}`, 'n8n');
          throw new Error(`Falha ao alcançar o N8N: ${e2.message}`);
        }
      }
    }
  }

  throw new Error(`Endpoint não suportado: ${method} ${path}`);
}
window.sbApi = sbApi;

// Quando o usuário clica no link de redefinição recebido por e-mail,
// o Supabase devolve para o portal com uma sessão de recuperação:
sb.auth.onAuthStateChange((event) => {
  if (event === 'PASSWORD_RECOVERY' && typeof window.onPasswordRecovery === 'function') {
    window.onPasswordRecovery();
  }
});
