/* =====================================================================
   HUB GOV TI v2 — app.js (frontend)
   Todos os dados vêm da API REST (fetch). Admin desbloqueia escrita.
   ===================================================================== */
'use strict';

// ---------------------- Estado global ----------------------
const S = {
  cfg: null,          // /api/config
  isAdmin: false,
  kpis: null,
  cache: {},          // cache por endpoint
  charts: [],
  currentModule: 'overview',
  slaTimer: null
};

const C = {
  blue: '#1E50A0', blueLight: '#4F8EF7', green: '#1A9E6A',
  amber: '#D4820A', red: '#C53030', purple: '#6B46C1',
  gray: '#4A5568', bg2: '#E8EEF8'
};
const MONTHS = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez'];

// ---------------------- API helpers ----------------------
async function api(path, opts = {}) {
  // Versão cloud: delega para o adaptador Supabase (mesmo contrato da API REST)
  return sbApi(path, opts);
}
async function get(path, fresh = false) {
  if (!fresh && S.cache[path]) return S.cache[path];
  const d = await api(path);
  S.cache[path] = d;
  return d;
}
function invalidate(prefix) {
  Object.keys(S.cache).forEach(k => { if (k.startsWith(prefix)) delete S.cache[k]; });
}

// ---------------------- Utilitários ----------------------
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
const fmtBRL = v => (v ?? 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: 0 });
const fmtBRLm = v => 'R$ ' + ((v ?? 0) / 1e6).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'M';
const fmtNum = v => (v ?? 0).toLocaleString('pt-BR');
const fmtDate = s => s ? new Date(s).toLocaleDateString('pt-BR') : '—';
const fmtDateTime = s => s ? new Date(s).toLocaleString('pt-BR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '—';

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast t-${type}`;
  el.textContent = msg;
  document.getElementById('toastArea').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 3800);
}

function openModal(title, bodyHTML) {
  document.getElementById('modalTitle').innerHTML = title;
  document.getElementById('modalBody').innerHTML = bodyHTML;
  document.getElementById('modalOverlay').classList.add('open');
}
function closeModal() { document.getElementById('modalOverlay').classList.remove('open'); }

function detailGrid(pairs) {
  return '<div class="detail-grid">' + pairs.map(([l, v, full]) =>
    `<div class="${full ? 'dt-full' : ''}"><div class="dt-label">${esc(l)}</div><div class="dt-value">${v}</div></div>`).join('') + '</div>';
}

function badge(text, cls) { return `<span class="badge b-${cls}">${esc(text)}</span>`; }
function priBadge(p) { return badge(p, p === 'P1' ? 'red' : p === 'P2' ? 'amber' : p === 'P3' ? 'blue' : 'gray'); }
function statusBadge(st) {
  const map = { 'Aberto':'red','Em andamento':'amber','Aguardando':'purple','Resolvido':'green','Ativo':'green',
    'Vencendo':'amber','Em renegociação':'amber','Mitigando':'blue','Aceito':'gray','Válida':'green','Vencida':'red',
    'Atrasado':'red','Concluído':'green','Em risco':'red','Aprovada CAB':'green','Implementada':'green',
    'Em avaliação':'amber','Submetida':'blue','Agendada':'blue','Conectada':'green','Atenção':'amber',
    'Produção':'green','Homologação':'amber','Em correção':'amber','Aberta':'red','Planejada':'blue','Em análise':'amber' };
  return badge(st, map[st] || 'gray');
}

function kpi(label, value, sub = '', color = '') {
  return `<div class="kpi ${color ? 'k-' + color : ''}">
    <div class="kpi-label">${esc(label)}</div>
    <div class="kpi-value">${value}</div>
    <div class="kpi-sub">${sub}</div></div>`;
}

function barRow(label, pct, color = C.blue, valueText = null) {
  return `<div class="bar-row"><div class="bar-label"><span>${esc(label)}</span><span>${valueText ?? pct + '%'}</span></div>
    <div class="bar-track"><div class="bar-fill" style="width:${Math.min(pct, 100)}%;background:${color}"></div></div></div>`;
}

// SLA countdown — devolve HTML com classe por faixa restante
function slaCountdown(createdISO, slaISO) {
  if (!slaISO) return '<span class="cd-ok">—</span>';
  const now = Date.now(), sla = new Date(slaISO).getTime(), created = createdISO ? new Date(createdISO).getTime() : now - 3600000;
  const total = Math.max(sla - created, 1), left = sla - now;
  if (left <= 0) return `<span class="cd-breach" data-sla="${slaISO}" data-created="${createdISO || ''}">VIOLADO</span>`;
  const pct = left / total;
  const cls = pct > 0.5 ? 'cd-ok' : pct > 0.1 ? 'cd-warn' : 'cd-crit';
  const h = Math.floor(left / 3600000), m = Math.floor((left % 3600000) / 60000);
  return `<span class="${cls} mono" data-sla="${slaISO}" data-created="${createdISO || ''}">${h}h ${String(m).padStart(2, '0')}m</span>`;
}
function startSlaTick() {
  stopSlaTick();
  S.slaTimer = setInterval(() => {
    document.querySelectorAll('[data-sla]').forEach(el => {
      el.outerHTML = slaCountdown(el.dataset.created, el.dataset.sla);
    });
  }, 30000);
}
function stopSlaTick() { if (S.slaTimer) { clearInterval(S.slaTimer); S.slaTimer = null; } }

// Charts com gerenciamento de destroy
function destroyCharts() { S.charts.forEach(c => c.destroy()); S.charts = []; }
function mkChart(canvasId, config) {
  const el = document.getElementById(canvasId);
  if (!el) return null;
  Chart.defaults.font.family = 'Inter, sans-serif';
  Chart.defaults.color = C.gray;
  const ch = new Chart(el.getContext('2d'), config);
  S.charts.push(ch);
  return ch;
}

// Export Excel (XLSX.js)
function exportExcel(rows, name) {
  if (!rows || !rows.length) return toast('Nada para exportar', 'error');
  const ws = XLSX.utils.json_to_sheet(rows);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  XLSX.writeFile(wb, `hub_gov_ti_${name}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  toast(`Excel "${name}" exportado ✓`, 'success');
}
function exportBtn(jsVar, name) {
  return `<button class="btn btn-green btn-sm" onclick="exportExcel(${jsVar}, '${name}')">📊 Exportar Excel</button>`;
}

// Disparo N8N (admin)
async function dispararN8N(workflow, payload = {}) {
  if (!S.isAdmin) return toast('Apenas Admin pode disparar workflows N8N', 'error');
  try {
    const r = await api('/n8n/trigger', { method: 'POST', body: { workflow, payload } });
    toast(r.simulated ? `⚡ N8N não configurado — disparo "${workflow}" simulado` : `⚡ Workflow "${workflow}" disparado (HTTP ${r.status})`, 'success');
  } catch (e) { toast('Falha N8N: ' + e.message, 'error'); }
}
function n8nBtn(workflow, label = '⚡ Disparar N8N') {
  return `<button class="btn btn-secondary btn-sm" onclick="dispararN8N('${workflow}')">${label}</button>`;
}

// ---------------------- Relógio + Ticker ----------------------
setInterval(() => {
  document.getElementById('clock').textContent = new Date().toLocaleTimeString('pt-BR');
}, 1000);

async function buildTicker() {
  try {
    const [k, ds] = await Promise.all([get('/kpis', true), get('/data-sources', true)]);
    S.kpis = k;
    const parts = [
      `<span class="${k.incidents_p1_open ? 'tk-crit' : 'tk-ok'}">🚨 P1 abertos: ${k.incidents_p1_open}</span>`,
      `<span>📋 Incidentes ativos: ${k.incidents_open}</span>`,
      `<span class="tk-ok">⏱️ SLA: ${k.sla_pct}%</span>`,
      `<span>💰 Budget: ${fmtBRLm(k.budget_annual)} · realizado ${fmtBRLm(k.budget_realized)}</span>`,
      `<span>📑 Contratos ativos: ${k.contracts_active} (${fmtBRLm(k.contracts_value)})</span>`,
      `<span class="${k.vulns_critical ? 'tk-warn' : 'tk-ok'}">🔐 Vulns críticas: ${k.vulns_critical}</span>`,
      `<span>🎯 OKRs ciclo: ${k.okr_avg_pct}%</span>`,
      `<span>✅ Conformidade: ${k.compliance_pct}%</span>`,
      ...ds.map(d => `<span class="${d.status === 'Conectada' ? 'tk-ok' : 'tk-warn'}">🔌 ${esc(d.name)}: ${d.status}</span>`)
    ];
    document.getElementById('ticker').innerHTML = parts.join('') + parts.join('');
  } catch (e) { /* ticker silencioso */ }
}

async function syncAll() {
  const btn = document.getElementById('btnSync');
  btn.disabled = true; btn.textContent = '⏳ Sincronizando…';
  S.cache = {};
  await buildTicker();
  await navTo(S.currentModule, true);
  btn.disabled = false; btn.textContent = '🔄 Sync All';
  toast('Dados sincronizados com o servidor ✓', 'success');
}

// ---------------------- Auth ----------------------
async function refreshAuth() {
  try { S.isAdmin = (await api('/auth/status')).isAdmin; } catch { S.isAdmin = false; }
  document.getElementById('btnAdmin').innerHTML = S.isAdmin ? '🔓 Sair (Admin)' : '🔐 Admin';
  document.getElementById('footerRole').textContent = S.isAdmin ? 'Modo Administrador' : 'Modo Visualizador';
}
function adminButton() {
  if (S.isAdmin) return doLogout();
  openModal('🔐 Login Administrador', `
    <p style="font-size:.84rem;color:var(--text-2);margin-bottom:14px">Acesso de escrita: gerenciar módulos, editar dados, N8N e cadastros.<br>Sessão de 15 minutos · bloqueio após 5 tentativas.</p>
    <div class="fld"><label>Senha</label><input type="password" id="pwdInput" onkeydown="if(event.key==='Enter')doLogin()"></div>
    <div style="margin-top:14px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="doLogin()">Entrar</button>
      <button class="btn btn-secondary" onclick="closeModal()">Cancelar</button>
      <a href="#" onclick="openResetFlow();return false" style="font-size:.78rem;color:var(--blue);margin-left:auto">🔁 Trocar / esqueci a senha</a>
    </div>`);
  setTimeout(() => document.getElementById('pwdInput')?.focus(), 100);
}
async function doLogin() {
  const pwd = document.getElementById('pwdInput').value;
  try {
    await api('/auth/login', { method: 'POST', body: { password: pwd } });
    closeModal();
    await refreshAuth();
    toast('Sessão admin iniciada (15 min) ✓', 'success');
    navTo(S.currentModule, true);
  } catch (e) { toast(e.message, 'error'); }
}
async function doLogout() {
  await api('/auth/logout', { method: 'POST' });
  await refreshAuth();
  toast('Sessão encerrada', 'info');
  navTo(S.currentModule, true);
}

// ---- Troca de senha com validação por e-mail (Supabase Auth) ----
function openResetFlow() {
  openModal('🔁 Trocar Senha do Admin', `
    <p style="font-size:.84rem;color:var(--text-2);margin-bottom:14px">
      Você receberá um <b>link de redefinição</b> no e-mail cadastrado.
      Ao clicar no link, voltará para este portal para definir a nova senha.</p>
    <button class="btn btn-primary" id="btnSendCode" onclick="requestReset()">📧 Enviar link por e-mail</button>`);
}
async function requestReset() {
  const btn = document.getElementById('btnSendCode');
  btn.disabled = true; btn.textContent = '⏳ Enviando…';
  try {
    const r = await api('/auth/request-reset', { method: 'POST' });
    btn.textContent = `✓ Link enviado para ${r.email_masked}`;
    toast(`Link de redefinição enviado para ${r.email_masked} ✓ Verifique a caixa de entrada (e o spam).`, 'success');
  } catch (e) { toast(e.message, 'error'); btn.disabled = false; btn.textContent = '📧 Enviar link por e-mail'; }
}
// Chamado pelo adaptador quando o usuário volta pelo link do e-mail
window.onPasswordRecovery = function () {
  openModal('🔑 Definir Nova Senha', `
    <p style="font-size:.84rem;color:var(--text-2);margin-bottom:14px">Identidade validada pelo link do e-mail ✓ — defina a nova senha do admin.</p>
    <div class="fld"><label>Nova senha (mín. 8 caracteres)</label><input id="np_pwd" type="password"></div>
    <div style="margin-top:14px"><button class="btn btn-green" onclick="submitNewPassword()">💾 Salvar nova senha</button></div>`);
};
async function submitNewPassword() {
  try {
    await api('/auth/update-password', { method: 'POST', body: { new_password: document.getElementById('np_pwd').value } });
    closeModal();
    await refreshAuth();
    toast('Senha alterada com sucesso ✓', 'success');
    navTo(S.currentModule, true);
  } catch (e) { toast(e.message, 'error'); }
}

// ---------------------- Navegação ----------------------
const RENDERERS = {};

async function renderTabs() {
  S.cfg = await get('/config', true);
  const tabs = S.cfg.modules.filter(m => m.enabled).map(m =>
    `<div class="tab ${m.id === S.currentModule ? 'active' : ''}" data-mod="${m.id}" onclick="navTo('${m.id}')">${m.icon} ${esc(m.label)}</div>`).join('');
  document.getElementById('tabs').innerHTML = tabs;
}

async function navTo(id, fresh = false) {
  S.currentModule = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.mod === id));
  destroyCharts(); stopSlaTick();
  const main = document.getElementById('main');
  main.innerHTML = '<div class="loading-panel">Carregando módulo…</div>';
  try {
    const renderer = RENDERERS[id] || renderPlaceholder;
    if (fresh) invalidate('/');
    main.innerHTML = `<div class="panel">${await renderer()}</div>`;
    afterRender(id);
  } catch (e) {
    main.innerHTML = `<div class="loading-panel">⚠️ Erro ao carregar: ${esc(e.message)}</div>`;
  }
}
window.navToModule = navTo; // compat com grid de módulos

// pós-render: monta gráficos do módulo atual
function afterRender(id) {
  const fn = POST_RENDER[id];
  if (fn) fn();
  startSlaTick();
}
const POST_RENDER = {};

// sub-abas genéricas
function subtabsHTML(id, tabs, active) {
  return `<div class="subtabs">` + tabs.map(t =>
    `<div class="subtab ${t.id === active ? 'active' : ''}" onclick="switchSub('${id}','${t.id}')">${esc(t.label)}</div>`).join('') + `</div>`;
}
async function switchSub(moduleId, subId) {
  destroyCharts();
  S.sub = S.sub || {};
  S.sub[moduleId] = subId;
  const main = document.getElementById('main');
  main.innerHTML = `<div class="panel">${await RENDERERS[moduleId]()}</div>`;
  afterRender(moduleId);
}
function curSub(moduleId, def) { return (S.sub && S.sub[moduleId]) || def; }

function renderPlaceholder() {
  return `<div class="card"><h4>Módulo em construção</h4><p style="font-size:.84rem">Este módulo será detalhado em uma próxima iteração.</p></div>`;
}

// adminOnly wrapper
const adminOnly = html => S.isAdmin ? html : '';

