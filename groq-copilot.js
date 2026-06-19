// =====================================================================
// groq-copilot.js — Integração Groq AI para o HUB GOV TI v2
// Faz override do askCopilot() do app.js com IA real (Llama 3.1 via Groq)
// Coleta dados reais do Supabase e responde em português executivo.
//
// INSTALAÇÃO: adicione no index.html logo antes de </body>:
//   <script src="groq-copilot.js"></script>
// =====================================================================
(function () {
  'use strict';

  const GROQ_MODEL   = 'llama-3.1-8b-instant';
  const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
  const LS_KEY       = 'hub_groq_key';

  // ── Gerenciamento da chave ────────────────────────────────────────────────
  function getKey()    { return localStorage.getItem(LS_KEY) || ''; }
  function saveKey(k)  { localStorage.setItem(LS_KEY, k.trim()); }

  function promptKey() {
    const existing = getKey();
    const val = prompt(
      '🤖 Configurar Groq API Key\n\n' +
      'Obtenha GRÁTIS em: https://console.groq.com\n\n' +
      'Cole sua chave abaixo (começa com gsk_):',
      existing || ''
    );
    if (val === null) return null;            // cancelou
    const k = val.trim();
    if (!k.startsWith('gsk_')) {
      alert('⚠️ Chave inválida — deve começar com gsk_\nTente novamente.');
      return null;
    }
    saveKey(k);
    return k;
  }

  // ── System prompt ─────────────────────────────────────────────────────────
  function buildSystem() {
    return `Você é o Copilot de Governança do HUB GOV TI v2, assistente especializado em gestão de TI corporativa.

Responda SEMPRE em português brasileiro, de forma direta, objetiva e executiva.
Você analisa dados reais do portal (Supabase) e responde perguntas sobre:
incidentes/ITSM, budget/FinOps, contratos, fornecedores, riscos, vulnerabilidades,
OKRs, KPIs, segurança/IAM, compliance (ISO 27001, ISO 42001, LGPD, COBIT), governança de IA e SLA.

REGRAS:
1. Foque nos números e fatos dos dados fornecidos.
2. Destaque alertas críticos quando existirem.
3. Inclua recomendações práticas e concisas.
4. Use bullet points e negrito para clareza.
5. Se não houver dados suficientes, diga claramente.
6. Seja objetivo — resposta máxima de ~400 palavras.`;
  }

  // ── Coleta seletiva de dados do HUB ──────────────────────────────────────
  async function collectData(q) {
    const always  = { kpis: get('/kpis') };
    const byTopic = {
      incidents: /incidente|p1|p2|p3|sla|chamado|itsm|aberto|fila/i.test(q),
      risks:     /risco|vuln|cvss|cve|segurança|ameaça|postura/i.test(q),
      contracts: /contrato|fornecedor|vencendo|renovação|ctr|supplier/i.test(q),
      okrs:      /okr|meta|objetivo|ciclo|atingimento|kpi/i.test(q),
      budget:    /budget|orçamento|capex|opex|realizado|financeiro|custo/i.test(q),
      security:  /vuln|cve|pam|credencial|rotação|pentest|exploit/i.test(q),
    };

    // Resumo geral → coleta tudo
    if (/resumo|executivo|visão|geral|como está|situação|tudo|hoje/i.test(q)) {
      Object.keys(byTopic).forEach(k => byTopic[k] = true);
    }

    const fetch_map = { ...always };
    if (byTopic.incidents) fetch_map.incidents = get('/incidents');
    if (byTopic.risks)     fetch_map.risks      = get('/risks');
    if (byTopic.contracts) fetch_map.contracts  = get('/contracts');
    if (byTopic.okrs)      fetch_map.okrs       = get('/okrs');
    if (byTopic.budget)    fetch_map.budget      = get('/budget');
    if (byTopic.security)  fetch_map.security    = get('/security');

    const results = {};
    await Promise.all(
      Object.entries(fetch_map).map(async ([k, p]) => {
        try { results[k] = await p; } catch { results[k] = null; }
      })
    );
    return results;
  }

  // ── Resumo compacto do contexto para o LLM ────────────────────────────────
  function summarize(data) {
    const parts = [];

    if (data.kpis) {
      const k = data.kpis;
      const budgPct = k.budget_annual
        ? Math.round(k.budget_realized / k.budget_annual * 100) : 0;
      parts.push(`=== KPIs GERAIS ===
• Incidentes abertos: ${k.incidents_open}  (P1 abertos: ${k.incidents_p1_open})
• Budget ${new Date().getFullYear()}: R$ ${(k.budget_annual/1e6).toFixed(1)}M planejado | R$ ${(k.budget_realized/1e6).toFixed(1)}M realizado (${budgPct}%)
• Contratos ativos: ${k.contracts_active}  (carteira: R$ ${(k.contracts_value/1e6).toFixed(1)}M)
• RFCs pendentes: ${k.rfcs_pending}
• Riscos críticos: ${k.risks_critical}  |  Vulns críticas abertas: ${k.vulns_critical}
• SLA geral: ${k.sla_pct}%
• OKRs (média ciclo): ${k.okr_avg_pct}%  |  Conformidade evidências: ${k.compliance_pct}%
• Modelos IA em produção: ${k.ai_models_prod}  |  Tokens/mês: ${(k.ai_tokens_month/1e6).toFixed(1)}M
• Fornecedores: ${k.suppliers_count}  |  SLA médio fornecedores: ${k.suppliers_sla_avg}%`);
    }

    if (data.incidents?.length) {
      const open = data.incidents.filter(i => i.status !== 'Resolvido');
      const p1   = open.filter(i => i.priority === 'P1');
      const p2   = open.filter(i => i.priority === 'P2');
      parts.push(`=== INCIDENTES ===
• Total abertos: ${open.length}  (P1: ${p1.length}, P2: ${p2.length})
${p1.map(i => `  [P1] ${i.id}: ${i.title} | responsável: ${i.assignee||'—'} | SLA: ${i.sla_limit||'—'} | status: ${i.status}`).join('\n')}
${p2.slice(0,3).map(i => `  [P2] ${i.id}: ${i.title} | ${i.assignee||'—'} | ${i.status}`).join('\n')}`);
    }

    if (data.risks?.length) {
      const sorted  = [...data.risks].sort((a,b) => b.probability*b.impact - a.probability*a.impact);
      const criticos = sorted.filter(r => r.probability * r.impact >= 15);
      const altos    = sorted.filter(r => r.probability * r.impact >= 10 && r.probability * r.impact < 15);
      parts.push(`=== RISCOS ===
• Críticos (P×I ≥ 15): ${criticos.length}  |  Altos (≥ 10): ${altos.length}
${criticos.slice(0,5).map(r => `  [CRÍTICO] ${r.code}: ${r.description} (P:${r.probability} × I:${r.impact} = ${r.probability*r.impact})`).join('\n')}`);
    }

    if (data.contracts?.length) {
      const vencendo = data.contracts.filter(c => ['Vencendo','Em renegociação'].includes(c.status));
      const total    = data.contracts.reduce((a,c) => a + Number(c.value||0), 0);
      parts.push(`=== CONTRATOS ===
• Total na carteira: ${data.contracts.length}  |  Valor total: R$ ${(total/1e6).toFixed(1)}M
• Vencendo / Em renegociação: ${vencendo.length}
${vencendo.map(c => `  [${c.status.toUpperCase()}] ${c.id}: ${c.title} | ${c.supplier} | R$ ${(Number(c.value)/1e3).toFixed(0)}k | vence: ${c.end_date}`).join('\n')}`);
    }

    if (data.okrs?.length) {
      const avg = Math.round(data.okrs.reduce((a,o) => a+Number(o.current_pct||0),0) / data.okrs.length);
      parts.push(`=== OKRs (ciclo ${data.okrs[0]?.cycle||'atual'} — média ${avg}%) ===
${data.okrs.map(o => `  • ${o.title}: ${o.current_pct}% — ${o.status}`).join('\n')}`);
    }

    if (data.budget) {
      const t = data.budget.totals || [];
      const totalPl = t.reduce((a,x) => a+Number(x.planned),0);
      const totalRe = t.reduce((a,x) => a+Number(x.realized),0);
      parts.push(`=== BUDGET ${data.budget.year} ===
• Total: R$ ${(totalPl/1e6).toFixed(1)}M plan | R$ ${(totalRe/1e6).toFixed(1)}M realizado
${t.map(x => `  ${x.category}: plan R$ ${(x.planned/1e6).toFixed(1)}M / real R$ ${(x.realized/1e6).toFixed(1)}M`).join('\n')}`);
    }

    if (data.security) {
      const vulns  = (data.security.vulnerabilities||[]).filter(v => v.status !== 'Corrigida');
      const criticas = vulns.filter(v => v.severity === 'Crítica');
      const pam    = (data.security.pam_accounts||[]).filter(a => Number(a.rotation_days) > 90);
      parts.push(`=== SEGURANÇA ===
• Vulnerabilidades abertas: ${vulns.length}  (críticas: ${criticas.length})
• Contas PAM com rotação > 90 dias: ${pam.length}
${criticas.slice(0,5).map(v => `  [CRÍTICA] ${v.cve_id}: ${v.title} | CVSS ${v.cvss} | ativo: ${v.asset}`).join('\n')}
${pam.slice(0,3).map(a => `  [PAM] ${a.account}: ${a.rotation_days} dias sem rotação | ${a.system}`).join('\n')}`);
    }

    return parts.join('\n\n');
  }

  // ── Chamada à API Groq ────────────────────────────────────────────────────
  async function callGroq(question, data) {
    const resp = await fetch(GROQ_API_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${getKey()}`,
        'Content-Type':  'application/json'
      },
      body: JSON.stringify({
        model:       GROQ_MODEL,
        temperature: 0.3,
        max_tokens:  900,
        messages: [
          { role: 'system', content: buildSystem() },
          { role: 'user',   content:
              `DADOS DO HUB GOV TI v2 (tempo real — ${new Date().toLocaleString('pt-BR')}):\n\n` +
              summarize(data) +
              `\n\n---\nPERGUNTA: ${question}`
          }
        ]
      })
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      const msg = err.error?.message || `HTTP ${resp.status}`;
      if (resp.status === 401) throw new Error('Chave Groq inválida ou expirada — ' + msg);
      throw new Error('Groq API: ' + msg);
    }

    const json = await resp.json();
    return json.choices?.[0]?.message?.content?.trim() || '(sem resposta)';
  }

  // ── Renderiza markdown simples em HTML ────────────────────────────────────
  function md2html(text) {
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')  // escape primeiro
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g,     '<em>$1</em>')
      .replace(/^#{1,3} (.+)$/gm,'<h5 style="margin:10px 0 4px">$1</h5>')
      .replace(/^[-•] (.+)$/gm,  '<li>$1</li>')
      .replace(/(<li>[\s\S]*?<\/li>\n?)+/g, s => `<ul style="padding-left:1.2em;margin:6px 0">${s}</ul>`)
      .replace(/\n{2,}/g, '</p><p style="margin:6px 0">')
      .replace(/\n/g, '<br>');
  }

  // ── Override principal: askCopilot ────────────────────────────────────────
  window.askCopilot = async function (q) {
    if (!q || !q.trim()) return;
    q = q.trim();

    // Garantir chave Groq
    if (!getKey()) {
      const k = promptKey();
      if (!k) return;
    }

    const box = document.getElementById('copilotAnswers');
    if (!box) return;

    // Placeholder "pensando"
    const uid = 'cp_' + Date.now();
    box.insertAdjacentHTML('afterbegin', `
      <div id="${uid}" class="copilot-answer" style="min-height:60px">
        <div style="display:flex;align-items:center;gap:10px;color:var(--text-2);font-size:.85rem">
          <div class="groq-spin"></div>
          <span>Consultando dados e acionando Groq IA…</span>
        </div>
        <div style="font-size:.78rem;color:var(--text-3,#8b949e);margin-top:4px">
          "${q.replace(/&/g,'&amp;').replace(/</g,'&lt;')}"
        </div>
      </div>`);

    const inp = document.getElementById('copilotInput');
    if (inp) inp.value = '';

    try {
      const data   = await collectData(q);
      const answer = await callGroq(q, data);

      document.getElementById(uid).innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
          <span>🤖 <strong>Copilot IA</strong></span>
          <span style="font-size:.7rem;background:var(--surface-2,#21262d);color:var(--text-2);
                       padding:2px 8px;border-radius:20px;font-family:monospace">
            Groq · ${GROQ_MODEL}
          </span>
        </div>
        <div style="line-height:1.65">${md2html(answer)}</div>
        <div style="margin-top:10px;font-size:.73rem;color:var(--text-2)">
          Gerado em ${new Date().toLocaleTimeString('pt-BR')} com dados em tempo real
          &nbsp;·&nbsp;
          <a href="#" onclick="localStorage.removeItem('${LS_KEY}');
                               alert('Chave Groq removida. Próxima pergunta vai pedir uma nova.');
                               return false;"
             style="color:var(--text-2)">🔑 trocar chave</a>
        </div>`;
    } catch (err) {
      const isKey = /401|inválida|invalid|api key/i.test(err.message);
      document.getElementById(uid).innerHTML = `
        <div style="color:var(--red,#f85149)">
          ⚠️ <strong>Erro no Copilot:</strong> ${err.message}
        </div>
        ${isKey ? `<p style="margin-top:6px"><a href="#"
          onclick="localStorage.removeItem('${LS_KEY}');
                   askCopilot(${JSON.stringify(q)});
                   return false;"
          style="color:var(--blue,#58a6ff)">🔑 Reconfigurar chave Groq e tentar novamente</a></p>` : ''}`;
    }
  };

  // ── Estilos do spinner ────────────────────────────────────────────────────
  const css = document.createElement('style');
  css.textContent = `
    .groq-spin {
      width:14px; height:14px; flex-shrink:0;
      border:2px solid var(--border,#30363d);
      border-top-color:var(--blue,#58a6ff);
      border-radius:50%;
      animation:groq-rotate .7s linear infinite;
    }
    @keyframes groq-rotate { to { transform:rotate(360deg); } }
  `;
  document.head.appendChild(css);

  console.log('✅ groq-copilot.js carregado — Copilot IA com Groq ativo');
})();
