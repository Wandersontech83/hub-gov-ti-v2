# 🏛️ HUB GOV TI v2 CLOUD — 100% gratuito (Supabase + GitHub Pages)

Mesma interface e funcionalidades do `hub_gov_ti_v2`, mas **sem servidor próprio**:
o banco é o **Supabase (free tier)** que vocês já usam no financeiro-pessoal, e a
hospedagem é o **GitHub Pages**. Custo: **R$ 0,00**.

```
Navegador (GitHub Pages) ──► Supabase PostgreSQL (free tier)
        ▲                          ▲
   Visualizador: leitura      N8N: escreve via REST
   Admin: login Supabase Auth
```

## 🚀 Colocar no ar (3 passos, ~10 minutos)

### 1. Criar as tabelas — rode o `setup.sql`

1. Abra o painel do Supabase → projeto (o mesmo do financeiro) → **SQL Editor** → **New query**
2. Cole todo o conteúdo de [`setup.sql`](setup.sql) e clique **Run**
3. Deve aparecer `Seed aplicado com sucesso ✓` — 19 tabelas `hub_*` criadas com dados de demonstração
   (convivem em paz com as tabelas `contas`/`salarios` do financeiro)

O script é seguro de rodar duas vezes: o seed só executa se as tabelas estiverem vazias.

### 2. Criar o usuário Admin

1. Painel Supabase → **Authentication** → **Users** → **Add user** → **Create new user**
2. E-mail: `wanderson@cyberecords.com.br` · Senha: a sua senha pessoal (mín. 8 caracteres)
3. Marque **Auto Confirm User** ✓
4. Em **Authentication → URL Configuration**, defina o **Site URL** como a URL do
   GitHub Pages (ex.: `https://SEU_USUARIO.github.io/hub-gov-ti-v2/`) — é para onde
   o link de redefinição de senha redireciona

> O e-mail fica fixo em `ADMIN_EMAIL` no [`supabase-config.js`](supabase-config.js);
> no portal, o login pede **só a senha**.

**Trocar senha com validação por e-mail:** botão 🔁 no modal de login (ou em
⚙️ Configurações). O Supabase envia gratuitamente um link de redefinição para
`wanderson@cyberecords.com.br`; ao clicar, você volta ao portal e define a nova senha.

### 3. Publicar no GitHub Pages

```bash
# dentro da pasta hub_gov_ti_v2_cloud
git init
git add .
git commit -m "HUB GOV TI v2 Cloud"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/hub-gov-ti-v2.git
git push -u origin main
```

Depois: repositório → **Settings → Pages → Branch: main / (root) → Save**.
Em ~1 minuto: `https://SEU_USUARIO.github.io/hub-gov-ti-v2/`

Para testar localmente antes: `python -m http.server 8080` na pasta e abra `http://localhost:8080`.

## 👥 Acessos

| Perfil | Como | O que pode |
|---|---|---|
| **Visualizador** | abre a URL | tudo somente leitura (RLS bloqueia escrita no banco) |
| **Admin** | 🔐 Admin → senha | criar/editar registros, módulos, N8N, exportações |

- Sessão admin expira após **15 min sem atividade**; bloqueio de **5 tentativas → 15 min**
- A escrita é protegida **no banco** (políticas RLS): mesmo alguém lendo o código-fonte
  não consegue gravar sem autenticar no Supabase Auth

## ⚡ N8N (também gratuito — self-hosted ou trial)

**Portal → N8N (saída):** configure a URL base em ⚙️ Configurações. Os botões "⚡ Disparar"
chamam `https://seu-n8n/webhook/<workflow>`. No nó Webhook do N8N, habilite CORS
(Allowed Origins: a URL do GitHub Pages) para o navegador conseguir chamar.

**N8N → Portal (entrada):** o N8N grava direto no Supabase com um nó HTTP Request:

```
POST https://eqvyklhrpkooytykebmu.supabase.co/rest/v1/hub_incidents
Headers:
  apikey: <service_role key>          ← painel: Settings → API (NUNCA no frontend)
  Authorization: Bearer <service_role key>
  Content-Type: application/json
  Prefer: resolution=merge-duplicates     ← upsert pela chave primária
Body:
  [{ "id": "INC-5001", "title": "Novo via N8N", "priority": "P2", "status": "Aberto" }]
```

Tabelas disponíveis: `hub_incidents`, `hub_contracts`, `hub_risks`, `hub_data_sources` etc.

## 💸 Limites do plano gratuito (e por que não doem)

| Limite Supabase free | Este portal usa |
|---|---|
| 500 MB de banco | ~2 MB com o seed completo |
| 5 GB de tráfego/mês | dashboards leves, JSON pequeno |
| Pausa após ~1 semana sem uso | abra o painel ou o portal 1×/semana; reativa em segundos |
| 50k usuários auth/mês | 1 admin |

GitHub Pages: gratuito para repositórios públicos, 100 GB de banda/mês.

## 🔁 Relação com o hub_gov_ti_v2 (versão Node/SQLite)

A pasta `hub_gov_ti_v2` continua funcionando como versão **local/servidor interno**
(dados ficam na sua máquina). As duas compartilham o mesmo frontend — esta versão
apenas troca o `api()` por um adaptador Supabase ([`supabase-api.js`](supabase-api.js)).
Correções de interface podem ser copiadas de uma para a outra.