// =====================================================================
// 📊 VISÃO GERAL
// =====================================================================
RENDERERS.overview = async () => {
  const [k, incidents, budget, audit, alerts, ds, activity, okrs] = await Promise.all([
    get('/kpis'), get('/incidents'), get('/budget'), get('/audit'),
    get('/alerts'), get('/data-sources'), get('/activity'), get('/okrs')
  ]);
  const okrAvg = okrs.length ? Math.round(okrs.reduce((a, o) => a + o.current_pct, 0) / okrs.length) : 0;

  const moduleGrid = S.cfg.modules.map(m =>
    `<div class="module-card ${m.enabled ? '' : 'disabled'}" ${m.enabled ? `onclick="navToModule('${m.id}')"` : ''}>
      <div class="mc-icon">${m.icon}</div><div class="mc-label">${esc(m.label)}</div></div>`).join('');

  const alertsHTML = alerts.map(a => `
    <div class="alert-item a-${a.severity}">
      <span>${a.severity === 'critical' ? '🔴' : a.severity === 'warning' ? '🟡' : '🔵'}</span>
      <div><div>${esc(a.message)}</div><div class="alert-time">${fmtDateTime(a.created_at)} · módulo ${esc(a.module)}</div></div>
    </div>`).join('');

  const intHTML = ds.map(d => `
    <div class="toggle-row"><span>${d.status === 'Conectada' ? '🟢' : '🟡'}</span>
      <span class="tr-label">${esc(d.name)}</span>
      <span class="mono" style="font-size:.7rem">${fmtNum(d.records_count)} reg.</span>${statusBadge(d.status)}</div>`).join('');

  const logHTML = activity.slice(0, 10).map(a => `
    <div class="toggle-row"><span class="mono" style="font-size:.68rem;color:var(--text-2)">${fmtDateTime(a.ts)}</span>
      <span class="tr-label" style="font-size:.78rem">${esc(a.action)}</span>${badge(a.actor, 'blue')}</div>`).join('');

  return `
    <div class="kpi-grid">
      ${kpi('Incidentes P1', k.incidents_p1_open, 'abertos agora', 'red')}
      ${kpi('Budget TI Anual', fmtBRLm(k.budget_annual), `realizado ${fmtBRLm(k.budget_realized)}`, 'green')}
      ${kpi('Contratos Ativos', k.contracts_active, fmtBRLm(k.contracts_value) + ' em carteira')}
      ${kpi('Conformidade Média', k.compliance_pct + '%', 'evidências válidas', 'purple')}
      ${kpi('RFCs Pendentes', k.rfcs_pending, 'aguardando CAB', 'amber')}
      ${kpi('Ativos Inventariados', fmtNum(k.assets_inventoried), 'CMDB sincronizado')}
    </div>

    <div class="section-title">🧭 Módulos do Portal</div>
    <div class="module-grid">${moduleGrid}</div>

    <div class="section-title">📈 Indicadores Executivos</div>
    <div class="grid-2">
      <div class="card"><h4>Tendência de Incidentes — 6 meses</h4><div class="chart-box"><canvas id="chIncTrend"></canvas></div></div>
      <div class="card"><h4>Distribuição por Prioridade</h4><div class="chart-box"><canvas id="chPrio"></canvas></div></div>
      <div class="card"><h4>Budget Mensal — Planejado × Realizado</h4><div class="chart-box"><canvas id="chBudget"></canvas></div></div>
      <div class="card"><h4>Conformidade por Framework</h4><div class="chart-box"><canvas id="chComp"></canvas></div></div>
    </div>

    <div class="grid-2" style="margin-top:16px">
      <div class="card"><h4>🎯 OKRs — Ciclo Atual</h4>
        ${barRow('Atingimento médio do ciclo Q2 2026', okrAvg, okrAvg >= 70 ? C.green : okrAvg >= 50 ? C.amber : C.red)}
        ${okrs.map(o => barRow(o.title, o.current_pct, o.current_pct >= 70 ? C.green : o.current_pct >= 50 ? C.amber : C.red)).join('')}
      </div>
      <div class="card"><h4>⏱️ SLA Geral</h4>
        ${barRow('% chamados dentro do prazo (histórico)', k.sla_pct, k.sla_pct >= 95 ? C.green : k.sla_pct >= 85 ? C.amber : C.red)}
        <p style="font-size:.8rem;color:var(--text-2);margin-top:8px">${k.incidents_open} chamados ativos monitorados em tempo real no módulo <b>SLA Monitor</b>.</p>
        <button class="btn btn-secondary btn-sm" onclick="navToModule('sla')">Abrir SLA Monitor →</button>
      </div>
    </div>

    <div class="section-title">🚨 Alertas Críticos <span class="spacer"></span>${n8nBtn('alertas-executivos', '⚡ Notificar via N8N')}</div>
    <div class="grid-2">
      <div class="card">${alertsHTML}</div>
      <div>
        <div class="card" style="margin-bottom:16px"><h4>🔌 Status de Integrações</h4>${intHTML}</div>
        <div class="card"><h4>📜 Log Executivo</h4>${logHTML}</div>
      </div>
    </div>`;
};

POST_RENDER.overview = async () => {
  const [incidents, budget, audit, sla] = await Promise.all([get('/incidents'), get('/budget'), get('/audit'), get('/sla')]);
  // tendência 6 meses a partir do histórico SLA
  const byMonth = {};
  sla.history.forEach(r => { const m = new Date(r.date).getMonth(); byMonth[m] = (byMonth[m] || 0) + 1; });
  const nowM = new Date().getMonth();
  const labels = [], data = [];
  for (let i = 5; i >= 0; i--) { const m = (nowM - i + 12) % 12; labels.push(MONTHS[m]); data.push(byMonth[m] || 0); }
  mkChart('chIncTrend', { type: 'line', data: { labels, datasets: [{ label: 'Incidentes', data, borderColor: C.blue, backgroundColor: 'rgba(30,80,160,.08)', fill: true, tension: .35 }] }, options: { maintainAspectRatio: false, plugins: { legend: { display: false } } } });

  const prio = { P1: 0, P2: 0, P3: 0, P4: 0 };
  incidents.forEach(i => prio[i.priority] = (prio[i.priority] || 0) + 1);
  mkChart('chPrio', { type: 'doughnut', data: { labels: Object.keys(prio), datasets: [{ data: Object.values(prio), backgroundColor: [C.red, C.amber, C.blue, C.gray] }] }, options: { maintainAspectRatio: false, cutout: '62%' } });

  mkChart('chBudget', { type: 'bar', data: { labels: MONTHS, datasets: [
    { label: 'Planejado', data: budget.by_month.map(m => m.planned), backgroundColor: 'rgba(30,80,160,.25)' },
    { label: 'Realizado', data: budget.by_month.map(m => m.realized), backgroundColor: C.blue }
  ] }, options: { maintainAspectRatio: false, scales: { y: { ticks: { callback: v => (v / 1e6).toFixed(1) + 'M' } } } } });

  mkChart('chComp', { type: 'bar', data: { labels: audit.by_framework.map(f => f.framework), datasets: [{ label: '% válidas', data: audit.by_framework.map(f => Math.round(f.valid / f.total * 100)), backgroundColor: [C.blue, C.purple, C.green, C.amber] }] }, options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { max: 100 } } } });
};

// =====================================================================
// 🚨 ITSM (4 sub-abas)
// =====================================================================
RENDERERS.itsm = async () => {
  const sub = curSub('itsm', 'incidentes');
  const tabs = subtabsHTML('itsm', [
    { id: 'incidentes', label: '🚨 Incidentes' }, { id: 'problemas', label: '🧩 Problemas' },
    { id: 'rfcs', label: '🔄 RFCs & Mudanças' }, { id: 'cab', label: '📅 CAB Calendar' }
  ], sub);
  let body = '';
  if (sub === 'incidentes') body = await viewIncidentes();
  else if (sub === 'problemas') body = await viewProblemas();
  else if (sub === 'rfcs') body = await viewRFCs();
  else body = await viewCAB();
  return tabs + body;
};
POST_RENDER.itsm = () => { if (curSub('itsm', 'incidentes') === 'problemas') postProblemas(); };

async function viewIncidentes() {
  const inc = await get('/incidents');
  window._excelInc = inc;
  const open = inc.filter(i => i.status !== 'Resolvido');
  const breached = open.filter(i => i.sla_limit && new Date(i.sla_limit) < new Date()).length;
  const rows = inc.map((i, idx) => `
    <tr onclick="showIncident(${idx})">
      <td class="mono">${i.id}</td><td>${esc(i.title)}</td><td>${priBadge(i.priority)}</td>
      <td>${esc(i.category)}</td><td>${esc(i.assignee)}</td>
      <td>${i.status === 'Resolvido' ? '<span class="cd-ok">—</span>' : slaCountdown(i.created_at, i.sla_limit)}</td>
      <td>${statusBadge(i.status)}</td></tr>`).join('');
  return `
    <div class="kpi-grid">
      ${kpi('Chamados Abertos', open.length, 'em tratamento', 'red')}
      ${kpi('P1 Críticos', open.filter(i => i.priority === 'P1').length, 'prioridade máxima', 'red')}
      ${kpi('Em Andamento', open.filter(i => i.status === 'Em andamento').length, '', 'amber')}
      ${kpi('SLA Violado', breached, 'chamados estourados', breached ? 'red' : 'green')}
      ${kpi('Resolvidos', inc.length - open.length, 'no período', 'green')}
    </div>
    <div class="section-title">📋 Fila de Incidentes <span class="spacer"></span>
      ${adminOnly(`<button class="btn btn-primary btn-sm" onclick="newIncidentForm()">➕ Novo Chamado</button>`)}
      ${exportBtn('window._excelInc', 'incidentes')} ${n8nBtn('sync-itsm')}
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>ID</th><th>Título</th><th>Prioridade</th><th>Categoria</th><th>Assignado</th><th>SLA Restante</th><th>Status</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}

async function showIncident(idx) {
  const i = (await get('/incidents'))[idx];
  openModal(`🚨 ${i.id} — Detalhe do Chamado`, detailGrid([
    ['Título', esc(i.title), true],
    ['Prioridade', priBadge(i.priority)], ['Status', statusBadge(i.status)],
    ['Categoria', esc(i.category)], ['Equipe', esc(i.team)],
    ['Assignado', esc(i.assignee)], ['Aberto em', fmtDateTime(i.created_at)],
    ['SLA Limite', fmtDateTime(i.sla_limit)], ['SLA Restante', slaCountdown(i.created_at, i.sla_limit)],
    ['Descrição', esc(i.description), true],
    ...(i.rca ? [['RCA — Causa Raiz', esc(i.rca), true]] : [])
  ]) + adminOnly(`
    <div style="margin-top:16px;display:flex;gap:10px;flex-wrap:wrap">
      <button class="btn btn-primary btn-sm" onclick="updIncident('${i.id}','Em andamento')">▶ Em andamento</button>
      <button class="btn btn-green btn-sm" onclick="updIncident('${i.id}','Resolvido')">✓ Resolver</button>
      ${n8nBtn('escalonar-incidente')}
    </div>`));
}
async function updIncident(id, status) {
  try {
    await api(`/incidents/${id}`, { method: 'PUT', body: { status } });
    invalidate('/incidents'); invalidate('/kpis'); closeModal();
    toast(`${id} → ${status} ✓`, 'success');
    navTo('itsm');
  } catch (e) { toast(e.message, 'error'); }
}
function newIncidentForm() {
  openModal('➕ Novo Chamado', `
    <div class="form-grid">
      <div class="fld full"><label>Título *</label><input id="f_title"></div>
      <div class="fld"><label>Prioridade</label><select id="f_pri"><option>P1</option><option>P2</option><option selected>P3</option><option>P4</option></select></div>
      <div class="fld"><label>Categoria</label><select id="f_cat"><option>Infraestrutura</option><option>Rede</option><option>Aplicação</option><option>Acesso</option><option>Banco de Dados</option><option>Segurança</option><option>Cloud</option></select></div>
      <div class="fld"><label>Assignado</label><input id="f_asg"></div>
      <div class="fld"><label>Equipe</label><input id="f_team" value="Service Desk"></div>
      <div class="fld"><label>SLA (horas)</label><input id="f_slah" type="number" value="24"></div>
      <div class="fld full"><label>Descrição</label><textarea id="f_desc" rows="3"></textarea></div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-primary" onclick="createIncident()">Criar Chamado</button></div>`);
}
async function createIncident() {
  const v = id => document.getElementById(id).value;
  try {
    const sla = new Date(Date.now() + Number(v('f_slah') || 24) * 3600000).toISOString();
    const r = await api('/incidents', { method: 'POST', body: {
      title: v('f_title'), priority: v('f_pri'), category: v('f_cat'),
      assignee: v('f_asg'), team: v('f_team'), sla_limit: sla, description: v('f_desc') } });
    invalidate('/incidents'); invalidate('/kpis'); closeModal();
    toast(`Chamado ${r.id} criado ✓`, 'success');
    navTo('itsm');
  } catch (e) { toast(e.message, 'error'); }
}

async function viewProblemas() {
  const prb = await get('/problems');
  window._excelPrb = prb;
  const open = prb.filter(p => p.status !== 'Resolvido');
  const rows = prb.map(p => `
    <tr onclick="showProblem('${p.id}')">
      <td class="mono">${p.id}</td><td>${esc(p.title)}</td><td>${esc(p.category)}</td>
      <td>${badge(p.impact, p.impact === 'Crítico' ? 'red' : p.impact === 'Alto' ? 'amber' : 'blue')}</td>
      <td>${p.incidents_count}</td><td>${p.rca ? '✅' : '🔍'}</td><td>${statusBadge(p.status)}</td></tr>`).join('');
  const kedb = prb.filter(p => p.known_error).map(p => `
    <div class="card" style="margin-bottom:12px;border-left:4px solid var(--amber)">
      <h4>🧾 ${p.id} — ${esc(p.title)}</h4>
      <p style="font-size:.8rem"><b>Workaround documentado:</b> ${esc(p.workaround)}</p>
      ${p.rca ? `<p style="font-size:.8rem;color:var(--text-2)"><b>RCA:</b> ${esc(p.rca)}</p>` : '<p style="font-size:.78rem;color:var(--amber)">RCA em investigação</p>'}
    </div>`).join('');
  return `
    <div class="kpi-grid">
      ${kpi('Problemas Abertos', open.length, '', 'amber')}
      ${kpi('Impacto Crítico', prb.filter(p => p.impact === 'Crítico').length, '', 'red')}
      ${kpi('Known Errors', prb.filter(p => p.known_error).length, 'com workaround', 'purple')}
      ${kpi('Resolvidos', prb.filter(p => p.status === 'Resolvido').length, '', 'green')}
    </div>
    <div class="section-title">🧩 Registro de Problemas <span class="spacer"></span>${exportBtn('window._excelPrb', 'problemas')}</div>
    <div class="table-wrap"><table><thead><tr>
      <th>ID</th><th>Título</th><th>Categoria</th><th>Impacto</th><th>Incidentes</th><th>RCA</th><th>Status</th>
    </tr></thead><tbody>${rows}</tbody></table></div>
    <div class="section-title">📚 Known Error Database (KEDB)</div>${kedb}`;
}
function postProblemas() {}
async function showProblem(id) {
  const p = (await get('/problems')).find(x => x.id === id);
  openModal(`🧩 ${p.id} — Problema`, detailGrid([
    ['Título', esc(p.title), true], ['Categoria', esc(p.category)], ['Impacto', esc(p.impact)],
    ['Status', statusBadge(p.status)], ['Incidentes vinculados', p.incidents_count],
    ['RCA', p.rca ? esc(p.rca) : 'Em investigação', true], ['Workaround', esc(p.workaround), true]
  ]));
}

