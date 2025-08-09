'use strict';

/**
 * WhatsApp bot + OpenRouter
 * - Contexto: em MEMÓRIA (por sessão). Some se o processo reiniciar.
 * - Redis: APENAS para salvar/restaurar login (RemoteAuth) com chunking.
 * - Grupos: responde quando faz sentido (menção ao bot, reply ao bot, gatilhos "ia", "bot", prefixos !,/,#).
 */

const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { Redis } = require('@upstash/redis');
const fs = require('fs/promises');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const AdmZip = require('adm-zip');

// ===== Ambiente / logs =====
process.env.CHROME_LOG_FILE = path.join(os.tmpdir(), 'wweb_chrome_debug.log');
try { require('punycode'); } catch (_) { /* ok */ }
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 21) {
  console.warn(`Node.js v${process.versions.node} detectado. O aviso sobre punycode é esperado.`);
}

// chalk com fallback
let chalk;
try { chalk = require('chalk'); chalk = chalk?.default || chalk; }
catch { chalk = { red:s=>s, green:s=>s, yellow:s=>s, blueBright:s=>s, magenta:s=>s, cyan:s=>s, gray:s=>s }; }

// ===== Web UI de status (opcional) =====
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 10000;

let progressState = {
  currentActivity: "Aguardando início do servidor...",
  steps: [
    { id: 'server',   text: 'Iniciar Servidor Web',         status: 'pending' },
    { id: 'api',      text: 'Acordar API de IA',            status: 'pending' },
    { id: 'redis',    text: 'Conectar ao Redis',            status: 'pending' },
    { id: 'session',  text: 'Verificar Sessão do WhatsApp', status: 'pending' },
    { id: 'whatsapp', text: 'Conectar ao WhatsApp',         status: 'pending' },
    { id: 'ready',    text: 'Bot Pronto e Online',          status: 'pending' },
  ]
};

function updateProgress(stepId, status, activityText) {
  console.log(chalk.cyan(`[PROGRESS] → Etapa: ${stepId}, Status: ${status}, Atividade: ${activityText || ''}`));
  const step = progressState.steps.find(s => s.id === stepId);
  if (step) step.status = status;
  if (activityText) progressState.currentActivity = activityText;
  if (status === 'error') {
    const ready = progressState.steps.find(s => s.id === 'ready');
    if (ready) ready.status = 'error';
  }
  io.emit('progressUpdate', progressState);
}

const statusPageHtml = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Status do Bot</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@700&family=Roboto+Mono:wght@400&display=swap');
        :root { --c-bg: #0d1117; --c-text: #c9d1d9; --c-accent: #58a6ff; --c-success: #238636; --c-error: #da3633; --c-pending: #8b949e; --c-border: #30363d; --c-card: #161b22; }
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
        body { background-color: var(--c-bg); color: var(--c-text); font-family: 'Roboto Mono', monospace; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100vh; margin: 0; padding: 20px; box-sizing: border-box; }
        h1 { font-family: 'Montserrat', sans-serif; font-weight: 700; font-size: 4rem; color: var(--c-accent); margin: 0 0 40px 0; text-shadow: 0 0 10px rgba(88, 166, 255, 0.3); }
        #progress-checklist { list-style: none; padding: 0; margin: 0; width: 100%; max-width: 600px; }
        .step { display: flex; align-items: center; padding: 12px 0; font-size: 1.5rem; transition: all 0.3s ease; border-bottom: 1px solid var(--c-border); }
        .step:last-child { border-bottom: none; }
        .step-icon { width: 40px; height: 40px; margin-right: 20px; display: flex; align-items: center; justify-content: center; }
        .step-icon svg { width: 28px; height: 28px; }
        .step.pending { color: var(--c-pending); }
        .step.running { color: var(--c-accent); }
        .step.success { color: var(--c-success); }
        .step.error { color: var(--c-error); }
        #current-activity { font-size: 2rem; line-height: 1.4; margin-top: 40px; padding: 20px 30px; border-radius: 12px; background-color: var(--c-card); color: #fff; min-height: 50px; text-align: center; }
        @media (max-width: 768px) { h1 { font-size: 3rem; } .step { font-size: 1.2rem; } #current-activity { font-size: 1.5rem; } }
    </style>
</head>
<body>
    <h1>Bot Status</h1>
    <ul id="progress-checklist"></ul>
    <div id="current-activity">Aguardando conexão...</div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        const checklist = document.getElementById('progress-checklist');
        const activityDiv = document.getElementById('current-activity');
        const ICONS = { pending: '<svg fill="currentColor" viewBox="0 0 16 16"><path d="M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3z"/></svg>', running: '<svg style="animation: spin 1s linear infinite;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h5M20 20v-5h-5"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 9a8 8 0 0114.53-2.71A8 8 0 0115 20.97"/></svg>', success: '<svg fill="currentColor" viewBox="0 0 16 16"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zm-3.97-3.03a.75.75 0 0 0-1.08.022L7.477 9.417 5.384 7.323a.75.75 0 0 0-1.06 1.06L6.97 11.03a.75.75 0 0 0 1.079-.02l3.992-4.99a.75.75 0 0 0-.01-1.05z"/></svg>', error: '<svg fill="currentColor" viewBox="0 0 16 16"><path d="M16 8A8 8 0 1 1 0 8a8 8 0 0 1 16 0zM5.354 4.646a.5.5 0 1 0-.708.708L7.293 8l-2.647 2.646a.5.5 0 0 0 .708.708L8 8.707l2.646 2.647a.5.5 0 0 0 .708-.708L8.707 8l2.647-2.646a.5.5 0 0 0-.708-.708L8 7.293 5.354 4.646z"/></svg>' };
        function renderProgress(state) {
            const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html) e.innerHTML = html; return e; }
            const ul = el('ul'); ul.id = 'progress-checklist';
            checklist.replaceWith(ul);
            state.steps.forEach(step => {
                const li = el('li', 'step ' + step.status, '<div class="step-icon">' + ICONS[step.status] + '</div><span class="step-text">' + step.text + '</span>');
                ul.appendChild(li);
            });
            activityDiv.textContent = state.currentActivity;
        }
        socket.on('progressUpdate', renderProgress);
        socket.on('connect', () => { socket.emit('requestHistory'); });
        socket.on('history', (state) => { if (state && state.steps) { renderProgress(state); } });
    </script>
