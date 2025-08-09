'use strict';

// --- dependências ---
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require("socket.io");
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const { Redis } = require('@upstash/redis');
const fs = require('fs/promises');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const AdmZip = require('adm-zip');

// --- ajustes de ambiente ---
process.env.CHROME_LOG_FILE = path.join(os.tmpdir(), 'wweb_chrome_debug.log');
try { require('punycode'); } catch (_) { /* shim opcional */ }
const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 21) {
  console.warn(`Node.js v${process.versions.node} detectado. O aviso sobre punycode é esperado.`);
}

// chalk para logs com fallback
let chalk;
try {
  chalk = require('chalk');
  if (chalk && chalk.default) chalk = chalk.default;
} catch (_) {
  chalk = { red: s => s, green: s => s, yellow: s => s, blueBright: s => s, magenta: s => s, cyan: s => s, gray: s => s };
}

// --- PONTO DE ENTRADA E SERVIDOR WEB COM STATUS EM TEMPO REAL ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

let progressState = {
    currentActivity: "Aguardando início do servidor...",
    steps: [
        { id: 'server', text: 'Iniciar Servidor Web', status: 'pending' },
        { id: 'api', text: 'Acordar API de IA', status: 'pending' },
        { id: 'redis', text: 'Conectar ao Redis', status: 'pending' },
        { id: 'session', text: 'Verificar Sessão do WhatsApp', status: 'pending' },
        { id: 'whatsapp', text: 'Conectar ao WhatsApp', status: 'pending' },
        { id: 'ready', text: 'Bot Pronto e Online', status: 'pending' },
    ]
};