async function viewRFCs() {
  const rfcs = await get('/rfcs');
  window._excelRfc = rfcs;
  const rows = rfcs.map(r => `
    <tr onclick="showRFC('${r.id}')">
      <td class="mono">${r.id}</td><td>${esc(r.title)}</td>
      <td>${badge(r.type, r.type === 'Emergencial' ? 'red' : r.type === 'Padrão' ? 'green' : 'blue')}</td>
      <td>${badge(r.risk, r.risk === 'Alto' ? 'red' : r.risk === 'Médio' ? 'amber' : 'green')}</td>
      <td>${esc(r.system)}</td><td class="mono" style="font-size:.7rem">${fmtDateTime(r.window_start)}</td>
      <td style="font-size:.74rem">${esc(r.impact || '').slice(0, 40)}…</td><td>${statusBadge(r.status)}</td></tr>`).join('');
  return `
    <div class="kpi-grid">
      ${kpi('Total RFCs', rfcs.length, 'no pipeline')}
      ${kpi('Emergenciais', rfcs.filter(r => r.type === 'Emergencial').length, '', 'red')}
      ${kpi('Aprovadas CAB', rfcs.filter(r => r.status === 'Aprovada CAB').length, '', 'green')}
      ${kpi('Implementadas', rfcs.filter(r => r.status === 'Implementada').length, '', 'purple')}
    </div>
    <div class="section-title">🔄 RFCs & Mudanças <span class="spacer"></span>
      ${adminOnly(`<button class="btn btn-primary btn-sm" onclick="newRFCForm()">➕ Nova RFC</button>`)}
      ${exportBtn('window._excelRfc', 'rfcs')} ${n8nBtn('sync-mudancas')}
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>ID</th><th>Título</th><th>Tipo</th><th>Risco</th><th>Sistema</th><th>Janela</th><th>Impacto</th><th>Status</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
}
async function showRFC(id) {
  const r = (await get('/rfcs')).find(x => x.id === id);
  openModal(`🔄 ${r.id} — Request for Change`, detailGrid([
    ['Título', esc(r.title), true],
    ['Tipo', badge(r.type, r.type === 'Emergencial' ? 'red' : 'blue')], ['Risco', badge(r.risk, r.risk === 'Alto' ? 'red' : r.risk === 'Médio' ? 'amber' : 'green')],
    ['Sistema', esc(r.system)], ['Status', statusBadge(r.status)],
    ['Janela início', fmtDateTime(r.window_start)], ['Janela fim', fmtDateTime(r.window_end)],
    ['Reunião CAB', fmtDateTime(r.cab_meeting)], ['Gestor da Mudança', esc(r.manager)],
    ['CI Relacionado', `<span class="mono">${esc(r.ci_related)}</span>`], ['Dependências CIs', `<span class="mono">${esc(r.dependencies)}</span>`],
    ['Impacto Operacional', esc(r.impact), true]
  ]) + adminOnly(`
    <div style="margin-top:16px">
      <div class="fld"><label>Atualizar Status</label>
        <select id="rfc_st"><option>Submetida</option><option>Em avaliação</option><option>Aprovada CAB</option><option>Implementada</option><option>Rejeitada</option></select></div>
      <div style="margin-top:10px;display:flex;gap:10px">
        <button class="btn btn-primary btn-sm" onclick="updRFC('${r.id}')">💾 Atualizar RFC</button>
        ${n8nBtn('notificar-cab')}
      </div>
    </div>`));
  const sel = document.getElementById('rfc_st'); if (sel) sel.value = r.status;
}
async function updRFC(id) {
  try {
    await api(`/rfcs/${id}`, { method: 'PUT', body: { status: document.getElementById('rfc_st').value } });
    invalidate('/rfcs'); invalidate('/kpis'); closeModal();
    toast(`${id} atualizada ✓`, 'success');
    navTo(S.currentModule);
  } catch (e) { toast(e.message, 'error'); }
}
function newRFCForm() {
  openModal('➕ Nova RFC', `
    <div class="form-grid">
      <div class="fld full"><label>Título *</label><input id="r_title"></div>
      <div class="fld"><label>Tipo</label><select id="r_type"><option>Normal</option><option>Padrão</option><option>Emergencial</option></select></div>
      <div class="fld"><label>Risco</label><select id="r_risk"><option>Baixo</option><option selected>Médio</option><option>Alto</option></select></div>
      <div class="fld"><label>Sistema</label><input id="r_sys"></div>
      <div class="fld"><label>Gestor</label><input id="r_mgr"></div>
      <div class="fld"><label>Janela início</label><input id="r_ws" type="datetime-local"></div>
      <div class="fld"><label>Janela fim</label><input id="r_we" type="datetime-local"></div>
      <div class="fld full"><label>Impacto operacional</label><textarea id="r_imp" rows="2"></textarea></div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-primary" onclick="createRFC()">Criar RFC</button></div>`);
}
async function createRFC() {
  const v = id => document.getElementById(id).value;
  try {
    const r = await api('/rfcs', { method: 'POST', body: {
      title: v('r_title'), type: v('r_type'), risk: v('r_risk'), system: v('r_sys'), manager: v('r_mgr'),
      window_start: v('r_ws') ? new Date(v('r_ws')).toISOString() : null,
      window_end: v('r_we') ? new Date(v('r_we')).toISOString() : null, impact: v('r_imp') } });
    invalidate('/rfcs'); closeModal(); toast(`${r.id} criada ✓`, 'success'); navTo(S.currentModule);
  } catch (e) { toast(e.message, 'error'); }
}

async function viewCAB() {
  const [meetings, rfcs] = await Promise.all([get('/cab-meetings'), get('/rfcs')]);
  const emerg = rfcs.filter(r => r.type === 'Emergencial');
  const windows = rfcs.filter(r => r.status === 'Aprovada CAB' && new Date(r.window_start) > new Date() &&
    new Date(r.window_start) < new Date(Date.now() + 30 * 86400000));
  return `
    <div class="section-title">📅 Próximas Reuniões CAB</div>
    <div class="grid-3">${meetings.map(m => `
      <div class="card" style="border-left:4px solid var(--blue)">
        <h4>📌 ${fmtDateTime(m.meeting_date)}</h4>
        <p style="font-size:.8rem"><b>Local:</b> ${esc(m.location)}</p>
        <p style="font-size:.8rem;margin-top:6px"><b>RFCs em pauta:</b><br><span class="mono" style="font-size:.74rem">${esc(m.rfcs_list)}</span></p>
        <div style="margin-top:8px">${statusBadge(m.status)}</div>
      </div>`).join('')}</div>
    <div class="section-title">⚡ Mudanças Emergenciais Recentes</div>
    <div class="grid-2">${emerg.map(r => `
      <div class="card" style="border-left:4px solid var(--red)">
        <h4>${r.id} — ${esc(r.title)}</h4>
        <p style="font-size:.8rem">${esc(r.impact)}</p>
        <div style="margin-top:8px">${statusBadge(r.status)} ${badge(r.system, 'gray')}</div>
      </div>`).join('') || '<div class="card">Nenhuma mudança emergencial recente.</div>'}</div>
    <div class="section-title">🗓️ Janelas Aprovadas — Próximos 30 dias</div>
    <div class="table-wrap"><table><thead><tr><th>RFC</th><th>Título</th><th>Sistema</th><th>Início</th><th>Fim</th><th>Risco</th></tr></thead>
    <tbody>${windows.map(r => `<tr onclick="showRFC('${r.id}')"><td class="mono">${r.id}</td><td>${esc(r.title)}</td><td>${esc(r.system)}</td>
      <td class="mono" style="font-size:.72rem">${fmtDateTime(r.window_start)}</td><td class="mono" style="font-size:.72rem">${fmtDateTime(r.window_end)}</td>
      <td>${badge(r.risk, r.risk === 'Alto' ? 'red' : 'amber')}</td></tr>`).join('') || '<tr><td colspan="6">Sem janelas aprovadas no período.</td></tr>'}</tbody></table></div>`;
}

// =====================================================================
// 🔄 MUDANÇAS & CAB (atalho dedicado)
// =====================================================================
RENDERERS.changes = async () => {
  const sub = curSub('changes', 'rfcs');
  const tabs = subtabsHTML('changes', [{ id: 'rfcs', label: '🔄 RFCs' }, { id: 'cab', label: '📅 CAB Calendar' }], sub);
  return tabs + (sub === 'rfcs' ? await viewRFCs() : await viewCAB());
};

// =====================================================================
// 📋 CONTRATOS
// =====================================================================
RENDERERS.contracts = async () => {
  const cons = await get('/contracts');
  window._excelCon = cons;
  const total = cons.reduce((a, c) => a + c.value, 0);
  const expiring = cons.filter(c => new Date(c.end_date) < new Date(Date.now() + 90 * 86400000));
  const rows = cons.map(c => `
    <tr onclick="showContract('${c.id}')">
      <td class="mono">${c.id}</td><td>${esc(c.title)}</td><td>${esc(c.supplier)}</td>
      <td>${badge(c.type, c.type === 'CAPEX' ? 'purple' : 'blue')}</td>
      <td class="mono">${fmtBRL(c.value)}</td><td>${fmtDate(c.end_date)}</td>
      <td>${esc(c.renewal)}</td><td>${statusBadge(c.status)}</td></tr>`).join('');
  return `
    <div class="kpi-grid">
      ${kpi('Contratos', cons.length, 'na carteira')}
      ${kpi('Valor Total', fmtBRLm(total), 'carteira vigente', 'green')}
      ${kpi('CAPEX', cons.filter(c => c.type === 'CAPEX').length, 'contratos', 'purple')}
      ${kpi('OPEX', cons.filter(c => c.type === 'OPEX').length, 'contratos')}
      ${kpi('Vencendo 90d', expiring.length, 'requerem ação', expiring.length ? 'amber' : 'green')}
    </div>
    <div class="section-title">📋 Carteira de Contratos <span class="spacer"></span>
      ${adminOnly(`<button class="btn btn-primary btn-sm" onclick="newContractForm()">➕ Novo Contrato</button>`)}
      ${exportBtn('window._excelCon', 'contratos')} ${n8nBtn('alerta-vencimentos')}
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>ID</th><th>Contrato</th><th>Fornecedor</th><th>Tipo</th><th>Valor</th><th>Vencimento</th><th>Renovação</th><th>Status</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
};
async function showContract(id) {
  const c = (await get('/contracts')).find(x => x.id === id);
  openModal(`📋 ${c.id} — Contrato`, detailGrid([
    ['Título', esc(c.title), true],
    ['Fornecedor', esc(c.supplier)], ['Tipo', badge(c.type, c.type === 'CAPEX' ? 'purple' : 'blue')],
    ['Valor', `<b class="mono">${fmtBRL(c.value)}</b>`], ['Status', statusBadge(c.status)],
    ['Início', fmtDate(c.start_date)], ['Vencimento', fmtDate(c.end_date)],
    ['Renovação', esc(c.renewal)], ['Responsável', esc(c.responsible)],
    ['Escopo', esc(c.scope), true]
  ]) + adminOnly(`
    <div style="margin-top:16px;display:flex;gap:10px">
      <button class="btn btn-primary btn-sm" onclick="editContractForm('${c.id}')">✏️ Editar</button>
      ${n8nBtn('renovacao-contrato')}
    </div>`));
}
async function editContractForm(id) {
  const c = (await get('/contracts')).find(x => x.id === id);
  openModal(`✏️ Editar ${c.id}`, `
    <div class="form-grid">
      <div class="fld full"><label>Título</label><input id="c_title" value="${esc(c.title)}"></div>
      <div class="fld"><label>Valor (R$)</label><input id="c_value" type="number" value="${c.value}"></div>
      <div class="fld"><label>Status</label><select id="c_status"><option>Ativo</option><option>Vencendo</option><option>Em renegociação</option><option>Encerrado</option></select></div>
      <div class="fld"><label>Renovação</label><input id="c_renewal" value="${esc(c.renewal)}"></div>
      <div class="fld"><label>Responsável</label><input id="c_resp" value="${esc(c.responsible)}"></div>
      <div class="fld full"><label>Escopo</label><textarea id="c_scope" rows="2">${esc(c.scope)}</textarea></div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-primary" onclick="saveContract('${c.id}')">💾 Salvar</button></div>`);
  document.getElementById('c_status').value = c.status;
}
async function saveContract(id) {
  const v = x => document.getElementById(x).value;
  try {
    await api(`/contracts/${id}`, { method: 'PUT', body: {
      title: v('c_title'), value: Number(v('c_value')), status: v('c_status'),
      renewal: v('c_renewal'), responsible: v('c_resp'), scope: v('c_scope') } });
    invalidate('/contracts'); invalidate('/kpis'); closeModal();
    toast(`${id} salvo ✓`, 'success'); navTo('contracts');
  } catch (e) { toast(e.message, 'error'); }
}
function newContractForm() {
  openModal('➕ Novo Contrato', `
    <div class="form-grid">
      <div class="fld full"><label>Título *</label><input id="c_title"></div>
      <div class="fld"><label>Fornecedor</label><input id="c_sup"></div>
      <div class="fld"><label>Tipo</label><select id="c_type"><option>OPEX</option><option>CAPEX</option></select></div>
      <div class="fld"><label>Valor (R$)</label><input id="c_value" type="number" value="0"></div>
      <div class="fld"><label>Vencimento</label><input id="c_end" type="date"></div>
      <div class="fld"><label>Renovação</label><input id="c_renewal" value="Negociada"></div>
      <div class="fld"><label>Responsável</label><input id="c_resp"></div>
      <div class="fld full"><label>Escopo</label><textarea id="c_scope" rows="2"></textarea></div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-primary" onclick="createContract()">Criar Contrato</button></div>`);
}
async function createContract() {
  const v = x => document.getElementById(x).value;
  try {
    const r = await api('/contracts', { method: 'POST', body: {
      title: v('c_title'), supplier: v('c_sup'), type: v('c_type'), value: Number(v('c_value')),
      end_date: v('c_end') ? new Date(v('c_end')).toISOString() : null,
      renewal: v('c_renewal'), responsible: v('c_resp'), scope: v('c_scope'), start_date: new Date().toISOString() } });
    invalidate('/contracts'); invalidate('/kpis'); closeModal();
    toast(`Contrato ${r.id} criado ✓`, 'success'); navTo('contracts');
  } catch (e) { toast(e.message, 'error'); }
}