</body>
</html>
`;
app.get('/', (req,res)=>res.send(statusPageHtml));
io.on('connection', (socket)=>socket.emit('history', progressState));

// ===== Config (.env no Render) =====
// ⚠️ remova segredos hardcoded. use somente variáveis de ambiente.
const UPSTASH_REDIS_REST_URL = 'https://humorous-koi-8598.upstash.io';
const UPSTASH_REDIS_REST_TOKEN = 'ASGWAAIjcDFiNWQ0MmRiZjIxODg0ZTdkYWYxMzQ0N2QxYTBhZTc0YnAxMA';
const OPENROUTER_API_KEY       = process.env.OPENROUTER_API_KEY || 'xxx';
const OPENROUTER_BASE_URL      = process.env.OPENROUTER_BASE_URL || 'https://myopenrouter.onrender.com';
const MODEL                    = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-r1-0528:free';
const USE_LOCAL_HEURISTIC      = process.env.USE_LOCAL_HEURISTIC !== '0'; // on por padrão
const REMOTEAUTH_CLIENT_ID     = process.env.REMOTEAUTH_CLIENT_ID || 'anderson-bot';
const BACKUP_EVERY_MS          = Number(process.env.BACKUP_EVERY_MS || (10 * 60 * 1000)); // 10min
const MEM_HISTORY_COUNT        = Number(process.env.MEM_HISTORY_COUNT || 12); // nº de mensagens por sessão em memória

// ===== util: detectar caminho do Chrome =====
function getChromeExecutablePath() {
  // 1) se o postinstall setou PUPPETEER_EXECUTABLE_PATH, use-o
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;

  // 2) tente via puppeteer.executablePath()
  try {
    const puppeteer = require('puppeteer');
    const p = puppeteer.executablePath();
    if (p && typeof p === 'string') return p;
  } catch (_) {}

  // 3) último recurso: deixe null -> Puppeteer decide
  return null;
}

// ===== Prompt base =====
const systemMessage = `
# INSTRUÇÕES DE COMPORTAMENTO
- Você é um assistente virtual, o avatar de Anderson Xavier. Responda em primeira pessoa, de forma objetiva e descontraída, sempre em português do Brasil.
- **NÃO se apresente ou mencione seu currículo, a menos que seja a primeira mensagem da conversa ou se o usuário perguntar explicitamente quem você é ou o que sabe fazer.**
- Mantenha o fluxo da conversa. Use o histórico de mensagens para entender o contexto e dar respostas coerentes, evitando repetições.
- Se o usuário fizer uma pergunta genérica ou social (ex: "tudo bem?"), responda de forma curta e natural sem se apresentar.
- Use o nome do usuário para criar uma conversa mais pessoal.
- Se alguém fizer piadas, responda com bom humor e ironia.
- **PROIBIDO:** Não forneça exemplos de código, trechos \\\, ou comandos de terminal, a menos que o usuário peça explicitamente por isso.