function updateProgress(stepId, status, activityText) {
    console.log(chalk.cyan(`[PROGRESS] → Etapa: ${stepId}, Status: ${status}, Atividade: ${activityText || ''}`));
    const step = progressState.steps.find(s => s.id === stepId);
    if (step) { step.status = status; }
    if (activityText) { progressState.currentActivity = activityText; }
    if (status === 'error') {
        const readyStep = progressState.steps.find(s => s.id === 'ready');
        if(readyStep) readyStep.status = 'error';
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
            checklist.innerHTML = '';
            state.steps.forEach(step => {
                const li = document.createElement('li');
                li.className = 'step ' + step.status;
                li.innerHTML = \`<div class="step-icon">\${ICONS[step.status]}</div><span class="step-text">\${step.text}</span>\`;
                checklist.appendChild(li);
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

app.get('/', (req, res) => {
    res.send(statusPageHtml);
});
io.on('connection', (socket) => {
    socket.emit('history', progressState);
});

// --- configurações do bot ---
const UPSTASH_REDIS_REST_URL = 'https://humorous-koi-8598.upstash.io';
const UPSTASH_REDIS_REST_TOKEN = 'ASGWAAIjcDFiNWQ0MmRiZjIxODg0ZTdkYWYxMzQ0N2QxYTBhZTc0YnAxMA';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://myopenrouter.onrender.com/api/v1';
const MODEL = 'deepseek/deepseek-r1-0528:free';
const SKIP_CLASSIFICATION = !!process.env.SKIP_CLASSIFICATION;
const USE_LOCAL_HEURISTIC = process.env.USE_LOCAL_HEURISTIC !== '0';
const conversationHistory = {};
let coldStart = true;
const systemMessage = `
---
# INSTRUÇÕES DE COMPORTAMENTO
- Você é um assistente virtual, o avatar de Anderson Xavier. Responda em primeira pessoa, de forma objetiva e descontraída, sempre em português do Brasil.
- **NÃO se apresente ou mencione seu currículo, a menos que seja a primeira mensagem da conversa ou se o usuário perguntar explicitamente quem você é ou o que sabe fazer.**
- Mantenha o fluxo da conversa. Use o histórico de mensagens para entender o contexto e dar respostas coerentes, evitando repetições.
- Se o usuário fizer uma pergunta genérica ou social (ex: "tudo bem?"), responda de forma curta e natural sem se apresentar.
- Use o nome do usuário para criar uma conversa mais pessoal.
- Se alguém fizer piadas, responda com bom humor e ironia.
- **PROIBIDO:** Não forneça exemplos de código, trechos \`\`\`, ou comandos de terminal, a menos que o usuário peça explicitamente por isso.

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
---
`;

async function wakeUpApi() {
  updateProgress('api', 'running', 'Enviando "ping" para acordar a API de IA...');
  const apiRootUrl = OPENROUTER_BASE_URL.replace('/api/v1', '');
  try {
    await axios.get(apiRootUrl, { timeout: 8000 });
    updateProgress('api', 'success', 'API de IA acordada com sucesso.');
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      updateProgress('api', 'success', 'API de IA está acordando (timeout normal).');
    } else {
      updateProgress('api', 'error', `Falha ao acordar API: ${error.message}`);
      throw new Error('Falha ao acordar API.');
    }
  }
}

function getFormattedMessages(history) {
  return history.map(m => ({ role: m.role, content: m.content }));
}

function buildContextSnippet(history, maxMessages = 3) {
  if (!history || history.length === 0) {
    return '';
  }
  const userMsgs = history.filter(m => m.role === 'user');
  const last = userMsgs.slice(-maxMessages);
  return last.map(m => m.content).join(' | ');
}

async function analyzeIfMessageIsForAI(text, contextSnippet = '') {
  if (SKIP_CLASSIFICATION) {
    console.log(chalk.yellow('→ SKIP_CLASSIFICATION ativo: respondendo sem análise.'));
    return true;
  }
  try {
    console.log(chalk.magenta('→ Classificando se mensagem é para a IA...'));
    const classificationPrompt = `
Você é um classificador binário. Responda apenas "SIM" ou "NÃO".
Considere que a mensagem é para a IA quando:
• O texto menciona: "IA do Anderson", "Anderson bot", "bot do Anderson", "Apelido IA" (case-insensitive) OU
• Pelo contexto recente (abaixo) fica claro que o usuário está falando com a IA.
Contexto recente: "${contextSnippet}"
Mensagem: "${text}"
`;
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model: MODEL,
        temperature: 0,
        messages: [{ role: 'user', content: classificationPrompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 15000,
      }
    );
    const resultRaw = response.data.choices?.[0]?.message?.content || '';
    console.log(chalk.magenta(`   Classificador retornou: "${resultRaw.replace(/\n/g, ' ')}"`));
    return /^sim$/i.test(resultRaw.trim());
  } catch (error) {
    console.error(chalk.red('Erro ao classificar mensagem:'), error.response?.data || error.message || error);
    return false;
  }
}

async function processMessage(text, sessionKey, userName, chatName) {
  try {
    console.log(chalk.cyan(`→ processMessage para sessão ${sessionKey} (${userName})`));
    if (!conversationHistory[sessionKey]) {
      conversationHistory[sessionKey] = { name: userName, history: [] };
    }
    conversationHistory[sessionKey].history.push({ role: 'user', content: text });
    if (conversationHistory[sessionKey].history.length > 10) {
      conversationHistory[sessionKey].history.shift();
    }
    const userDescriptor = chatName ? `${userName} (no grupo "${chatName}")` : userName;
    const messages = [
      { role: 'system', content: systemMessage },
      { role: 'system', content: `Nome do usuário: ${userDescriptor}` },
      ...getFormattedMessages(conversationHistory[sessionKey].history),
    ];
    console.log(chalk.cyan('   Enviando requisição para OpenRouter...'));
    const response = await axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      {
        model: MODEL,
        messages: messages,
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 20000,
      }
    );
    let reply = response.data.choices?.[0]?.message?.content?.trim() || '';
    console.log(chalk.cyan(`   OpenRouter respondeu (bruto): "${reply}"`));
    return reply;
  } catch (error) {
    console.error(chalk.red('Erro ao processar mensagem:'), error.response?.data || error.message || error);
    return 'Desculpe, não consegui processar sua mensagem.';
  }
}

// --- Classe de armazenamento customizada com filtro de “lixo” ---
const JUNK_DIRS = [
  /^IndexedDB\//,
  /^Service Worker\//,
  /^Cache\//,
  /^GPUCache\//,
  /^Code Cache\//,
  /^databases\//,
  /^Storage\//,
  /^QuotaManager\//,
];

class UpstashRedisStore {
    constructor({ url, token }) {
        this.redis = new Redis({ url, token });
    }

    async sessionExists({ session }) {
        const v = await this.redis.get(`remoteauth:${session}`);
        return v !== null;
    }

    async save({ session }) {
        const zipPath = `${session}.zip`;
        // 1. Lê o ZIP gerado pelo RemoteAuth
        const originalZip = new AdmZip(zipPath);
        // 2. Cria um ZIP “clean” copiando só os arquivos essenciais
        const cleanZip = new AdmZip();
        originalZip.getEntries().forEach(entry => {
            if (!JUNK_DIRS.some(rx => rx.test(entry.entryName))) {
                cleanZip.addFile(entry.entryName, entry.getData());
            }
        });
        // 3. Serializa e salva no Redis em base64
        const buf = cleanZip.toBuffer();
        const b64 = buf.toString('base64');
        await this.redis.set(`remoteauth:${session}`, b64);
    }

    async extract({ session, path }) {
        const b64 = await this.redis.get(`remoteauth:${session}`);
        if (b64) {
            await fs.writeFile(`${session}.zip`, Buffer.from(b64, 'base64'));
        }
    }

    async delete({ session }) {
        await this.redis.del(`remoteauth:${session}`);
    }
}

async function createClient(usePinned) {
  let authStrategy;
  
  updateProgress('redis', 'running', 'Conectando ao banco de dados Redis...');
  try {
    const store = new UpstashRedisStore({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
    await store.redis.ping();
    authStrategy = new RemoteAuth({ clientId: 'anderson-bot', store, backupSyncIntervalMs: 120000 });
    updateProgress('redis', 'success', 'Conexão com Redis estabelecida.');
  } catch (e) {
    updateProgress('redis', 'error', `Falha ao conectar ao Redis: ${e.message}`);
    throw new Error("Falha na conexão com o Redis.");
  }

  const client = new Client({
    authStrategy,
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    webVersionCache: usePinned ? { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' } : undefined,
  });

  updateProgress('session', 'running', 'Verificando se existe sessão salva...');
  if (await authStrategy.store.sessionExists({session: 'anderson-bot'})) {
      updateProgress('session', 'success', 'Sessão encontrada! Iniciando restauração...');
  } else {
      updateProgress('session', 'success', 'Nenhuma sessão encontrada. Prepare-se para escanear o QR Code.');
  }

  client.on('qr', (qr) => {
    updateProgress('whatsapp', 'running', 'QR Code gerado! Escaneie no seu celular para continuar.');
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    updateProgress('ready', 'success', 'Bot conectado e totalmente operacional!');
    console.log(chalk.green('Client is ready!'));
  });

  client.on('auth_failure', (msg) => {
    updateProgress('whatsapp', 'error', `Falha na autenticação: ${msg}`);
  });
  
  client.on('disconnected', (reason) => {
    updateProgress('ready', 'error', `Bot desconectado: ${reason}`);
  });

  client.on('message', async (message) => {
    try {
      if (message.body === '!ping') {
        await message.reply('pong!');
        return;
      }
      if (coldStart) {
        await message.reply('⚙️ Servidor carregado. Estou pronto!');
        coldStart = false;
      }
      
      const chat = await message.getChat();
      const contact = await message.getContact();
      const userName = contact.pushname || contact.verifiedName || message.from;
      const chatId = message.from;
      const userId = message.author || chatId;
      const sessionKey = `${chatId}:${userId}`;

      let shouldRespond = false;
      if (!chat.isGroup) {
        shouldRespond = true;
      } else {
        const context = buildContextSnippet(conversationHistory[sessionKey]?.history);
        shouldRespond = await analyzeIfMessageIsForAI(message.body, context);
      }

      if (shouldRespond) {
        const responseMessage = await processMessage(message.body, sessionKey, userName, chat.name);
        
        if (chat.isGroup) {
          const chat_id = chat.id._serialized;
          await client.sendMessage(chat_id, `@${contact.id.user} ${responseMessage}`, { mentions: [contact] });
        } else {
          await message.reply(responseMessage);
        }
      }
    } catch (err) {
      console.error(chalk.red('⚠ Erro no handler de mensagem:'), err);
      try {
          await message.reply('Desculpe, ocorreu um erro ao processar sua mensagem.');
      } catch (_) {}
    }
  });

  updateProgress('whatsapp', 'running', 'Inicializando conexão com o WhatsApp...');
  try {
    await client.initialize();
    updateProgress('whatsapp', 'success', 'Cliente WhatsApp inicializado.');
  } catch (err) {
    updateProgress('whatsapp', 'error', `Falha ao inicializar: ${err.message}`);
    throw err;
  }
  return client;
}

// --- LÓGICA DE INICIALIZAÇÃO ---
server.listen(PORT, async () => {
    updateProgress('server', 'success', 'Servidor web iniciado e aguardando o bot...');
    console.log(chalk.green(`Servidor rodando na porta ${PORT}.`));
    
    try {
      await wakeUpApi();
      await createClient(true);
    } catch (e) {
      console.error(chalk.red(e));
    }
});