// =====================================================================
// 🤝 FORNECEDORES
// =====================================================================
RENDERERS.suppliers = async () => {
  const sups = await get('/suppliers');
  window._excelSup = sups;
  const totalV = sups.reduce((a, s) => a + s.total_value, 0);
  const slaAvg = (sups.reduce((a, s) => a + s.sla_pct, 0) / sups.length).toFixed(2);
  const rows = sups.map(s => `
    <tr onclick="showSupplier(${s.id})">
      <td><b>${esc(s.name)}</b></td><td>${esc(s.segment)}</td><td>${s.contracts}</td>
      <td class="mono">${fmtBRL(s.total_value)}</td>
      <td><span class="${s.sla_pct >= 99 ? 'cd-ok' : 'cd-warn'} mono">${s.sla_pct}%</span></td>
      <td>${statusBadge(s.status)}</td><td>${s.is_critical ? '🔴 Sim' : '—'}</td></tr>`).join('');
  return `
    <div class="kpi-grid">
      ${kpi('Fornecedores', sups.length, 'ativos na base')}
      ${kpi('Valor Carteira', fmtBRLm(totalV), 'contratos vigentes', 'green')}
      ${kpi('SLA ≥ 99%', sups.filter(s => s.sla_pct >= 99).length, 'fornecedores', 'green')}
      ${kpi('SLA em Risco', sups.filter(s => s.sla_pct < 99).length, '< 99%', 'amber')}
      ${kpi('Contratos Ativos', sups.reduce((a, s) => a + s.contracts, 0), 'total')}
      ${kpi('SLA Médio', slaAvg + '%', 'da carteira', 'purple')}
    </div>
    <div class="grid-2" style="margin:16px 0">
      <div class="card"><h4>Gastos por Fornecedor</h4><div class="chart-box"><canvas id="chSupSpend"></canvas></div></div>
      <div class="card"><h4>SLA % por Fornecedor</h4><div class="chart-box"><canvas id="chSupSla"></canvas></div></div>
    </div>
    <div class="section-title">🤝 Base de Fornecedores <span class="spacer"></span>${exportBtn('window._excelSup', 'fornecedores')} ${n8nBtn('avaliacao-fornecedores')}</div>
    <div class="table-wrap"><table><thead><tr>
      <th>Fornecedor</th><th>Segmento</th><th>Contratos</th><th>Valor</th><th>SLA %</th><th>Status</th><th>Crítico</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
};
POST_RENDER.suppliers = async () => {
  const sups = await get('/suppliers');
  mkChart('chSupSpend', { type: 'bar', data: { labels: sups.map(s => s.name), datasets: [{ data: sups.map(s => s.total_value), backgroundColor: C.blue }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { ticks: { callback: v => (v / 1e6).toFixed(1) + 'M' } } } } });
  mkChart('chSupSla', { type: 'bar', data: { labels: sups.map(s => s.name), datasets: [{ data: sups.map(s => s.sla_pct), backgroundColor: sups.map(s => s.sla_pct >= 99 ? C.green : C.amber) }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { min: 95, max: 100 } } } });
};
async function showSupplier(id) {
  const s = (await get('/suppliers')).find(x => x.id === id);
  const cons = (await get('/contracts')).filter(c => c.supplier === s.name);
  openModal(`🤝 ${esc(s.name)}`, detailGrid([
    ['Segmento', esc(s.segment)], ['Status', statusBadge(s.status)],
    ['Contratos', s.contracts], ['Valor total', `<b class="mono">${fmtBRL(s.total_value)}</b>`],
    ['SLA', `<span class="${s.sla_pct >= 99 ? 'cd-ok' : 'cd-warn'}">${s.sla_pct}%</span>`],
    ['Fornecedor crítico', s.is_critical ? '🔴 Sim' : 'Não'],
    ['Contato', `<span class="mono" style="font-size:.76rem">${esc(s.contact_email)}</span>`, true]
  ]) + `<div class="section-title" style="margin-top:18px">Contratos vigentes</div>` +
    cons.map(c => `<div class="toggle-row" style="cursor:pointer" onclick="showContract('${c.id}')">
      <span class="mono" style="font-size:.72rem">${c.id}</span><span class="tr-label" style="font-size:.78rem">${esc(c.title)}</span>
      <span class="mono" style="font-size:.74rem">${fmtBRL(c.value)}</span></div>`).join(''));
}

// =====================================================================
// 💰 BUDGET
// =====================================================================
RENDERERS.budget = async () => {
  const [b, cons] = await Promise.all([get('/budget'), get('/contracts')]);
  window._excelBud = b.entries; window._excelCon = cons;
  const capex = b.totals.find(t => t.category === 'CAPEX') || { planned: 0, realized: 0 };
  const opex = b.totals.find(t => t.category === 'OPEX') || { planned: 0, realized: 0 };
  const annual = capex.planned + opex.planned, realized = capex.realized + opex.realized;
  const curM = new Date().getMonth() + 1;
  const thisMonth = b.by_month.find(m => m.month === curM) || { realized: 0 };
  const monthsLeft = 12 - curM;
  const avgMonthly = realized / curM;
  const forecast = realized + avgMonthly * monthsLeft;
  const deviation = ((forecast - annual) / annual * 100).toFixed(1);
  const rows = cons.map(c => `
    <tr onclick="showContract('${c.id}')"><td class="mono">${c.id}</td><td>${esc(c.title)}</td>
    <td>${badge(c.type, c.type === 'CAPEX' ? 'purple' : 'blue')}</td><td class="mono">${fmtBRL(c.value)}</td>
    <td>${esc(c.supplier)}</td><td>${statusBadge(c.status)}</td></tr>`).join('');
  return `
    <div class="kpi-grid">
      ${kpi('Budget Anual', fmtBRLm(annual), `ano ${b.year}`, 'green')}
      ${kpi('CAPEX', fmtBRLm(capex.planned), `realizado ${fmtBRLm(capex.realized)}`, 'purple')}
      ${kpi('OPEX', fmtBRLm(opex.planned), `realizado ${fmtBRLm(opex.realized)}`)}
      ${kpi('Realizado no Mês', fmtBRLm(thisMonth.realized), MONTHS[curM - 1], 'amber')}
      ${kpi('Saldo', fmtBRLm(annual - realized), 'disponível no ano', 'green')}
      ${kpi('Forecast', fmtBRLm(forecast), `desvio ${deviation > 0 ? '+' : ''}${deviation}%`, Math.abs(deviation) > 5 ? 'red' : 'green')}
    </div>
    <div class="grid-2" style="margin:16px 0">
      <div class="card"><h4>CAPEX × OPEX</h4><div class="chart-box"><canvas id="chCapexOpex"></canvas></div></div>
      <div class="card"><h4>Execução Mensal Jan–Dez</h4><div class="chart-box"><canvas id="chMonthly"></canvas></div></div>
      <div class="card"><h4>Budget por Torre de TI</h4><div class="chart-box"><canvas id="chTowers"></canvas></div></div>
      <div class="card"><h4>📊 Painel Forecast</h4>
        ${barRow('Execução do ano', Math.round(realized / annual * 100), C.blue)}
        ${barRow('Projeção fim do ano', Math.min(Math.round(forecast / annual * 100), 100), Math.abs(deviation) > 5 ? C.red : C.green, Math.round(forecast / annual * 100) + '%')}
        <p style="font-size:.8rem;color:var(--text-2);margin-top:10px">Forecast linear sobre a média mensal realizada (${fmtBRLm(avgMonthly)}/mês).
        Desvio projetado de <b>${deviation}%</b> sobre o budget aprovado.</p>
        ${n8nBtn('relatorio-budget', '⚡ Relatório Budget via N8N')}
      </div>
    </div>
    <div class="section-title">📑 Contratos CAPEX/OPEX <span class="spacer"></span>${exportBtn('window._excelBud', 'budget')} </div>
    <div class="table-wrap"><table><thead><tr><th>ID</th><th>Contrato</th><th>Tipo</th><th>Valor</th><th>Fornecedor</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
};
POST_RENDER.budget = async () => {
  const b = await get('/budget');
  const capex = b.totals.find(t => t.category === 'CAPEX') || {}, opex = b.totals.find(t => t.category === 'OPEX') || {};
  mkChart('chCapexOpex', { type: 'doughnut', data: { labels: ['CAPEX', 'OPEX'], datasets: [{ data: [capex.planned, opex.planned], backgroundColor: [C.purple, C.blue] }] }, options: { maintainAspectRatio: false, cutout: '62%' } });
  mkChart('chMonthly', { type: 'bar', data: { labels: MONTHS, datasets: [
    { label: 'Planejado', data: b.by_month.map(m => m.planned), backgroundColor: 'rgba(30,80,160,.25)' },
    { label: 'Realizado', data: b.by_month.map(m => m.realized), backgroundColor: C.green }
  ] }, options: { maintainAspectRatio: false, scales: { y: { ticks: { callback: v => (v / 1e6).toFixed(1) + 'M' } } } } });
  mkChart('chTowers', { type: 'bar', data: { labels: b.by_tower.map(t => t.tower), datasets: [{ data: b.by_tower.map(t => t.planned), backgroundColor: [C.blue, C.blueLight, C.purple, C.green, C.amber, C.gray] }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { ticks: { callback: v => (v / 1e6).toFixed(1) + 'M' } } } } });
};

// =====================================================================
// 📈 FINOPS
// =====================================================================
RENDERERS.finops = async () => {
  const b = await get('/budget');
  const towers = b.by_tower.map(t => ({ ...t, var_pct: t.planned ? Math.round((t.realized / (t.planned * (new Date().getMonth() + 1) / 12) - 1) * 100) : 0 }));
  const cloud = b.by_tower.find(t => t.tower === 'Cloud') || { planned: 0, realized: 0 };
  return `
    <div class="kpi-grid">
      ${kpi('Gasto Cloud YTD', fmtBRLm(cloud.realized), 'torre Cloud', 'purple')}
      ${kpi('Maior Desvio', (towers.sort((a, b2) => Math.abs(b2.var_pct) - Math.abs(a.var_pct))[0] || {}).tower || '—', 'torre com variação', 'amber')}
      ${kpi('Torres Monitoradas', towers.length, 'com tagging ativo')}
      ${kpi('Economia Potencial', fmtBRLm(cloud.realized * 0.12), 'rightsizing estimado', 'green')}
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="card"><h4>Variação Realizado × Planejado (pró-rata) por Torre</h4>
        ${towers.map(t => barRow(t.tower, Math.min(Math.abs(t.var_pct) * 2, 100), t.var_pct > 5 ? C.red : t.var_pct < -5 ? C.green : C.blue, (t.var_pct > 0 ? '+' : '') + t.var_pct + '%')).join('')}
      </div>
      <div class="card"><h4>💡 Recomendações FinOps</h4>
        <div class="alert-item a-warning"><span>💰</span><div>Reservar instâncias Azure para a torre Cloud — economia estimada de 12% no compute.</div></div>
        <div class="alert-item a-info"><span>🏷️</span><div>3 subscriptions sem tagging completo de centro de custo — bloquear novos deploys sem tag.</div></div>
        <div class="alert-item a-info"><span>📉</span><div>Storage tier frio para backups com mais de 90 dias reduz ~R$ 8k/mês.</div></div>
        ${n8nBtn('relatorio-finops', '⚡ Relatório FinOps via N8N')}
      </div>
    </div>`;
};

// =====================================================================
// 🔥 RISCOS
// =====================================================================
RENDERERS.risks = async () => {
  const risks = await get('/risks');
  window._excelRisk = risks;
  const crit = risks.filter(r => r.probability * r.impact >= 15);
  const high = risks.filter(r => { const s = r.probability * r.impact; return s >= 9 && s < 15; });
  const kriAvg = Math.round(risks.reduce((a, r) => a + r.kri_score, 0) / risks.length);
  // matriz 5x5
  let matrix = '<div class="risk-matrix">';
  for (let imp = 5; imp >= 1; imp--) {
    matrix += `<div class="rm-axis">I${imp}</div>`;
    for (let prob = 1; prob <= 5; prob++) {
      const score = prob * imp;
      const cls = score >= 15 ? 'rm-crit' : score >= 9 ? 'rm-high' : score >= 4 ? 'rm-med' : 'rm-low';
      const cell = risks.filter(r => r.probability === prob && r.impact === imp)
        .map(r => `<span class="rm-badge" onclick="showRisk(${r.id})">${r.code}</span>`).join('');
      matrix += `<div class="rm-cell ${cls}">${cell}</div>`;
    }
  }
  matrix += '<div></div>' + [1, 2, 3, 4, 5].map(p => `<div class="rm-axis">P${p}</div>`).join('') + '</div>';
  const rows = risks.map(r => `
    <tr onclick="showRisk(${r.id})">
      <td class="mono">${r.code}</td><td>${esc(r.description)}</td><td>${esc(r.category)}</td>
      <td>${r.probability}</td><td>${r.impact}</td>
      <td><span class="mono ${r.kri_score >= 70 ? 'cd-crit' : r.kri_score >= 50 ? 'cd-warn' : 'cd-ok'}">${r.kri_score}</span></td>
      <td>${statusBadge(r.status)}</td><td style="font-size:.72rem">${esc(r.mitigation_plan || '').slice(0, 50)}…</td></tr>`).join('');
  return `
    <div class="kpi-grid">
      ${kpi('Riscos Críticos', crit.length, 'P×I ≥ 15', 'red')}
      ${kpi('Riscos Altos', high.length, 'P×I 9–14', 'amber')}
      ${kpi('KRI Score Médio', kriAvg + '/100', 'indicadores-chave', kriAvg >= 70 ? 'red' : 'amber')}
      ${kpi('Mitigações Ativas', risks.filter(r => r.status === 'Mitigando').length, 'em andamento', 'blue')}
      ${kpi('Riscos IA', risks.filter(r => r.category === 'IA').length, 'categoria IA', 'purple')}
      ${kpi('Apetite de Risco', 'Moderado', 'definido pelo comitê', 'green')}
    </div>
    <div class="grid-2" style="margin:16px 0">
      <div class="card"><h4>Matriz Probabilidade × Impacto</h4>${matrix}
        <p style="font-size:.7rem;color:var(--text-2);margin-top:8px">Eixo horizontal: Probabilidade (P1–P5) · Eixo vertical: Impacto (I1–I5). Clique no badge para detalhe.</p></div>
      <div class="card"><h4>KRIs — Key Risk Indicators</h4>
        ${risks.map(r => barRow(`${r.code} · ${r.category}`, r.kri_score, r.kri_score >= 70 ? C.red : r.kri_score >= 50 ? C.amber : C.green, r.kri_score + '/100')).join('')}
      </div>
    </div>
    <div class="section-title">🔥 Registro de Riscos <span class="spacer"></span>
      ${adminOnly(`<button class="btn btn-primary btn-sm" onclick="newRiskForm()">➕ Novo Risco</button>`)}
      ${exportBtn('window._excelRisk', 'riscos')} ${n8nBtn('reporte-riscos')}
    </div>
    <div class="table-wrap"><table><thead><tr>
      <th>ID</th><th>Risco</th><th>Categoria</th><th>Prob.</th><th>Impacto</th><th>KRI</th><th>Status</th><th>Plano de Mitigação</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
};
async function showRisk(id) {
  const r = (await get('/risks')).find(x => x.id === id);
  const score = r.probability * r.impact;
  openModal(`🔥 ${r.code} — Risco`, detailGrid([
    ['Descrição', esc(r.description), true],
    ['Categoria', esc(r.category)], ['Status', statusBadge(r.status)],
    ['Probabilidade', r.probability + '/5'], ['Impacto', r.impact + '/5'],
    ['Severidade (P×I)', badge(score >= 15 ? `${score} — Crítico` : score >= 9 ? `${score} — Alto` : `${score} — Moderado`, score >= 15 ? 'red' : score >= 9 ? 'amber' : 'green')],
    ['KRI Score', `<b class="mono">${r.kri_score}/100</b>`],
    ['Plano de Mitigação', esc(r.mitigation_plan), true]
  ]));
}
function newRiskForm() {
  openModal('➕ Novo Risco', `
    <div class="form-grid">
      <div class="fld full"><label>Descrição *</label><input id="rk_desc"></div>
      <div class="fld"><label>Categoria</label><select id="rk_cat"><option>Segurança</option><option>Continuidade</option><option>Financeiro</option><option>Fornecedores</option><option>IA</option><option>Tecnologia</option></select></div>
      <div class="fld"><label>Status</label><select id="rk_st"><option>Ativo</option><option>Mitigando</option><option>Aceito</option></select></div>
      <div class="fld"><label>Probabilidade (1–5)</label><input id="rk_p" type="number" min="1" max="5" value="3"></div>
      <div class="fld"><label>Impacto (1–5)</label><input id="rk_i" type="number" min="1" max="5" value="3"></div>
      <div class="fld"><label>KRI Score (0–100)</label><input id="rk_kri" type="number" min="0" max="100" value="50"></div>
      <div class="fld full"><label>Plano de mitigação</label><textarea id="rk_plan" rows="2"></textarea></div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-primary" onclick="createRisk()">Registrar Risco</button></div>`);
}
async function createRisk() {
  const v = x => document.getElementById(x).value;
  try {
    const r = await api('/risks', { method: 'POST', body: {
      description: v('rk_desc'), category: v('rk_cat'), status: v('rk_st'),
      probability: Number(v('rk_p')), impact: Number(v('rk_i')), kri_score: Number(v('rk_kri')), mitigation_plan: v('rk_plan') } });
    invalidate('/risks'); invalidate('/kpis'); closeModal();
    toast(`Risco ${r.code} registrado ✓`, 'success'); navTo('risks');
  } catch (e) { toast(e.message, 'error'); }
}

// =====================================================================
// ✅ COMPLIANCE
// =====================================================================
RENDERERS.compliance = async () => {
  const audit = await get('/audit');
  const fw = audit.by_framework;
  return `
    <div class="kpi-grid">
      ${fw.map(f => kpi(f.framework, Math.round(f.valid / f.total * 100) + '%', `${f.valid}/${f.total} evidências válidas`, f.valid / f.total >= .8 ? 'green' : 'amber')).join('')}
    </div>
    <div class="grid-2" style="margin-top:16px">
      <div class="card"><h4>Aderência por Framework</h4><div class="chart-box"><canvas id="chCompFw"></canvas></div></div>
      <div class="card"><h4>📌 Pendências de Conformidade</h4>
        ${audit.actions.filter(a => a.status !== 'Concluído').map(a => `
          <div class="alert-item ${a.status === 'Atrasado' ? 'a-critical' : 'a-warning'}"><span>${a.status === 'Atrasado' ? '🔴' : '🟡'}</span>
            <div><div>${esc(a.gap)}</div><div class="alert-time">${a.framework} · prazo ${fmtDate(a.deadline)} · ${a.completion_pct}% concluído</div></div></div>`).join('')}
        <button class="btn btn-secondary btn-sm" onclick="navToModule('audit')">Abrir Auditoria & Evidências →</button>
      </div>
    </div>`;
};
POST_RENDER.compliance = async () => {
  const audit = await get('/audit');
  mkChart('chCompFw', { type: 'bar', data: { labels: audit.by_framework.map(f => f.framework),
    datasets: [
      { label: 'Válidas', data: audit.by_framework.map(f => f.valid), backgroundColor: C.green },
      { label: 'Vencendo', data: audit.by_framework.map(f => f.expiring), backgroundColor: C.amber },
      { label: 'Vencidas', data: audit.by_framework.map(f => f.expired), backgroundColor: C.red }
    ] }, options: { maintainAspectRatio: false, scales: { x: { stacked: true }, y: { stacked: true } } } });
};