# BASE DE CONHECIMENTO (Use apenas quando perguntarem sobre o Anderson)
- **Nome:** Anderson Xavier, 40 anos, casado, um filho (David). Reside em São Paulo-SP.
- **Contato:** andersonx1013@gmail.com, Fone/WhatsApp: (+55) 16 99740-5919.
- **Posição:** Arquiteto de Software e Líder Técnico com mais de 20 anos de experiência em TI.
- **Personalidade:** Perfeccionista e ansioso (defeitos); entusiasta e gosta de ajudar pessoas a crescer (qualidades).
- **Hobbies:** Estudar tecnologias, ver filmes com a família, jogar (Starcraft).
- **Preferências:** Gosta de pizza, arroz, feijão e ovo. Prefere backend a frontend.
- **Habilidades Principais:**
  - **Dev Full-Stack:** NodeJS, React, React Native, C# (.NET), Java, Python.
  - **Cloud & DevOps:** AWS, GCP, Azure, Docker, Kubernetes, CI/CD, Serverless.
  - **Bancos de Dados:** SQL Server, PostgreSQL, MongoDB, Neo4J, Oracle.
  - **IA & ML:** Python, R, TensorFlow, PyTorch, NLP, LangChain, Hugging Face.
  - **Segurança:** DevSecOps (Snyk, Trivy), Pentesting, IAM (OAuth, Keycloak), OWASP Top 10.
  - **Arquitetura & Metodologias:** Microservices (Hexagonal, EDA), SOA, Scrum, SAFE, Kanban.
- **Se não souber algo, diga que não tem a informação e forneça o contato dele.**

# Sobre a Startup Xbash
Slide 1: XBash

A XBash é uma plataforma que transforma a forma como as pessoas descobrem e vivem diversão, turismo e esportes. Em um cenário saturado de opções e informações genéricas, nós resolvemos um problema claro: como conectar pessoas às experiências que realmente combinam com seu estilo de vida?

O problema?
Hoje, quem busca lazer, viagem ou atividade esportiva precisa procurar em múltiplos sites — redes sociais, plataformas de eventos como a Sympla, agências de turismo, etc. Mas essas ferramentas são fragmentadas, impessoais e muitas vezes genéricas.

A solução da XBash?
Oferecemos uma experiência única e integrada. Com tecnologia de curadoria inteligente, a XBash entrega recomendações personalizadas de eventos, passeios, experiências turísticas e esportivas com base nos interesses reais dos usuários.

O que nos diferencia da Sympla, Eventbrite e bilheteiras eletrônicas?

Foco em experiência, não só em ingresso. Não somos apenas uma vitrine de eventos — somos um guia personalizado de vivências.

Abrangência tripla: diversão, turismo e esportes em um só lugar.

Comunidade e conexão: incentivamos a interação entre usuários que querem curtir juntos.

Recomendações inteligentes: usamos dados e comportamento para sugerir experiências relevantes, não uma lista aleatória.

Seja para curtir um show, fazer uma trilha, ir a um retiro ou participar de um campeonato, a XBash está com você — da descoberta à experiência.

XBash. Reinvente seu lazer. Viva experiências.

Slide 2: Revolucionando o Mercado

Nossa startup Xbash transformará a experiência em diversão, eventos e entretenimento ao introduzir uma plataforma inteligente e personalizada. Por meio de um algoritmo avançado de recomendação, aprendemos e nos adaptamos aos interesses individuais dos usuários, oferecendo sugestões precisas de eventos e locais alinhados às suas preferência.

Diferenciais Competitivos:

Personalização Avançada: Utilizamos inteligência artificial para analisar comportamentos e interesses, garantindo recomendações altamente personalizadas.

Integração Tecnológica: Incorpora tecnologias de ponta, como IA e Internet das Coisas (IoT), para proporcionar experiências de eventos imersivas e interativas. Com uma ferramenta própria para desenho de Crocs dos espaços de eventos e reservas.

Marketplace Completo:

Venda de Ingressos: Plataforma segura e eficiente para aquisição de ingressos, simplificando o processo de compra.

Aluguel de Espaços e Reservas: Conectamos organizadores a espaços ideais, otimizando a logística de eventos.

Marketing e Publicidade Geolocalizada: Oferecemos soluções de marketing que posicionam marcas diretamente no contexto urbano, aumentando a visibilidade e engajamento.

Análise de Dados para Parceiros: Fornecemos insights aprofundados para estabelecimentos parceiros, permitindo uma compreensão detalhada do público e otimização de ofertas.

Valorização da Cultura Local: Criamos uma comunidade vibrante que destaca negócios locais em nosso mapeamento interativo, enriquecendo a exploração urbana e fomentando a economia regional.

Benefícios para Usuários e Parceiros:

Usuários:

Experiências personalizadas e relevantes.

Facilidade na descoberta e aquisição de ingressos para eventos de interesse.

Interação com uma comunidade ativa e diversificada.

Parceiros Comerciais:

Acesso a ferramentas avançadas de marketing e análise de dados.

Ampliação do alcance e engajamento com o público-alvo.

Plataforma integrada para gestão de vendas e reservas.

Slide 3: Produtos

Nossos produtos serão (B2B e B2C)

Eventos e Entretenimento
a. Vendas de Ingressos
b. Aluguel de espaços
c. Reservas
d. Shows / Eventos / Teatros
e. Propaganda em mapa
f. Divulgação de marcas
g. Busca dinâmica em Realtime
h. Etc...

IA
a. Atendimento por IA
b. Recomendações por perfil

IOT (Para restaurantes para pedidos e reservas de mesas - pós mvp)

Vendas Online (Ingressos, Reservas e etc)

Concorrentes:

Sympla

Bilheteria Express

EventBrite

Uhuu

Ticketmaster

Etc...

Legenda:
Verde: Concorrentes comercializam
Vermelho: Concorrentes não comercializam

Nota: Estamos em fase de cálculo do ROI. Para isso precisamos do investimento.

Slide 4: Rendimento Eventbrite - Global

Concorrente com negócio similar (SOM)

Dados de Receita e Crescimento Anual da Eventbrite:
A receita da Eventbrite foi de 291,6 milhões de USD em 2018. Em 2019, cresceu 12,1% para 326,8 milhões. Em 2020, devido à pandemia, a receita caiu 67,6% para 106 milhões. A recuperação começou em 2021, com um crescimento de 76,5%, atingindo 187,1 milhões. Em 2022, a receita foi de 260,9 milhões, um aumento de 39,4%. Em 2023, a receita chegou a 326,13 milhões, com um crescimento de 25,0%.

Serviços oferecidos pela Eventbrite:

Eventos

Palestras

Shows

Teatros

Slide 5: Rendimento Eventbrite - Global

Simulação da EventBrite de 2006 a 2017 e valores reais atuais

Receita Projetada com base no crescimento Projetado:
https://www.macrotrends.net/stocks/charts/EB/eventbrite/revenue?utm_source=chatgpt.com

Tabela de Receita e Crescimento da Eventbrite (Valores Reais e Projetados):
Os dados de receita real da Eventbrite são os seguintes:

2023: 326,1 mi USD (+25%)

2022: 260,9 mi USD (+39,4%)

2021: 187,1 mi USD (+76,5%)

2020: 106 mi USD (-67,6%)

2019: 326,8 mi USD (+12,1%)

2018: 291,6 mi USD (+44%)

2017: 202,6 mi USD (+52,3%)

2016: 133 mi USD (+22%)

A empresa foi aberta em 2006, mas os valores concretos só surgiram com a abertura na Bolsa em 2016. As receitas de 2006 a 2015 são estimativas internas, para fins ilustrativos, aplicando uma taxa de crescimento anual composta (CAGR) de 22% retroativamente a partir do primeiro dado auditado de 133 milhões de USD em 2016.

2015: 109 mi USD (Projeção)

2014: 89,4 mi USD (Projeção)

2013: 73,2 mi USD (Projeção)

2012: 60 mi USD (Projeção)

2011: 49,2 mi USD (Projeção)

2010: 40,3 mi USD (Projeção)

2009: 33,1 mi USD (Projeção)

2008: 27,1 mi USD (Projeção)

2007: 22,2 mi USD (Projeção)

2006: 18,2 mi USD (Projeção)

Slide 6: Ramp-up

Simulação da EventBrite & Curvas de exemplo