// =====================================================================
// 🔐 SEGURANÇA & IAM
// =====================================================================
RENDERERS.security = async () => {
  const sec = await get('/security');
  window._excelVuln = sec.vulnerabilities;
  const mfaPct = Math.round(sec.pam_accounts.filter(p => p.mfa).length / sec.pam_accounts.length * 100);
  const rowsV = sec.vulnerabilities.map(v => `
    <tr><td class="mono">${v.id}</td><td>${esc(v.asset)}</td>
      <td><span class="mono ${v.cvss >= 9 ? 'cd-crit' : v.cvss >= 7 ? 'cd-warn' : 'cd-ok'}">${v.cvss}</span></td>
      <td>${badge(v.severity, v.severity === 'Crítica' ? 'red' : v.severity === 'Alta' ? 'amber' : 'blue')}</td>
      <td>${statusBadge(v.status)}</td><td>${fmtDate(v.deadline)}</td></tr>`).join('');
  const rowsP = sec.pam_accounts.map(p => `
    <tr><td class="mono">${esc(p.username)}</td><td>${esc(p.profile)}</td><td>${esc(p.system)}</td>
      <td>${fmtDateTime(p.last_login)}</td>
      <td>${p.mfa ? badge('MFA ✓', 'green') : badge('SEM MFA', 'red')}</td>
      <td>${badge(p.rotation_days + ' dias', p.rotation_days > 90 ? 'red' : p.rotation_days > 30 ? 'amber' : 'green')}</td></tr>`).join('');
  return `
    <div class="kpi-grid">
      ${kpi('MFA Cobertura', mfaPct + '%', 'contas privilegiadas', mfaPct === 100 ? 'green' : 'amber')}
      ${kpi('Contas PAM', sec.pam_accounts.length, 'críticas gerenciadas', 'purple')}
      ${kpi('Vulns Críticas', sec.vulnerabilities.filter(v => v.severity === 'Crítica').length, 'CVSS ≥ 9 abertas', 'red')}
      ${kpi('Zero Trust Score', '78%', 'maturidade ZTNA', 'blue')}
      ${kpi('Eventos SIEM/24h', '14.2K', 'correlacionados', 'amber')}
      ${kpi('ISO 27001', '86%', 'controles aderentes', 'green')}
    </div>
    <div class="section-title">🛡️ Vulnerabilidades (CVEs) <span class="spacer"></span>${exportBtn('window._excelVuln', 'vulnerabilidades')} ${n8nBtn('scan-vulnerabilidades')}</div>
    <div class="table-wrap"><table><thead><tr><th>CVE</th><th>Ativo</th><th>CVSS</th><th>Severidade</th><th>Status</th><th>Prazo</th></tr></thead>
    <tbody>${rowsV}</tbody></table></div>
    <div class="section-title">🔑 Contas Privilegiadas (PAM)</div>
    <div class="table-wrap"><table><thead><tr><th>Usuário</th><th>Perfil</th><th>Sistema</th><th>Último Login</th><th>MFA</th><th>Rotação</th></tr></thead>
    <tbody>${rowsP}</tbody></table></div>
    <div class="grid-2" style="margin-top:16px">
      <div class="card"><h4>Postura de Identidade</h4>
        ${barRow('MFA habilitado', mfaPct, C.green)}
        ${barRow('Sem MFA', 100 - mfaPct, C.red)}
        ${barRow('Zero Trust', 78, C.blue)}
        ${barRow('PAM com rotação em dia', Math.round(sec.pam_accounts.filter(p => p.rotation_days <= 30).length / sec.pam_accounts.length * 100), C.purple)}
        ${barRow('Identidades gerenciadas (IGA)', 91, C.blueLight)}
      </div>
      <div class="card"><h4>Incidentes de Segurança — 6 meses</h4><div class="chart-box"><canvas id="chSecInc"></canvas></div></div>
    </div>`;
};
POST_RENDER.security = () => {
  const nowM = new Date().getMonth();
  const labels = []; for (let i = 5; i >= 0; i--) labels.push(MONTHS[(nowM - i + 12) % 12]);
  mkChart('chSecInc', { type: 'line', data: { labels, datasets: [{ label: 'Incidentes', data: [9, 6, 11, 7, 5, 8], borderColor: C.red, backgroundColor: 'rgba(197,48,48,.08)', fill: true, tension: .35 }] },
    options: { maintainAspectRatio: false, plugins: { legend: { display: false } } } });
};

// =====================================================================
// 🤖 GOV. IA (5 sub-abas)
// =====================================================================
RENDERERS.ai = async () => {
  const models = await get('/ai-models');
  const sub = curSub('ai', 'copilot');
  const prod = models.filter(m => m.status === 'Produção');
  const tokens = models.reduce((a, m) => a + m.tokens_month, 0);
  const lgpdPct = Math.round(models.filter(m => m.lgpd_ok).length / models.length * 100);
  const kpis = `<div class="kpi-grid">
    ${kpi('Modelos em Produção', prod.length, `${models.length} no portfólio`, 'purple')}
    ${kpi('Score ISO 42001', '74/100', 'gestão de IA', 'amber')}
    ${kpi('Riscos Altos IA', models.filter(m => m.risk_level === 'Alto').length, 'sob avaliação', 'red')}
    ${kpi('LGPD', lgpdPct + '%', 'modelos conformes', 'green')}
    ${kpi('Tokens/mês', (tokens / 1e6).toFixed(1) + 'M', 'consumo agregado')}
    ${kpi('Aprovação Ética', Math.round(models.filter(m => m.ethics_approved).length / models.length * 100) + '%', 'comitê de IA', 'green')}
  </div>`;
  const tabs = subtabsHTML('ai', [
    { id: 'copilot', label: '💬 Copilot IA' }, { id: 'modelos', label: '🧠 Modelos' },
    { id: 'iso', label: '📐 ISO 42001' }, { id: 'riscosia', label: '🔥 Riscos IA' }, { id: 'consumo', label: '📊 Consumo' }
  ], sub);
  let body = '';
  if (sub === 'copilot') body = viewCopilot();
  else if (sub === 'modelos') body = `
    <div class="table-wrap"><table><thead><tr><th>Modelo</th><th>Tipo</th><th>Status</th><th>Risco</th><th>Tokens/mês</th><th>LGPD</th><th>Ética</th></tr></thead>
    <tbody>${models.map(m => `<tr><td><b>${esc(m.name)}</b></td><td>${esc(m.type)}</td><td>${statusBadge(m.status)}</td>
      <td>${badge(m.risk_level, m.risk_level === 'Alto' ? 'red' : m.risk_level === 'Médio' ? 'amber' : 'green')}</td>
      <td class="mono">${m.tokens_month ? (m.tokens_month / 1e6).toFixed(1) + 'M' : '—'}</td>
      <td>${m.lgpd_ok ? '✅' : '⚠️'}</td><td>${m.ethics_approved ? '✅' : '⏳'}</td></tr>`).join('')}</tbody></table></div>`;
  else if (sub === 'iso') body = `
    <div class="grid-2"><div class="card"><h4>Domínios ISO/IEC 42001</h4>
      ${barRow('4. Contexto da organização', 85, C.green)}${barRow('5. Liderança', 80, C.green)}
      ${barRow('6. Planejamento', 72, C.amber)}${barRow('7. Suporte', 70, C.amber)}
      ${barRow('8. Operação de IA', 65, C.amber)}${barRow('9. Avaliação de desempenho', 68, C.amber)}
      ${barRow('10. Melhoria', 78, C.green)}</div>
    <div class="card"><h4>📋 Plano de Certificação</h4>
      <div class="alert-item a-info"><span>📌</span><div>Gap assessment concluído — 18 não conformidades menores mapeadas.</div></div>
      <div class="alert-item a-warning"><span>🟡</span><div>Trilha de auditoria de modelos produtivos pendente (plano de ação em curso).</div></div>
      <div class="alert-item a-info"><span>🎯</span><div>Auditoria de certificação prevista para Q4 2026.</div></div>
      ${n8nBtn('relatorio-iso42001', '⚡ Relatório ISO 42001 via N8N')}</div></div>`;
  else if (sub === 'riscosia') {
    const risks = await get('/risks');
    const ai = risks.filter(r => r.category === 'IA');
    body = `<div class="grid-2">
      <div class="card"><h4>Riscos de IA Registrados</h4>
        ${ai.map(r => `<div class="alert-item a-critical"><span>🔥</span><div><b>${r.code}</b> — ${esc(r.description)}<div class="alert-time">KRI ${r.kri_score}/100 · ${r.status}</div></div></div>`).join('') || 'Nenhum risco de IA registrado.'}
        <button class="btn btn-secondary btn-sm" onclick="navToModule('risks')">Abrir Registro de Riscos →</button></div>
      <div class="card"><h4>Controles de IA Ativos</h4>
        <div class="toggle-row"><span>🛡️</span><span class="tr-label">Gateway corporativo de LLM com DLP</span>${badge('Ativo', 'green')}</div>
        <div class="toggle-row"><span>📋</span><span class="tr-label">Avaliação de risco LGPD por modelo</span>${badge('88%', 'amber')}</div>
        <div class="toggle-row"><span>👥</span><span class="tr-label">Comitê de ética — revisão obrigatória</span>${badge('Ativo', 'green')}</div>
        <div class="toggle-row"><span>📊</span><span class="tr-label">Monitoramento de drift em produção</span>${badge('Parcial', 'amber')}</div></div></div>`;
  } else body = `
    <div class="grid-2"><div class="card"><h4>Consumo de Tokens por Modelo</h4><div class="chart-box"><canvas id="chTokens"></canvas></div></div>
    <div class="card"><h4>💰 Custo Estimado</h4>
      ${models.filter(m => m.tokens_month).map(m => barRow(m.name, Math.round(m.tokens_month / tokens * 100), C.purple, (m.tokens_month / 1e6).toFixed(1) + 'M tk')).join('')}
      <p style="font-size:.8rem;color:var(--text-2);margin-top:8px">Consumo agregado: <b>${(tokens / 1e6).toFixed(1)}M tokens/mês</b>. Rateio por centro de custo via tagging FinOps.</p></div></div>`;
  return kpis + tabs + body;
};
POST_RENDER.ai = async () => {
  if (curSub('ai', 'copilot') !== 'consumo') return;
  const models = (await get('/ai-models')).filter(m => m.tokens_month);
  mkChart('chTokens', { type: 'bar', data: { labels: models.map(m => m.name), datasets: [{ data: models.map(m => m.tokens_month / 1e6), backgroundColor: C.purple }] },
    options: { indexAxis: 'y', maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { title: { display: true, text: 'Milhões de tokens' } } } } });
};

// ---- Copilot IA (respostas baseadas nos dados reais da API) ----
function viewCopilot() {
  const chips = [
    'Resumo executivo de hoje', 'Quais incidentes P1 estão abertos?', 'Como está o budget do ano?',
    'Riscos críticos atuais', 'Status dos OKRs do ciclo', 'Contratos vencendo em 90 dias',
    'Postura de segurança', 'SLA está saudável?'
  ];
  return `
    <div class="copilot-box">
      <div class="card" style="display:flex;align-items:center;gap:12px">
        <div class="logo" style="width:40px;height:40px;font-size:1.1rem">🤖</div>
        <div><b>Copilot de Governança</b><div style="font-size:.74rem;color:var(--text-2)">Analisa os dados reais do portal via API</div></div>
        <span class="live-badge" style="margin-left:auto"><span class="live-dot"></span>Online</span>
      </div>
      <div class="chips">${chips.map(c => `<span class="chip" onclick="askCopilot('${c.replace(/'/g, "\\'")}')">${c}</span>`).join('')}</div>
      <div id="copilotAnswers"></div>
      <div class="copilot-input-row">
        <input id="copilotInput" placeholder="Pergunte sobre incidentes, budget, riscos, OKRs, contratos…" onkeydown="if(event.key==='Enter')askCopilot(this.value)">
        <button class="btn btn-primary" onclick="askCopilot(document.getElementById('copilotInput').value)">Perguntar</button>
      </div>
    </div>`;
}
async function askCopilot(q) {
  if (!q || !q.trim()) return;
  const box = document.getElementById('copilotAnswers');
  box.insertAdjacentHTML('afterbegin', `<div class="copilot-answer"><h5>⏳ Analisando: "${esc(q)}"</h5></div>`);
  const [k, incidents, risks, okrs, contracts] = await Promise.all([
    get('/kpis'), get('/incidents'), get('/risks'), get('/okrs'), get('/contracts')]);
  const ql = q.toLowerCase();
  let title = '💡 Análise do Copilot', html = '';
  if (ql.includes('p1') || ql.includes('incidente')) {
    const p1 = incidents.filter(i => i.priority === 'P1' && i.status !== 'Resolvido');
    title = '🚨 Incidentes P1 Abertos';
    html = p1.length ? `<ul>${p1.map(i => `<li><b>${i.id}</b> — ${esc(i.title)} · ${esc(i.assignee)} · SLA ${slaCountdown(i.created_at, i.sla_limit)}</li>`).join('')}</ul>
      <p>Recomendação: acionar war-room se algum SLA entrar na faixa crítica (&lt;10%).</p>` : '<p>✅ Nenhum P1 aberto neste momento.</p>';
  } else if (ql.includes('budget') || ql.includes('orçamento') || ql.includes('orcamento')) {
    title = '💰 Situação do Budget';
    const pct = Math.round(k.budget_realized / k.budget_annual * 100);
    html = `<p>Budget anual de <b>${fmtBRLm(k.budget_annual)}</b> com <b>${fmtBRLm(k.budget_realized)}</b> realizado (${pct}%).</p>
      <ul><li>Carteira de contratos: ${fmtBRLm(k.contracts_value)} em ${k.contracts_active} contratos ativos</li>
      <li>Execução ${pct > (new Date().getMonth() + 1) / 12 * 100 ? 'acima' : 'dentro'} do pró-rata esperado para o mês</li></ul>`;
  } else if (ql.includes('risco')) {
    const crit = risks.filter(r => r.probability * r.impact >= 15);
    title = '🔥 Riscos Críticos';
    html = `<ul>${crit.map(r => `<li><b>${r.code}</b> — ${esc(r.description)} (KRI ${r.kri_score}/100, ${r.status})</li>`).join('')}</ul>
      <p>${risks.filter(r => r.status === 'Mitigando').length} mitigações em andamento no registro.</p>`;
  } else if (ql.includes('okr')) {
    title = '🎯 Status dos OKRs';
    html = `<ul>${okrs.map(o => `<li><b>${esc(o.title)}</b>: ${o.current_pct}% · ${o.key_results.length} KRs (${esc(o.area)})</li>`).join('')}</ul>
      <p>Média do ciclo: <b>${k.okr_avg_pct}%</b>. ${okrs.some(o => o.current_pct < 40) ? '⚠️ Há OKR abaixo de 40% — revisar no checkpoint.' : 'Nenhum OKR em zona crítica.'}</p>`;
  } else if (ql.includes('contrato') || ql.includes('vencendo')) {
    const exp = contracts.filter(c => new Date(c.end_date) < new Date(Date.now() + 90 * 86400000));
    title = '📋 Contratos Vencendo (90 dias)';
    html = exp.length ? `<ul>${exp.map(c => `<li><b>${c.id}</b> — ${esc(c.title)} · vence ${fmtDate(c.end_date)} · ${fmtBRL(c.value)} (${esc(c.renewal)})</li>`).join('')}</ul>` : '<p>✅ Nenhum contrato vence nos próximos 90 dias.</p>';
  } else if (ql.includes('segurança') || ql.includes('seguranca') || ql.includes('vuln')) {
    title = '🔐 Postura de Segurança';
    html = `<ul><li>Vulnerabilidades críticas abertas: <b>${k.vulns_critical}</b></li>
      <li>Conformidade média de evidências: ${k.compliance_pct}%</li>
      <li>Modelos de IA em produção monitorados: ${k.ai_models_prod}</li></ul>
      <p>Prioridade: corrigir CVEs com CVSS ≥ 9 dentro do prazo regulatório.</p>`;
  } else if (ql.includes('sla')) {
    title = '⏱️ Saúde do SLA';
    html = `<p>SLA histórico em <b>${k.sla_pct}%</b> de cumprimento, com ${k.incidents_open} chamados ativos.</p>
      <p>${k.sla_pct >= 95 ? '✅ Acima da meta de 95%.' : '⚠️ Abaixo da meta de 95% — revisar ranking de equipes no SLA Monitor.'}</p>`;
  } else {
    title = '📊 Resumo Executivo';
    html = `<ul>
      <li>🚨 Incidentes: ${k.incidents_open} ativos (${k.incidents_p1_open} P1) · SLA ${k.sla_pct}%</li>
      <li>💰 Budget: ${fmtBRLm(k.budget_annual)} · realizado ${fmtBRLm(k.budget_realized)}</li>
      <li>📋 Contratos: ${k.contracts_active} ativos (${fmtBRLm(k.contracts_value)})</li>
      <li>🔥 Riscos críticos: ${k.risks_critical} · Vulns críticas: ${k.vulns_critical}</li>
      <li>🎯 OKRs do ciclo: ${k.okr_avg_pct}% · Conformidade: ${k.compliance_pct}%</li></ul>`;
  }
  box.firstElementChild.outerHTML = `<div class="copilot-answer"><h5>${title}</h5>${html}
    <div class="alert-time" style="margin-top:6px">Gerado em ${new Date().toLocaleTimeString('pt-BR')} com dados da API</div></div>`;
  const inp = document.getElementById('copilotInput'); if (inp) inp.value = '';
}

// =====================================================================
// Módulos executivos compactos: PMO, CMDB, Ativos, Continuidade, ITOM, Mapeamento
// =====================================================================
RENDERERS.pmo = async () => {
  const projs = [
    ['PRJ-01', 'Migração Datacenter → Equinix SP4', 'Roberto Tanaka', 72, 'Verde'],
    ['PRJ-02', 'Implantação Zero Trust (fase 2)', 'Pedro Alves', 45, 'Amarelo'],
    ['PRJ-03', 'Rollout S/4HANA — ondas 3 e 4', 'Fernanda Dias', 58, 'Verde'],
    ['PRJ-04', 'Decomissionamento AS/400', 'Aline Castro', 30, 'Vermelho'],
    ['PRJ-05', 'Plataforma de IA corporativa', 'Mariana Costa', 64, 'Verde']
  ];
  return `
    <div class="kpi-grid">
      ${kpi('Projetos Ativos', projs.length, 'no portfólio')}
      ${kpi('No Prazo', projs.filter(p => p[4] === 'Verde').length, 'farol verde', 'green')}
      ${kpi('Em Atenção', projs.filter(p => p[4] === 'Amarelo').length, 'farol amarelo', 'amber')}
      ${kpi('Críticos', projs.filter(p => p[4] === 'Vermelho').length, 'farol vermelho', 'red')}
    </div>
    <div class="section-title">🚀 Portfólio de Projetos ${n8nBtn('status-report-pmo')}</div>
    <div class="card">${projs.map(p => barRow(`${p[0]} · ${p[1]} — ${p[2]}`, p[3], p[4] === 'Verde' ? C.green : p[4] === 'Amarelo' ? C.amber : C.red)).join('')}</div>`;
};

RENDERERS.cmdb = async () => {
  const cis = [
    ['CI-VMW-CL01', 'Cluster VMware Produção', 'Virtualização', 'Crítico', 'CI-SAN-01, CI-NET-CORE'],
    ['CI-SAN-01', 'Storage SAN FlashSystem', 'Storage', 'Crítico', 'CI-NET-CORE'],
    ['CI-EXC-01', 'Exchange Server', 'E-mail', 'Alto', 'CI-AD-01'],
    ['CI-AD-01', 'Active Directory', 'Identidade', 'Crítico', '—'],
    ['CI-NET-CORE', 'Switches Core', 'Rede', 'Crítico', '—'],
    ['CI-ERP-INT', 'Integrações ERP', 'Aplicação', 'Alto', 'CI-AS400, CI-N8N-01'],
    ['CI-N8N-01', 'Servidor N8N', 'Integrações', 'Médio', 'CI-VMW-CL01']
  ];
  return `
    <div class="kpi-grid">${kpi('CIs Registrados', '1.284', 'no CMDB')}${kpi('CIs Críticos', cis.filter(c => c[3] === 'Crítico').length, 'tier 1', 'red')}${kpi('Cobertura Discovery', '94%', 'auto-descoberta', 'green')}${kpi('Relações Mapeadas', '3.420', 'dependências')}</div>
    <div class="section-title">🧩 Itens de Configuração — Tier 1</div>
    <div class="table-wrap"><table><thead><tr><th>CI</th><th>Nome</th><th>Classe</th><th>Criticidade</th><th>Dependências</th></tr></thead>
    <tbody>${cis.map(c => `<tr><td class="mono">${c[0]}</td><td>${c[1]}</td><td>${c[2]}</td>
      <td>${badge(c[3], c[3] === 'Crítico' ? 'red' : c[3] === 'Alto' ? 'amber' : 'blue')}</td><td class="mono" style="font-size:.7rem">${c[4]}</td></tr>`).join('')}</tbody></table></div>`;
};

RENDERERS.assets = async () => `
  <div class="kpi-grid">
    ${kpi('Ativos Inventariados', '1.284', 'hardware + software')}
    ${kpi('Estações de Trabalho', '742', '93% Windows 11')}
    ${kpi('Servidores', '156', '88% virtualizados', 'purple')}
    ${kpi('Fora de Garantia', '38', 'requerem renovação', 'amber')}
    ${kpi('Licenças em Risco', '12', 'compliance de software', 'red')}
    ${kpi('Idade Média Parque', '2,8 anos', 'ciclo de 4 anos', 'green')}
  </div>
  <div class="grid-2" style="margin-top:16px">
    <div class="card"><h4>Distribuição do Parque</h4>
      ${barRow('Notebooks', 58, C.blue)}${barRow('Desktops', 22, C.blueLight)}${barRow('Servidores físicos', 8, C.purple)}
      ${barRow('Dispositivos móveis', 12, C.green)}</div>
    <div class="card"><h4>📌 Ações de Lifecycle</h4>
      <div class="alert-item a-warning"><span>🟡</span><div>38 ativos fora de garantia — orçamento de renovação enviado ao Budget.</div></div>
      <div class="alert-item a-critical"><span>🔴</span><div>12 instalações sem licença correspondente detectadas pelo SAM.</div></div>
      <div class="alert-item a-info"><span>🔵</span><div>Refresh de notebooks da onda 2026 planejado para Q3.</div></div>
      ${n8nBtn('inventario-ativos', '⚡ Sync Inventário via N8N')}</div></div>`;

RENDERERS.continuity = async () => `
  <div class="kpi-grid">
    ${kpi('RTO Sistemas Críticos', '4h', 'objetivo de recuperação', 'green')}
    ${kpi('RPO Dados', '15 min', 'replicação síncrona', 'green')}
    ${kpi('Último Teste DR', 'há 74 dias', 'failover parcial OK', 'amber')}
    ${kpi('Planos BCP Vigentes', '12', 'processos críticos')}
    ${kpi('Backup Success Rate', '99,1%', 'últimos 30 dias', 'green')}
  </div>
  <div class="grid-2" style="margin-top:16px">
    <div class="card"><h4>🛡️ Prontidão por Cenário</h4>
      ${barRow('Indisponibilidade datacenter', 82, C.green)}${barRow('Ransomware / cyber', 68, C.amber)}
      ${barRow('Falha de fornecedor crítico', 60, C.amber)}${barRow('Indisponibilidade de pessoas-chave', 75, C.green)}</div>
    <div class="card"><h4>📅 Calendário de Testes</h4>
      <div class="toggle-row"><span>✅</span><span class="tr-label">Teste de restore de backup (mensal)</span>${badge('Em dia', 'green')}</div>
      <div class="toggle-row"><span>🟡</span><span class="tr-label">Failover DR completo (semestral)</span>${badge('Agendar Q3', 'amber')}</div>
      <div class="toggle-row"><span>✅</span><span class="tr-label">Tabletop cyber crisis (trimestral)</span>${badge('Em dia', 'green')}</div>
      ${n8nBtn('teste-dr', '⚡ Agendar teste via N8N')}</div></div>`;

RENDERERS.itom = async () => {
  const ds = await get('/data-sources');
  return `
  <div class="kpi-grid">
    ${kpi('Disponibilidade Geral', '99,82%', 'sistemas críticos 30d', 'green')}
    ${kpi('Hosts Monitorados', '412', 'Zabbix + cloud')}
    ${kpi('Alertas Ativos', '7', '2 críticos', 'amber')}
    ${kpi('Capacidade Storage', '71%', 'utilização SAN', 'amber')}
    ${kpi('Eventos/min', '~840', 'pipeline de observabilidade', 'purple')}
  </div>
  <div class="grid-2" style="margin-top:16px">
    <div class="card"><h4>🛰️ Saúde das Plataformas</h4>
      ${barRow('Virtualização (vSphere)', 96, C.green)}${barRow('Rede core/distribuição', 92, C.green)}
      ${barRow('Storage SAN', 71, C.amber)}${barRow('Kubernetes', 88, C.green)}${barRow('Bancos de dados', 90, C.green)}</div>
    <div class="card"><h4>🔌 Coletores Ativos</h4>
      ${ds.map(d => `<div class="toggle-row"><span>${d.status === 'Conectada' ? '🟢' : '🟡'}</span>
        <span class="tr-label">${esc(d.name)}</span><span class="mono" style="font-size:.7rem">${fmtNum(d.records_count)}</span>${statusBadge(d.status)}</div>`).join('')}</div></div>`;
};

RENDERERS.mapping = async () => {
  const ds = await get('/data-sources');
  return `
  <div class="section-title">🗺️ Mapa de Integrações do Hub</div>
  <div class="grid-3">
    ${ds.map(d => `<div class="card" style="border-left:4px solid ${d.status === 'Conectada' ? C.green : C.amber}">
      <h4>${esc(d.name)}</h4>
      <p style="font-size:.78rem;color:var(--text-2)">Protocolo: <b>${esc(d.system)}</b></p>
      <p style="font-size:.78rem;color:var(--text-2)">Registros: <b class="mono">${fmtNum(d.records_count)}</b></p>
      <p style="font-size:.78rem;color:var(--text-2)">Último sync: ${fmtDateTime(d.last_sync)}</p>
      <div style="margin-top:8px">${statusBadge(d.status)}</div></div>`).join('')}
  </div>
  <div class="card" style="margin-top:16px"><h4>Fluxo de Dados</h4>
    <p class="mono" style="font-size:.78rem;line-height:2">
    Fontes (ServiceNow · Azure · Zabbix · SAP · Fortinet) → N8N Workflows → <b>POST /api/n8n/sync</b> → SQLite (hub.db) → Dashboards deste portal<br>
    Portal → <b>POST /api/n8n/trigger</b> → N8N → ações externas (Teams, e-mail, relatórios, tickets)</p></div>`;
};

// =====================================================================
// 🔌 FONTES DE DADOS
// =====================================================================
RENDERERS.datasources = async () => {
  const ds = await get('/data-sources');
  window._excelDs = ds;
  return `
    <div class="kpi-grid">
      ${kpi('Fontes Conectadas', ds.filter(d => d.status === 'Conectada').length, `de ${ds.length} cadastradas`, 'green')}
      ${kpi('Em Atenção', ds.filter(d => d.status !== 'Conectada').length, 'sync atrasado', 'amber')}
      ${kpi('Registros Totais', fmtNum(ds.reduce((a, d) => a + d.records_count, 0)), 'agregados no hub')}
    </div>
    <div class="section-title">🔌 Fontes de Dados <span class="spacer"></span>${exportBtn('window._excelDs', 'fontes_dados')} ${n8nBtn('sync-fontes', '⚡ Forçar Sync via N8N')}</div>
    <div class="table-wrap"><table><thead><tr><th>Fonte</th><th>Sistema/Protocolo</th><th>Registros</th><th>Último Sync</th><th>Status</th></tr></thead>
    <tbody>${ds.map(d => `<tr><td><b>${esc(d.name)}</b></td><td>${esc(d.system)}</td><td class="mono">${fmtNum(d.records_count)}</td>
      <td>${fmtDateTime(d.last_sync)}</td><td>${statusBadge(d.status)}</td></tr>`).join('')}</tbody></table></div>`;
};

// =====================================================================
// ⚡ N8N WORKFLOWS
// =====================================================================
RENDERERS.n8n = async () => {
  const cfg = await get('/n8n/config', true);
  const flows = [
    ['sync-itsm', 'Sincronizar chamados ITSM', '🚨'], ['alerta-vencimentos', 'Alertas de vencimento de contratos', '📋'],
    ['relatorio-budget', 'Relatório executivo de budget', '💰'], ['reporte-riscos', 'Reporte de riscos ao comitê', '🔥'],
    ['scan-vulnerabilidades', 'Importar scan de vulnerabilidades', '🔐'], ['relatorio-okrs', 'Status report de OKRs', '🎯'],
    ['relatorio-auditoria', 'Pacote de evidências de auditoria', '📁'], ['alertas-executivos', 'Notificações executivas (Teams)', '📣']
  ];
  return `
    <div class="kpi-grid">
      ${kpi('Status N8N', cfg.base_url ? 'Configurado' : 'Não configurado', cfg.base_url ? esc(cfg.base_url) : 'defina a URL em Configurações', cfg.base_url ? 'green' : 'amber')}
      ${kpi('API Key', cfg.api_key_set ? 'Definida' : 'Ausente', 'autenticação dos webhooks', cfg.api_key_set ? 'green' : 'amber')}
      ${kpi('Último Sync Recebido', cfg.last_sync ? fmtDateTime(cfg.last_sync) : 'Nunca', 'via Supabase REST')}
    </div>
    <div class="section-title">⚡ Workflows Disponíveis ${adminOnly('')}</div>
    <div class="grid-3">
      ${flows.map(f => `<div class="card"><h4>${f[2]} ${f[1]}</h4>
        <p class="mono" style="font-size:.7rem;color:var(--text-2)">webhook/${f[0]}</p>
        <div style="margin-top:10px">${S.isAdmin ? `<button class="btn btn-primary btn-sm" onclick="dispararN8N('${f[0]}')">▶ Disparar</button>` : badge('Login admin para disparar', 'gray')}</div></div>`).join('')}
    </div>
    <div class="card" style="margin-top:16px"><h4>📥 Webhook de Entrada</h4>
      <p style="font-size:.8rem">O N8N grava direto no banco via Supabase REST:
      <span class="mono">POST https://&lt;projeto&gt;.supabase.co/rest/v1/hub_incidents</span>
      com headers <span class="mono">apikey</span> + <span class="mono">Authorization: Bearer &lt;service_role&gt;</span>
      e <span class="mono">Prefer: resolution=merge-duplicates</span> para upsert. Detalhes no README.</p></div>`;
};

// =====================================================================
// 📜 HISTÓRICO
// =====================================================================
RENDERERS.history = async () => {
  const acts = await get('/activity', true);
  window._excelAct = acts;
  return `
    <div class="section-title">📜 Histórico de Atividades <span class="spacer"></span>${exportBtn('window._excelAct', 'historico')}</div>
    <div class="table-wrap"><table><thead><tr><th>Data/Hora</th><th>Ator</th><th>Ação</th><th>Módulo</th></tr></thead>
    <tbody>${acts.map(a => `<tr><td class="mono" style="font-size:.72rem">${fmtDateTime(a.ts)}</td>
      <td>${badge(a.actor, a.actor === 'admin' ? 'blue' : a.actor === 'n8n' ? 'purple' : 'gray')}</td>
      <td>${esc(a.action)}</td><td>${esc(a.module)}</td></tr>`).join('')}</tbody></table></div>`;
};

// =====================================================================
// ⏱️ SLA MONITOR (4 sub-abas)
// =====================================================================
RENDERERS.sla = async () => {
  const sla = await get('/sla');
  const sub = curSub('sla', 'painel');
  const tabs = subtabsHTML('sla', [
    { id: 'painel', label: '📊 Painel Geral' }, { id: 'categoria', label: '🏷️ Por Categoria' },
    { id: 'equipe', label: '👥 Por Equipe' }, { id: 'historico', label: '📈 Histórico SLA' }
  ], sub);
  const open = sla.open_incidents;
  const total = sla.history.length, breaches = sla.history.filter(h => h.breached).length;
  const pct = total ? Math.round((1 - breaches / total) * 1000) / 10 : 100;
  const mttr = total ? Math.round(sla.history.reduce((a, h) => a + h.resolution_time, 0) / total) : 0;
  const avgResp = total ? Math.round(sla.history.reduce((a, h) => a + h.response_time, 0) / total) : 0;
  const breachedToday = open.filter(i => i.sla_limit && new Date(i.sla_limit) < new Date()).length;
  const kpis = `<div class="kpi-grid">
    ${kpi('Chamados em SLA', open.length, 'monitorados agora')}
    ${kpi('% Dentro do Prazo', pct + '%', 'histórico', pct >= 95 ? 'green' : 'amber')}
    ${kpi('Violações Hoje', breachedToday, 'SLA estourado', breachedToday ? 'red' : 'green')}
    ${kpi('MTTR Médio', Math.floor(mttr / 60) + 'h ' + (mttr % 60) + 'm', 'resolução', 'purple')}
    ${kpi('Tempo Médio Resposta', avgResp + ' min', 'primeiro atendimento', 'blue')}
  </div>`;
  let body = '';
  if (sub === 'painel') {
    window._excelSla = open;
    const rows = open.map((i, idx) => `
      <tr onclick="showIncident(${(S.cache['/incidents'] || []).findIndex(x => x.id === i.id)})">
        <td class="mono">${i.id}</td><td>${esc(i.title)}</td><td>${priBadge(i.priority)}</td>
        <td>${esc(i.category)}</td><td>${esc(i.assignee)}</td>
        <td class="mono" style="font-size:.72rem">${fmtDateTime(i.created_at)}</td>
        <td class="mono" style="font-size:.72rem">${fmtDateTime(i.sla_limit)}</td>
        <td>${slaCountdown(i.created_at, i.sla_limit)}</td>
        <td>${new Date(i.sla_limit) < new Date() ? badge('VIOLADO', 'red') : badge('No prazo', 'green')}</td></tr>`).join('');
    const recentBreaches = open.filter(i => new Date(i.sla_limit) < new Date());
    body = `
      <div class="section-title">⏱️ Countdown Regressivo — atualiza a cada 30s <span class="spacer"></span>${exportBtn('window._excelSla', 'sla_monitor')} ${n8nBtn('alerta-sla')}</div>
      <div class="table-wrap"><table><thead><tr>
        <th>ID</th><th>Título</th><th>Prior.</th><th>Categoria</th><th>Assignado</th><th>Abertura</th><th>SLA Limite</th><th>Tempo Restante</th><th>Status SLA</th>
      </tr></thead><tbody>${rows}</tbody></table></div>
      <div class="section-title">🚩 Violações Recentes — causa raiz</div>
      <div class="grid-2">${recentBreaches.slice(0, 4).map(i => `
        <div class="card" style="border-left:4px solid var(--red)"><h4>${i.id} — ${esc(i.title)}</h4>
          <p style="font-size:.78rem"><b>Causa provável:</b> fila da equipe ${esc(i.team)} acima da capacidade no turno; reatribuição automática não acionada.</p>
          <div style="margin-top:6px">${priBadge(i.priority)} ${badge(i.team, 'gray')}</div></div>`).join('') || '<div class="card">✅ Sem violações ativas.</div>'}</div>`;
  } else if (sub === 'categoria') {
    body = `<div class="grid-2">
      <div class="card"><h4>SLA por Categoria</h4><div class="chart-box tall"><canvas id="chSlaCat"></canvas></div></div>
      <div class="card"><h4>Violações por Categoria</h4>
        ${sla.by_category.map(c => barRow(c.category, Math.round((c.breaches / c.total) * 100), c.breaches / c.total > .1 ? C.red : C.green, `${c.breaches}/${c.total} violações`)).join('')}
      </div></div>`;
  } else if (sub === 'equipe') {
    body = `
      <div class="section-title">🏆 Ranking de Equipes</div>
      <div class="table-wrap"><table><thead><tr><th>#</th><th>Equipe</th><th>Chamados</th><th>Violações</th><th>% SLA</th><th>MTTR</th><th>Tempo Resposta</th></tr></thead>
      <tbody>${sla.by_team.map((t, i) => { const p = Math.round((1 - t.breaches / t.total) * 100); return `
        <tr><td>${['🥇', '🥈', '🥉'][i] || (i + 1)}</td><td><b>${esc(t.team)}</b></td><td>${t.total}</td><td>${t.breaches}</td>
        <td><span class="${p >= 95 ? 'cd-ok' : p >= 85 ? 'cd-warn' : 'cd-crit'} mono">${p}%</span></td>
        <td class="mono">${Math.floor(t.mttr_min / 60)}h${t.mttr_min % 60}m</td><td class="mono">${t.avg_response_min} min</td></tr>`; }).join('')}</tbody></table></div>`;
  } else {
    // heatmap dia × hora (derivado do histórico)
    const hm = Array.from({ length: 7 }, () => Array(8).fill(0));
    sla.history.filter(h => h.breached).forEach((h, i) => { const d = new Date(h.date); hm[d.getDay()][(i * 3) % 8]++; });
    const maxV = Math.max(1, ...hm.flat());
    const dias = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    const hmHTML = `<div class="heatmap" style="grid-template-columns:40px repeat(8,1fr)">` +
      hm.map((row, d) => `<div class="rm-axis">${dias[d]}</div>` + row.map(v =>
        `<div class="hm-cell" style="background:rgba(197,48,48,${(v / maxV * 0.85 + (v ? 0.1 : 0.03)).toFixed(2)})" title="${v} violações"></div>`).join('')).join('') +
      '<div></div>' + ['0h', '3h', '6h', '9h', '12h', '15h', '18h', '21h'].map(h => `<div class="rm-axis">${h}</div>`).join('') + '</div>';
    body = `<div class="grid-2">
      <div class="card"><h4>% SLA — 6 meses por prioridade</h4><div class="chart-box tall"><canvas id="chSlaHist"></canvas></div></div>
      <div class="card"><h4>🔥 Heatmap de Violações — dia × hora</h4>${hmHTML}
        <p style="font-size:.7rem;color:var(--text-2);margin-top:8px">Intensidade proporcional ao nº de violações no horário.</p></div></div>`;
  }
  return kpis + tabs + body;
};
POST_RENDER.sla = async () => {
  await get('/incidents'); // garante cache p/ cliques na tabela
  const sub = curSub('sla', 'painel');
  const sla = await get('/sla');
  if (sub === 'categoria') {
    mkChart('chSlaCat', { type: 'bar', data: { labels: sla.by_category.map(c => c.category),
      datasets: [{ label: '% no prazo', data: sla.by_category.map(c => Math.round((1 - c.breaches / c.total) * 100)), backgroundColor: C.blue }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { min: 60, max: 100 } } } });
  } else if (sub === 'historico') {
    const nowM = new Date().getMonth();
    const labels = []; for (let i = 5; i >= 0; i--) labels.push(MONTHS[(nowM - i + 12) % 12]);
    mkChart('chSlaHist', { type: 'line', data: { labels, datasets: [
      { label: 'P1', data: [92, 94, 90, 95, 93, 96], borderColor: C.red, tension: .35 },
      { label: 'P2', data: [94, 95, 93, 96, 95, 97], borderColor: C.amber, tension: .35 },
      { label: 'P3/P4', data: [97, 96, 97, 98, 97, 98], borderColor: C.green, tension: .35 }
    ] }, options: { maintainAspectRatio: false, scales: { y: { min: 85, max: 100 } } } });
  }
};

// =====================================================================
// 📁 AUDITORIA & EVIDÊNCIAS (5 sub-abas)
// =====================================================================
RENDERERS.audit = async () => {
  const audit = await get('/audit');
  const sub = curSub('audit', 'painel');
  const tabs = subtabsHTML('audit', [
    { id: 'painel', label: '📊 Painel' }, { id: 'evidencias', label: '📎 Evidências' },
    { id: 'controles', label: '🎛️ Controles' }, { id: 'planos', label: '📌 Planos de Ação' }, { id: 'relatorios', label: '📄 Relatórios' }
  ], sub);
  const ev = audit.evidences;
  const valid = ev.filter(e => e.status === 'Válida').length;
  const expiring = ev.filter(e => e.status === 'Vencendo').length;
  const expired = ev.filter(e => e.status === 'Vencida').length;
  const kpis = `<div class="kpi-grid">
    ${kpi('Evidências', ev.length, 'registradas')}
    ${kpi('Válidas', valid, Math.round(valid / ev.length * 100) + '% do total', 'green')}
    ${kpi('Vencendo 30d', expiring, 'recoletar', 'amber')}
    ${kpi('Vencidas', expired, 'ação imediata', expired ? 'red' : 'green')}
    ${kpi('Planos de Ação', audit.actions.filter(a => a.status !== 'Concluído').length, 'em aberto', 'purple')}
  </div>`;
  let body = '';
  if (sub === 'painel') {
    body = `<div class="grid-2">
      <div class="card"><h4>Radar de Maturidade por Framework</h4><div class="chart-box tall"><canvas id="chRadar"></canvas></div></div>
      <div class="card"><h4>📅 Vencimentos — Próximos 90 dias</h4>
        ${ev.filter(e => { const d = new Date(e.expires_at); return d > new Date() && d < new Date(Date.now() + 90 * 86400000); })
          .slice(0, 10).map(e => `<div class="toggle-row"><span>${new Date(e.expires_at) < new Date(Date.now() + 30 * 86400000) ? '🟡' : '🔵'}</span>
          <span class="tr-label" style="font-size:.78rem">${esc(e.control)}</span>
          <span class="mono" style="font-size:.7rem">${fmtDate(e.expires_at)}</span>${badge(e.framework, 'blue')}</div>`).join('')}
      </div></div>`;
  } else if (sub === 'evidencias') {
    window._excelEv = ev;
    body = `
      <div class="section-title">📎 Registro de Evidências <span class="spacer"></span>
        <select id="evFilter" onchange="filterEvidences()" style="padding:6px 10px;border-radius:8px;border:1px solid var(--border)">
          <option value="">Todos os frameworks</option><option>ISO 27001</option><option>ISO 42001</option><option>LGPD</option><option>COBIT</option></select>
        ${adminOnly(`<button class="btn btn-primary btn-sm" onclick="newEvidenceForm()">➕ Nova Evidência</button>`)}
        ${exportBtn('window._excelEv', 'evidencias')}
      </div>
      <div class="table-wrap"><table><thead><tr>
        <th>Framework</th><th>Domínio</th><th>Controle</th><th>Tipo</th><th>Responsável</th><th>Coletada</th><th>Vence</th><th>Status</th><th>Aprovador</th>
      </tr></thead><tbody id="evTbody">${evidenceRows(ev)}</tbody></table></div>`;
  } else if (sub === 'controles') {
    body = `<div class="section-title">🎛️ Controles por Framework</div>
      <div class="table-wrap"><table><thead><tr><th>Framework</th><th>Evidências</th><th>Válidas</th><th>Vencendo</th><th>Vencidas</th><th>Aderência</th></tr></thead>
      <tbody>${audit.by_framework.map(f => { const p = Math.round(f.valid / f.total * 100); return `
        <tr><td><b>${f.framework}</b></td><td>${f.total}</td><td>${f.valid}</td><td>${f.expiring}</td><td>${f.expired}</td>
        <td><div class="bar-track" style="width:160px;display:inline-block;vertical-align:middle"><div class="bar-fill" style="width:${p}%;background:${p >= 80 ? C.green : C.amber}"></div></div> <span class="mono" style="font-size:.74rem">${p}%</span></td></tr>`; }).join('')}</tbody></table></div>`;
  } else if (sub === 'planos') {
    body = `<div class="section-title">📌 Planos de Ação</div>
      ${audit.actions.map(a => `<div class="card" style="margin-bottom:12px;border-left:4px solid ${a.status === 'Atrasado' ? C.red : C.blue}">
        <h4>${esc(a.gap)}</h4>
        <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:.76rem;color:var(--text-2);margin-bottom:8px">
          <span>${badge(a.framework, 'blue')}</span><span>Criticidade: ${badge(a.criticality, a.criticality === 'Alta' ? 'red' : a.criticality === 'Média' ? 'amber' : 'gray')}</span>
          <span>👤 ${esc(a.responsible)}</span><span>📅 ${fmtDate(a.deadline)}</span><span>${statusBadge(a.status)}</span></div>
        ${barRow('Progresso', a.completion_pct, a.completion_pct >= 70 ? C.green : a.completion_pct >= 40 ? C.amber : C.red)}</div>`).join('')}`;
  } else {
    body = `<div class="grid-2">
      <div class="card"><h4>📄 Relatórios de Auditoria</h4>
        <div class="toggle-row"><span>📑</span><span class="tr-label">Pacote de evidências por framework (Excel)</span>
          <button class="btn btn-green btn-sm" onclick="exportExcel(S.cache['/audit'].evidences,'pacote_evidencias')">Gerar</button></div>
        <div class="toggle-row"><span>📑</span><span class="tr-label">Status de planos de ação (Excel)</span>
          <button class="btn btn-green btn-sm" onclick="exportExcel(S.cache['/audit'].actions,'planos_acao')">Gerar</button></div>
        <div class="toggle-row"><span>⚡</span><span class="tr-label">Relatório completo via N8N (PDF + e-mail)</span>
          ${S.isAdmin ? `<button class="btn btn-primary btn-sm" onclick="dispararN8N('relatorio-auditoria')">Disparar</button>` : badge('admin', 'gray')}</div>
      </div>
      <div class="card"><h4>🗓️ Ciclo de Auditoria</h4>
        <div class="alert-item a-info"><span>📌</span><div>Auditoria interna ISO 27001 concluída em Maio/2026 — 6 apontamentos.</div></div>
        <div class="alert-item a-warning"><span>🟡</span><div>Auditoria externa de certificação ISO 42001 prevista para Q4 2026.</div></div>
        <div class="alert-item a-info"><span>📌</span><div>Avaliação LGPD anual (ANPD readiness) agendada para Agosto/2026.</div></div></div></div>`;
  }
  return kpis + tabs + body;
};
function evidenceRows(ev) {
  return ev.map(e => `
    <tr><td>${badge(e.framework, 'blue')}</td><td style="font-size:.74rem">${esc(e.domain)}</td>
    <td style="font-size:.76rem">${esc(e.control)}</td><td>${esc(e.type)}</td><td>${esc(e.responsible)}</td>
    <td class="mono" style="font-size:.7rem">${fmtDate(e.collected_at)}</td>
    <td class="mono" style="font-size:.7rem">${fmtDate(e.expires_at)}</td>
    <td>${statusBadge(e.status)}</td><td style="font-size:.74rem">${esc(e.approver)}</td></tr>`).join('');
}
async function filterEvidences() {
  const f = document.getElementById('evFilter').value;
  const ev = (await get('/audit')).evidences.filter(e => !f || e.framework === f);
  document.getElementById('evTbody').innerHTML = evidenceRows(ev);
}
function newEvidenceForm() {
  openModal('➕ Nova Evidência', `
    <div class="form-grid">
      <div class="fld"><label>Framework</label><select id="e_fw"><option>ISO 27001</option><option>ISO 42001</option><option>LGPD</option><option>COBIT</option></select></div>
      <div class="fld"><label>Domínio</label><input id="e_dom"></div>
      <div class="fld full"><label>Controle *</label><input id="e_ctl"></div>
      <div class="fld"><label>Tipo</label><select id="e_type"><option>Política</option><option>Print de tela</option><option>Relatório</option><option>Ata de reunião</option><option>Log de sistema</option><option>Certificado</option></select></div>
      <div class="fld"><label>Responsável</label><input id="e_resp"></div>
      <div class="fld"><label>Vence em</label><input id="e_exp" type="date"></div>
      <div class="fld"><label>Aprovador</label><input id="e_appr"></div>
    </div>
    <div style="margin-top:14px"><button class="btn btn-primary" onclick="createEvidence()">Registrar</button></div>`);
}
async function createEvidence() {
  const v = x => document.getElementById(x).value;
  try {
    await api('/evidences', { method: 'POST', body: {
      framework: v('e_fw'), domain: v('e_dom'), control: v('e_ctl'), type: v('e_type'),
      responsible: v('e_resp'), approver: v('e_appr'),
      expires_at: v('e_exp') ? new Date(v('e_exp')).toISOString() : null } });
    invalidate('/audit'); invalidate('/kpis'); closeModal();
    toast('Evidência registrada ✓', 'success'); navTo('audit');
  } catch (e) { toast(e.message, 'error'); }
}
POST_RENDER.audit = async () => {
  if (curSub('audit', 'painel') !== 'painel') return;
  const audit = await get('/audit');
  mkChart('chRadar', { type: 'radar', data: { labels: audit.by_framework.map(f => f.framework),
    datasets: [{ label: 'Aderência %', data: audit.by_framework.map(f => Math.round(f.valid / f.total * 100)),
      backgroundColor: 'rgba(30,80,160,.15)', borderColor: C.blue, pointBackgroundColor: C.blue }] },
    options: { maintainAspectRatio: false, scales: { r: { min: 0, max: 100 } } } });
};

// =====================================================================
// 🎯 OKRs DE TI (4 sub-abas)
// =====================================================================
RENDERERS.okrs = async () => {
  const okrs = await get('/okrs');
  const sub = curSub('okrs', 'ciclo');
  const tabs = subtabsHTML('okrs', [
    { id: 'ciclo', label: '🎯 Ciclo Atual' }, { id: 'area', label: '🏢 Por Área' },
    { id: 'hist', label: '📈 Histórico' }, { id: 'config', label: '⚙️ Configurar OKRs' }
  ], sub);
  const avg = okrs.length ? Math.round(okrs.reduce((a, o) => a + o.current_pct, 0) / okrs.length) : 0;
  const expectedPct = 50; // meio do ciclo Q2
  const atRisk = okrs.filter(o => o.current_pct < expectedPct * 0.8);
  const totalKrs = okrs.reduce((a, o) => a + o.key_results.length, 0);
  const kpis = `<div class="kpi-grid">
    ${kpi('OKRs no Ciclo', okrs.length, okrs[0]?.cycle || '', 'purple')}
    ${kpi('Key Results', totalKrs, 'monitorados')}
    ${kpi('Atingimento Médio', avg + '%', 'do ciclo', avg >= 60 ? 'green' : 'amber')}
    ${kpi('Em Risco', atRisk.length, '< 40% do esperado', atRisk.length ? 'red' : 'green')}
    ${kpi('KRs Concluídos', okrs.flatMap(o => o.key_results).filter(k => k.status === 'Concluído').length, 'meta batida', 'green')}
  </div>`;
  const riskAlert = atRisk.length ? `
    <div class="alert-item a-critical" style="margin-bottom:14px"><span>🚨</span>
      <div><b>OKRs em risco:</b> ${atRisk.map(o => esc(o.title)).join(' · ')} — abaixo de 80% do progresso esperado para o momento do ciclo.</div></div>` : '';
  const okrCard = o => `
    <div class="card okr-card ${o.current_pct < 40 ? 'ok-risk' : ''}">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;flex-wrap:wrap">
        <h4>🎯 ${esc(o.title)}</h4>
        <span class="mono" style="font-size:1.1rem;font-weight:800;color:${o.current_pct >= 70 ? C.green : o.current_pct >= 50 ? C.amber : C.red}">${o.current_pct}%</span></div>
      <div style="font-size:.74rem;color:var(--text-2);margin-bottom:10px">${badge(o.area, 'blue')} ${badge(o.cycle, 'purple')} · ${esc(o.strategic_alignment)}</div>
      ${barRow('Progresso do objetivo', o.current_pct, o.current_pct >= 70 ? C.green : o.current_pct >= 50 ? C.amber : C.red)}
      ${o.key_results.map(k => `
        <div class="kr-row">
          <div class="kr-desc"><b>KR:</b> ${esc(k.description)}<div class="alert-time">Meta ${esc(k.target)} · atual ${esc(k.current)} · 👤 ${esc(k.responsible)}</div></div>
          <div class="kr-bar">${barRow('', k.progress_pct, k.progress_pct >= 70 ? C.green : k.progress_pct >= 45 ? C.amber : C.red, k.progress_pct + '%')}</div>
          ${statusBadge(k.status)}</div>`).join('')}
    </div>`;
  let body = '';
  if (sub === 'ciclo') body = riskAlert + okrs.map(okrCard).join('') +
    `<div style="display:flex;gap:10px">${n8nBtn('relatorio-okrs', '⚡ Status Report via N8N')}</div>`;
  else if (sub === 'area') {
    const areas = [...new Set(okrs.map(o => o.area))];
    body = `<div class="grid-2"><div class="card"><h4>Atingimento por Área</h4><div class="chart-box"><canvas id="chOkrArea"></canvas></div></div>
      <div class="card"><h4>Alinhamento Estratégico</h4>
      ${okrs.map(o => `<div class="toggle-row"><span>🎯</span><span class="tr-label" style="font-size:.78rem">${esc(o.title)}</span>
        ${badge(o.strategic_alignment.replace('Pilar estratégico: ', ''), 'purple')}</div>`).join('')}</div></div>` +
      areas.map(a => `<div class="section-title">🏢 ${a}</div>` + okrs.filter(o => o.area === a).map(okrCard).join('')).join('');
  } else if (sub === 'hist') {
    body = `<div class="card"><h4>📈 Evolução por Ciclo</h4><div class="chart-box"><canvas id="chOkrHist"></canvas></div>
      <p style="font-size:.76rem;color:var(--text-2);margin-top:8px">Q3 e Q4 2025 e Q1 2026: dados consolidados dos ciclos anteriores. Q2 2026: ciclo corrente (parcial).</p></div>`;
  } else {
    body = S.isAdmin ? `
      <div class="card"><h4>⚙️ Novo OKR</h4>
        <div class="form-grid">
          <div class="fld full"><label>Objetivo *</label><input id="o_title"></div>
          <div class="fld"><label>Ciclo</label><input id="o_cycle" value="Q2 2026"></div>
          <div class="fld"><label>Área</label><select id="o_area"><option>Infraestrutura</option><option>Segurança</option><option>Dados & IA</option><option>Aplicações</option><option>Service Desk</option></select></div>
          <div class="fld full"><label>Alinhamento estratégico</label><input id="o_align" placeholder="Pilar estratégico: …"></div>
          <div class="fld full"><label>Key Results (um por linha: descrição | meta | responsável)</label><textarea id="o_krs" rows="4" placeholder="Reduzir MTTR para 2h | 2h | Carlos Mendes"></textarea></div>
        </div>
        <div style="margin-top:14px;display:flex;gap:10px">
          <button class="btn btn-primary" onclick="createOKR()">Criar OKR</button>
          ${n8nBtn('novo-okr', '⚡ Notificar área via N8N')}</div></div>
      <div class="card" style="margin-top:14px"><h4>✏️ Atualizar atingimento</h4>
        ${okrs.map(o => `<div class="toggle-row"><span class="tr-label" style="font-size:.78rem">${esc(o.title)}</span>
          <input type="number" min="0" max="100" value="${o.current_pct}" id="okr_pct_${o.id}" style="width:80px;padding:6px;border:1px solid var(--border);border-radius:8px">
          <button class="btn btn-secondary btn-sm" onclick="updOKR(${o.id})">💾</button></div>`).join('')}</div>`
      : `<div class="card"><h4>⚙️ Configurar OKRs</h4><p style="font-size:.84rem">Faça login como <b>Admin</b> para cadastrar objetivos, key results e atualizar atingimentos.</p></div>`;
  }
  return kpis + tabs + body;
};
POST_RENDER.okrs = async () => {
  const sub = curSub('okrs', 'ciclo');
  const okrs = await get('/okrs');
  if (sub === 'area') {
    const areas = [...new Set(okrs.map(o => o.area))];
    mkChart('chOkrArea', { type: 'bar', data: { labels: areas,
      datasets: [{ data: areas.map(a => { const list = okrs.filter(o => o.area === a); return Math.round(list.reduce((x, o) => x + o.current_pct, 0) / list.length); }), backgroundColor: [C.blue, C.green, C.purple] }] },
      options: { maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { max: 100 } } } });
  } else if (sub === 'hist') {
    mkChart('chOkrHist', { type: 'line', data: { labels: ['Q3 2025', 'Q4 2025', 'Q1 2026', 'Q2 2026 (parcial)'],
      datasets: [{ label: 'Atingimento médio', data: [71, 78, 74, okrs.length ? Math.round(okrs.reduce((a, o) => a + o.current_pct, 0) / okrs.length) : 0],
        borderColor: C.purple, backgroundColor: 'rgba(107,70,193,.1)', fill: true, tension: .35 }] },
      options: { maintainAspectRatio: false, scales: { y: { min: 0, max: 100 } } } });
  }
};
async function createOKR() {
  const v = x => document.getElementById(x).value;
  const krs = v('o_krs').split('\n').filter(l => l.trim()).map(l => {
    const [description, target, responsible] = l.split('|').map(s => s.trim());
    return { description, target: target || '', responsible: responsible || '' };
  });
  try {
    await api('/okrs', { method: 'POST', body: { title: v('o_title'), cycle: v('o_cycle'), area: v('o_area'), strategic_alignment: v('o_align'), key_results: krs } });
    invalidate('/okrs'); invalidate('/kpis');
    toast('OKR criado ✓', 'success'); navTo('okrs');
  } catch (e) { toast(e.message, 'error'); }
}
async function updOKR(id) {
  try {
    await api(`/okrs/${id}`, { method: 'PUT', body: { current_pct: Number(document.getElementById('okr_pct_' + id).value) } });
    invalidate('/okrs'); invalidate('/kpis');
    toast('Atingimento atualizado ✓', 'success'); navTo('okrs');
  } catch (e) { toast(e.message, 'error'); }
}

// =====================================================================
// ⚙️ CONFIGURAÇÕES
// =====================================================================
RENDERERS.settings = async () => {
  const cfg = await get('/config', true);
  const n8n = await get('/n8n/config', true);
  const togglesHTML = cfg.modules.map(m => {
    const isProtected = m.id === 'overview' || m.id === 'settings';
    return `<div class="toggle-row">
      <span>${m.icon}</span><span class="tr-label">${esc(m.label)} ${isProtected ? badge('sempre ativo', 'gray') : ''}</span>
      <label class="switch"><input type="checkbox" ${m.enabled ? 'checked' : ''} ${(isProtected || !S.isAdmin) ? 'disabled' : ''}
        onchange="toggleModule('${m.id}', this.checked)"><span class="slider"></span></label></div>`;
  }).join('');
  return `
    <div class="grid-2">
      <div class="card"><h4>🧩 Módulos do Portal ${S.isAdmin ? '' : badge('login admin para editar', 'amber')}</h4>
        <p style="font-size:.76rem;color:var(--text-2);margin-bottom:10px">As mudanças valem para todos os usuários, em tempo real, sem reload.</p>
        ${togglesHTML}</div>
      <div>
        <div class="card" style="margin-bottom:16px"><h4>⚡ Integração N8N</h4>
          <div class="fld"><label>URL Base do N8N</label><input id="n8n_url" value="${esc(n8n.base_url)}" placeholder="https://n8n.suaempresa.com" ${S.isAdmin ? '' : 'disabled'}></div>
          <div class="fld" style="margin-top:10px"><label>API Key ${n8n.api_key_set ? badge('definida', 'green') : badge('não definida', 'amber')}</label>
            <input id="n8n_key" type="password" placeholder="${n8n.api_key_set ? '•••••••• (deixe vazio para manter)' : 'cole a API key'}" ${S.isAdmin ? '' : 'disabled'}></div>
          ${S.isAdmin ? `<div style="margin-top:12px;display:flex;gap:10px">
            <button class="btn btn-primary btn-sm" onclick="saveN8N()">💾 Salvar</button>
            <button class="btn btn-secondary btn-sm" onclick="dispararN8N('teste-conexao')">⚡ Testar disparo</button></div>` : ''}
          <p style="font-size:.72rem;color:var(--text-2);margin-top:10px">Último sync recebido: ${n8n.last_sync ? fmtDateTime(n8n.last_sync) : 'nunca'}</p>
        </div>
        <div class="card"><h4>🔐 Sessão & Acesso</h4>
          <div class="toggle-row"><span>👤</span><span class="tr-label">Perfil atual</span>${S.isAdmin ? badge('Administrador', 'green') : badge('Visualizador', 'blue')}</div>
          <div class="toggle-row"><span>⏱️</span><span class="tr-label">Duração da sessão admin</span><span class="mono" style="font-size:.76rem">15 min</span></div>
          <div class="toggle-row"><span>🛡️</span><span class="tr-label">Bloqueio por tentativas</span><span class="mono" style="font-size:.76rem">5 falhas → 15 min</span></div>
          <div class="toggle-row"><span>💾</span><span class="tr-label">Banco de dados</span><span class="mono" style="font-size:.76rem">Supabase (PostgreSQL · free tier)</span></div>
          <div class="toggle-row"><span>🔁</span><span class="tr-label">Senha do admin</span>
            <button class="btn btn-secondary btn-sm" onclick="openResetFlow()">Trocar (validação por e-mail)</button></div>
        </div>
      </div>
    </div>`;
};
async function toggleModule(id, enabled) {
  try {
    await api('/config/modules', { method: 'PUT', body: { id, enabled: enabled ? 1 : 0 } });
    toast(`Módulo ${enabled ? 'habilitado' : 'desabilitado'} ✓`, 'success');
    await renderTabs();
  } catch (e) {
    toast(e.message, 'error');
    navTo('settings');
  }
}
async function saveN8N() {
  const url = document.getElementById('n8n_url').value.trim();
  const key = document.getElementById('n8n_key').value;
  try {
    await api('/n8n/config', { method: 'PUT', body: key ? { base_url: url, api_key: key } : { base_url: url } });
    toast('Configuração N8N salva ✓', 'success');
    invalidate('/n8n');
  } catch (e) { toast(e.message, 'error'); }
}

// =====================================================================
// BOOT
// =====================================================================
(async function init() {
  try {
    await refreshAuth();
    await renderTabs();
    await buildTicker();
    setInterval(buildTicker, 60000); // ticker atualiza a cada 60s
    await navTo('overview');
  } catch (e) {
    document.getElementById('main').innerHTML =
      `<div class="loading-panel">⚠️ Não foi possível conectar ao Supabase (${esc(e.message)}).<br>Verifique se o <span class="mono">setup.sql</span> foi executado no projeto e se ele não está pausado (free tier pausa após ~1 semana sem uso).</div>`;
  }
})();