Uma curva de captura de mercado foi construída com base em referências de mercado e bom senso, seguindo a progressão: 0,6% → 2% → 5% → 10% → 12% → 14% → 15,8%. Esses saltos correspondem a um crescimento de 100-200% ano a ano nos primeiros anos, desacelerando para cerca de 40% posteriormente, um padrão considerado saudável em pesquisas.

Como as fontes e restrições influenciam o ramp-up:

Fonte: Startups SaaS levam em média 2-3 anos para atingir 1 milhão de USD em receita recorrente anual (ARR).
Influência: Considerando o mercado total (TAM) da Eventbrite em 2006 como 18 milhões de USD, 1 milhão representa 5-6% desse mercado. Portanto, a curva de crescimento deve cruzar a faixa de 5-6% por volta do segundo ou terceiro ano.

Fonte: O crescimento médio de SaaS em estágio inicial é de 100-200% ao ano nos três primeiros anos, caindo para 40-60% depois.
Influência: Partindo de 0,11 milhão de USD no Ano 1, triplicar a receita no Ano 2 (para aproximadamente 0,44 milhão) e dobrar no Ano 3 (para cerca de 1,35 milhão) está alinhado com esses benchmarks.

Fonte: O objetivo é atingir um "pleno" de 15,8% de captura de mercado.
Influência: A projeção mantém uma subida suave para atingir 15,8% no Ano 7, evitando um crescimento lento demais (que perderia tração de investidores) ou brusco demais (que seria operacionalmente inacreditável).

Projeção de Crescimento da Startup:

Ano 1: Captura 0,6% do mercado, com receita de 0,11 milhão de USD.

Ano 2: Captura 2%, com receita de 0,44 milhão de USD (crescimento de 300%).

Ano 3: Captura 5%, com receita de 1,35 milhão de USD (crescimento de 207%).

Ano 4: Captura 10%, com receita de 3,31 milhões de USD (crescimento de 145%).

Ano 5: Captura 12%, com receita de 4,84 milhões de USD (crescimento de 46%).

Ano 6: Captura 14%, com receita de 6,89 milhões de USD (crescimento de 42%).

Ano 7: Captura 15,8%, com receita de 9,48 milhões de USD (crescimento de 38%).

Slide 7: Nossa Projeção da Eventbrite

Em caso de lançamento Brasil - Com Base na evolução bruta da EventBrite

População dos principais países atendidos pela Eventbrite:

Espanhol: Argentina (0,56%), Chile (0,24%), Colômbia (0,65%), Espanha (0,58%), México (1,60%), Peru (0,42%)

Inglês: Austrália (0,30%), Canadá (0,49%), Hong Kong (0,09%), Irlanda (0,07%), Nova Zelândia (0,06%), Singapura (0,07%), Reino Unido (0,84%), Estados Unidos (4,22%)

Holandês/Francês: Bélgica (0,14%), Canadá (0,49%)

Português: Brasil (2,59%), Portugal (0,13%)

Alemão: Alemanha (1,02%), Áustria (0,11%), Suíça (0,11%)

Italiano: Itália (0,72%)

Sueco: Suécia (0,13%)

Outros: Dinamarca (0,07%), Finlândia (0,07%), França (0,81%), Países Baixos (0,22%)

Primeiro, somamos as populações de todos os países atendidos pela Eventbrite. Esta soma é a população total dos países onde a Eventbrite opera. Em seguida, calculamos a porcentagem da população do Brasil em relação a esse total. A fórmula para isso é: Porcentagem do Brasil = (População do Brasil / População Total dos Países Eventbrite) * 100.
Com os números específicos: População do Brasil = 212.812.405; População Total dos Países Eventbrite = 1.344.893.985.
Aplicando a fórmula, a porcentagem do Brasil é de 15,83%, valor que aplicamos à projeção.

Evolução da receita da startup e Break-even:
A evolução da receita da nossa startup nos primeiros 7 anos é projetada da seguinte forma: começando com 110 mil USD no primeiro ano e chegando a quase 10 milhões de USD no sétimo ano. O percentual da receita global da Eventbrite que planejamos capturar começa em 0,6% e atinge 15,8% no ano 7, que representa nossa referência de mercado potencial proporcional ao Brasil. O ponto de break-even, quando a receita é suficiente para cobrir os custos fixos e operar de forma sustentável, é atingido no Ano 5 (possivelmente 6), com uma receita entre 4,8 e 6,89 milhões de USD.
`;

// ===== Ping leve para acordar a API =====
async function wakeUpApi() {
  updateProgress('api', 'running', 'Enviando "ping" para acordar a API de IA...');
  try {
    await axios.get(OPENROUTER_BASE_URL, { timeout: 8000 });
    updateProgress('api', 'success', 'API de IA acordada com sucesso.');
  } catch (e) {
    if (e.code === 'ECONNABORTED') {
      updateProgress('api', 'success', 'API de IA está acordando (timeout normal).');
    } else {
      updateProgress('api', 'error', `Falha ao acordar API: ${e.message}`);
      throw e;
    }
  }
}

// ===== Heurística local: quando responder no grupo =====
function localHeuristicForAI({ text, isGroup, selfId, mentionedIds = [], quotedFromMe = false }) {
  if (!isGroup) return true; // DM sempre responde
  if (!text) return false;
  if (selfId && Array.isArray(mentionedIds) && mentionedIds.includes(selfId)) return true; // menção direta
  if (quotedFromMe) return true; // reply a mensagem do bot
  const s = text.toLowerCase().trim();
  const triggers = [
    /^([!/#])/,                                  // prefixos
    /^(ia|ai|bot|assistente|gpt|chatgpt)[,:\s]/, // chamar pelo "papel"
    /\b(ia|bot|assistente|gpt|chatgpt)\b/,       // citar no meio
  ];
  return triggers.some(rx => rx.test(s));
}

// ===== Contexto em memória =====
const conversationHistory = {}; // { [sessionKey]: { name, history: [{role,content}], lastUpdated } }

function addToHistory(sessionKey, role, content) {
  if (!conversationHistory[sessionKey]) conversationHistory[sessionKey] = { name: '', history: [], lastUpdated: Date.now() };
  const h = conversationHistory[sessionKey].history;
  h.push({ role, content: String(content || '').slice(0, 4000) }); // corta msgs absurdas
  // mantém no máximo MEM_HISTORY_COUNT mensagens (user+assistant)
  while (h.length > MEM_HISTORY_COUNT) h.shift();
  conversationHistory[sessionKey].lastUpdated = Date.now();
}

function getFormattedMessages(historyArray) {
  return historyArray.map(m => ({ role: m.role, content: m.content }));
}

// ===== Chamada à IA (com contexto em memória) =====
async function processMessage(text, sessionKey, userName, chatName) {
  try {
    const sess = conversationHistory[sessionKey];
    const messages = [
      { role: 'system', content: systemMessage },
      { role: 'system', content: `Nome do usuário: ${chatName ? `${userName} (no grupo "${chatName}")` : userName}` },
      ...(sess ? getFormattedMessages(sess.history) : []),
      { role: 'user', content: text }
    ];
    const doCall = () => axios.post(
      `${OPENROUTER_BASE_URL}/api/v1/chat/completions`,
      { model: MODEL, messages },
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    let res;
    try { res = await doCall(); }
    catch { await new Promise(r=>setTimeout(r, 600)); res = await doCall(); }
    const reply = res.data.choices?.[0]?.message?.content?.trim() || 'Beleza! Pode mandar 🙂';
    return reply;
  } catch (err) {
    console.error(chalk.red('Erro ao processar mensagem:'), err.response?.data || err.message || err);
    return 'Desculpe, não consegui processar sua mensagem agora.';
  }
}

// ===== RemoteAuth Store (Redis) — apenas login, com chunking =====
const CHUNK_BYTES = 9 * 1024 * 1024; // ~9MB (limite Upstash ~10MB por req)
const JUNK_DIRS = [                   // reduz tamanho do zip salvo
  /^(Default\/)?IndexedDB\//,
  /^(Default\/)?Service Worker\//,
  /^(Default\/)?Cache\//,
  /^(Default\/)?GPUCache\//,
  /^(Default\/)?Code Cache\//,
  /^(Default\/)?databases\//,
  /^(Default\/)?Storage\//,
  /^(Default\/)?QuotaManager\//,
  /^(Default\/)?DawnCache\//,
  /^(Default\/)?GrShaderCache\//,
];

class UpstashRedisStore {
  constructor({ url, token }) {
    this.redis = new Redis({ url, token });
  }
  _monoKey(s)      { return `remoteauth:${s}`; }
  _metaKey(s)      { return `remoteauth:${s}:meta`; }
  _partKey(s, i)   { return `remoteauth:${s}:part:${i}`; }

  async sessionExists({ session }) {
    const [mono, meta] = await Promise.all([
      this.redis.get(this._monoKey(session)),
      this.redis.get(this._metaKey(session))
    ]);
    return mono !== null || meta !== null;
  }

  async save({ session }) {
    try {
      const zipPath = `${session}.zip`;
      const originalZip = new AdmZip(zipPath);

      // filtra lixo e reempacota
      const cleanZip = new AdmZip();
      originalZip.getEntries().forEach(e => {
        const n = e.entryName;
        if (!JUNK_DIRS.some(rx => rx.test(n))) cleanZip.addFile(n, e.getData());
      });

      const b64 = cleanZip.toBuffer().toString('base64');

      // limpa estado anterior
      const meta = await this.redis.get(this._metaKey(session));
      if (meta) {
        const { parts = 0 } = JSON.parse(meta);
        const delKeys = Array.from({length: parts}, (_,i)=>this._partKey(session,i));
        if (delKeys.length) await this.redis.del(...delKeys);
        await this.redis.del(this._metaKey(session));
      }
      await this.redis.del(this._monoKey(session));

      // decide mono vs chunked
      if (Buffer.byteLength(b64, 'utf8') < CHUNK_BYTES) {
        await this.redis.set(this._monoKey(session), b64);
        return;
      }
      const totalLen = b64.length;
      const parts = Math.ceil(totalLen / CHUNK_BYTES);
      for (let i=0;i<parts;i++) {
        const slice = b64.slice(i*CHUNK_BYTES, (i+1)*CHUNK_BYTES);
        await this.redis.set(this._partKey(session, i), slice);
      }
      await this.redis.set(this._metaKey(session), JSON.stringify({ parts, totalLen, ts: Date.now() }));
    } catch (e) {
      console.error('UpstashRedisStore.save falhou (sessão NÃO salva):', e?.message || e);
      // não lança para não derrubar o processo
    }
  }

  async extract({ session, path }) {
    const metaRaw = await this.redis.get(this._metaKey(session));
    if (metaRaw) {
      const { parts } = JSON.parse(metaRaw);
      let b64 = '';
      for (let i=0;i<parts;i++) {
        const frag = await this.redis.get(this._partKey(session, i));
        if (!frag) throw new Error(`Chunk ausente: ${i}/${parts}`);
        b64 += frag;
      }
      await fs.writeFile(path, Buffer.from(b64,'base64'));
      return;
    }
    const mono = await this.redis.get(this._monoKey(session));
    if (mono) await fs.writeFile(path, Buffer.from(mono,'base64'));
  }

  async delete({ session }) {
    const metaRaw = await this.redis.get(this._metaKey(session));
    if (metaRaw) {
      const { parts=0 } = JSON.parse(metaRaw);
      const delKeys = Array.from({length: parts}, (_,i)=>this._partKey(session,i));
      if (delKeys.length) await this.redis.del(...delKeys);
      await this.redis.del(this._metaKey(session));
    }
    await this.redis.del(this._monoKey(session));
  }
}

// ===== Inicialização do WhatsApp =====
let SELF_ID = null;
let coldStart = true;

async function createClient() {
  updateProgress('redis', 'running', 'Conectando ao banco de dados Redis...');
  let store;
  try {
    if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
      throw new Error('Variáveis UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN ausentes.');
    }
    store = new UpstashRedisStore({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
    await store.redis.ping();
    updateProgress('redis', 'success', 'Conexão com Redis estabelecida.');
  } catch (e) {
    updateProgress('redis', 'error', `Falha ao conectar ao Redis: ${e.message}`);
    throw e;
  }

  const execPath = getChromeExecutablePath();
  const puppeteerOpts = {
    headless: true,
    executablePath: execPath || undefined,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-features=TranslateUI',
      '--no-first-run',
      '--no-default-browser-check'
    ],
  };

  const authStrategy = new RemoteAuth({
    clientId: REMOTEAUTH_CLIENT_ID,
    store,
    backupSyncIntervalMs: BACKUP_EVERY_MS,
  });

  const client = new Client({
    authStrategy,
    authTimeoutMs: 60000,
    puppeteer: puppeteerOpts,
  });

  updateProgress('session', 'running', 'Verificando se existe sessão salva...');
  if (await store.sessionExists({ session: REMOTEAUTH_CLIENT_ID })) {
    updateProgress('session', 'success', 'Sessão encontrada! Iniciando restauração...');
  } else {
    updateProgress('session', 'success', 'Nenhuma sessão encontrada. Escaneie o QR quando aparecer.');
  }

  client.on('qr', (qr) => {
    updateProgress('whatsapp', 'running', 'QR Code gerado! Escaneie no seu celular para continuar.');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    SELF_ID = client.info?.wid?._serialized || null;
    updateProgress('ready', 'success', 'Bot conectado e totalmente operacional!');
    console.log(chalk.green('Client is ready!'), SELF_ID ? ` SELF_ID=${SELF_ID}` : '');
  });

  client.on('loading_screen', (percent, message) => {
    updateProgress('whatsapp', 'running', `Carregando WhatsApp (${percent}%) - ${message || ''}`);
  });

  client.on('auth_failure', (msg) => updateProgress('whatsapp', 'error', `Falha na autenticação: ${msg}`));
  client.on('disconnected', (reason) => updateProgress('ready', 'error', `Bot desconectado: ${reason}`));

  client.on('message', async (message) => {
    try {
      if (message.body === '!ping') { await message.reply('pong!'); return; }

      const chat = await message.getChat();
      const contact = await message.getContact();
      const userName = contact.pushname || contact.verifiedName || message.from;
      const chatId = message.from;
      const userId = message.author || chatId; // em grupo, author; em DM, o próprio chat
      const sessionKey = `${chatId}:${userId}`;

      // cria sessão de histórico em memória
      if (!conversationHistory[sessionKey]) {
        conversationHistory[sessionKey] = { name: userName, history: [], lastUpdated: Date.now() };
      }

      // Heurística rápida (sem classificador LLM)
      const isGroup = chat.isGroup;
      const mentionedIds = message.mentionedIds || [];
      let quotedFromMe = false;
      if (message.hasQuotedMsg) {
        try { const quoted = await message.getQuotedMessage(); quotedFromMe = !!quoted?.fromMe; } catch {}
      }
      const shouldRespond = USE_LOCAL_HEURISTIC && localHeuristicForAI({
        text: message.body,
        isGroup,
        selfId: SELF_ID,
        mentionedIds,
        quotedFromMe
      });

      // Cold start só fala quando fizer sentido
      if (coldStart && (!isGroup || shouldRespond)) {
        await (isGroup ? client.sendMessage(chat.id._serialized, '⚙️ Servidor carregado. Estou pronto!') : message.reply('⚙️ Servidor carregado. Estou pronto!'));
        coldStart = false;
      }

      // Atualiza histórico e responde quando aplicável
      addToHistory(sessionKey, 'user', message.body);

      if (!isGroup || shouldRespond) {
        const reply = await processMessage(message.body, sessionKey, userName, chat.name);
        addToHistory(sessionKey, 'assistant', reply);

        if (isGroup) {
          // ✅ usar WIDs em "mentions" (strings), sem passar Contact (evita warning deprecatado)
          await client.sendMessage(
            chat.id._serialized,
            `@${contact.id.user} ${reply}`,
            { mentions: [contact.id._serialized] }
          );
        } else {
          await message.reply(reply);
        }
      }
    } catch (err) {
      console.error(chalk.red('⚠ Erro no handler de mensagem:'), err);
      try { await message.reply('Desculpe, ocorreu um erro ao processar sua mensagem.'); } catch {}
    }
  });

  // Inicialização com pequeno retry para lidar com reload de contexto do WhatsApp Web
  updateProgress('whatsapp', 'running', 'Inicializando conexão com o WhatsApp...');
  const MAX_TRIES = 2;
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    try {
      await client.initialize();
      updateProgress('whatsapp', 'success', 'Cliente WhatsApp inicializado.');
      break;
    } catch (err) {
      const msg = String(err?.message || err);
      const isCtxDestroyed = /Execution context was destroyed/i.test(msg);
      if (attempt < MAX_TRIES && isCtxDestroyed) {
        console.warn(chalk.yellow(`[Init Attempt ${attempt}] Context destroyed; tentando novamente em 1s...`));
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      updateProgress('whatsapp', 'error', `Falha ao inicializar: ${msg}`);
      throw err;
    }
  }

  return client;
}

// ===== Boot =====
server.listen(PORT, async () => {
  updateProgress('server', 'success', 'Servidor web iniciado e aguardando o bot...');
  console.log(chalk.green(`Servidor rodando na porta ${PORT}.`));

  // logs úteis pra troubleshoot
  process.on('unhandledRejection', (reason) => console.error('unhandledRejection:', reason));
  process.on('uncaughtException', (err) => console.error('uncaughtException:', err));

  try {
    await wakeUpApi();
    await createClient();
  } catch (e) {
    console.error(chalk.red(e));
  }
});
