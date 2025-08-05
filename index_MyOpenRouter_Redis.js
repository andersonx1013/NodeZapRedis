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

let statusLog = ["Aguardando início do servidor..."];

function emitStatus(message) {
  console.log(chalk.cyan(`[STATUS WEB] → ${message}`));
  statusLog.push(message);
  if (statusLog.length > 20) {
      statusLog.shift();
  }
  io.emit('statusUpdate', message);
}

// --- PÁGINA HTML COM CSS PARA FONTES GRANDES ---
const statusPageHtml = `
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Status do Bot</title>
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@700&family=Roboto+Mono:wght@400&display=swap');
        body {
            background-color: #0d1117;
            color: #c9d1d9;
            font-family: 'Roboto Mono', monospace;
            display: flex;
            justify-content: center;
            align-items: center;
            height: 100vh;
            margin: 0;
            padding: 15px;
            box-sizing: border-box;
            text-align: center;
        }
        .container {
            max-width: 1200px;
            width: 100%;
        }
        h1 {
            font-family: 'Montserrat', sans-serif;
            font-weight: 700;
            font-size: 5rem;
            color: #58a6ff;
            margin-bottom: 40px;
            text-shadow: 0 0 10px rgba(88, 166, 255, 0.3);
        }
        #status-message {
            font-size: 3rem;
            line-height: 1.4;
            background-color: #161b22;
            padding: 40px;
            border-radius: 12px;
            border-left: 8px solid #3fb950;
            min-height: 100px;
            word-wrap: break-word;
            transition: all 0.3s ease;
        }
        #status-message.error {
            border-left-color: #f85149;
        }
        #status-message.ready {
            border-left-color: #a371f7;
            color: #fff;
        }
        @media (max-width: 768px) {
            h1 { font-size: 3.5rem; }
            #status-message { font-size: 2rem; padding: 25px; }
        }
        @media (max-width: 480px) {
            h1 { font-size: 2.5rem; }
            #status-message { font-size: 1.5rem; }
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Bot Status</h1>
        <div id="status-message">Conectando...</div>
    </div>
    <script src="/socket.io/socket.io.js"></script>
    <script>
        const socket = io();
        const statusDiv = document.getElementById('status-message');
        socket.on('statusUpdate', (message) => {
            statusDiv.textContent = message;
            statusDiv.classList.remove('error', 'ready');
            const lowerCaseMessage = message.toLowerCase();
            if (lowerCaseMessage.includes('erro') || lowerCaseMessage.includes('falha')) {
                statusDiv.classList.add('error');
            } else if (lowerCaseMessage.includes('pronto e online') || lowerCaseMessage.includes('operacional')) {
                statusDiv.classList.add('ready');
            }
        });
        socket.on('connect', () => { socket.emit('requestHistory'); });
        socket.on('history', (history) => {
             if (history && history.length > 0) {
                 statusDiv.textContent = history[history.length - 1];
             }
        });
    </script>
</body>
</html>
`;
app.get('/', (req, res) => {
    res.send(statusPageHtml);
});

io.on('connection', (socket) => {
  socket.on('requestHistory', () => {
      socket.emit('history', statusLog);
  });
  socket.emit('history', statusLog);
});


// --- configurações do bot ---
const UPSTASH_REDIS_REST_URL = 'https://humorous-koi-8598.upstash.io';
const UPSTASH_REDIS_REST_TOKEN = 'ASGWAAIjcDFiNWQ0MmRiZjIxODg0ZTdkYWYxMzQ0N2QxYTBhZTc0YnAxMA';
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://myopenrouter.onrender.com/api/v1';
const MODEL = 'qwen/qwen3-coder:free';
const SKIP_CLASSIFICATION = !!process.env.SKIP_CLASSIFICATION;
const USE_LOCAL_HEURISTIC = process.env.USE_LOCAL_HEURISTIC !== '0';
const conversationHistory = {};
let coldStart = true;
const systemMessage = `
🚫 NÃO forneça exemplos de código, trechos \`\`\`, comandos de terminal ou descrições técnicas de programação, a menos que o usuário peça explicitamente. Quando o assunto for programação sem pedido de código, responda em linguagem natural, sem mostrar sintaxe. Remova qualquer bloco de código se o usuário não solicitou.

Responderei somente o que o usuário quer saber de forma objetiva e descontraída e em primeira pessoa, sempre em português brasileiro. Se o usuário pedir para trocar o idioma, você pode falar em outro. Direi informações sobre o CV somente se o usuário perguntar. Só responderei coisas relacionadas ao meu currículo. Eu fui criado pelo Anderson. Eu sou o avatar de Anderson Xavier. Tenho 40 anos. Residente em São Paulo - SP, Brasil. Tenho mais de 20 anos de experiência no mercado de TI, atuando de forma multidisciplinar em processos e tecnologias. Meu contato é andersonx1013@gmail.com e (+55)16 99740-5919 (Business). Atuo como Arquiteto de Software e Líder Técnico, com vasta experiência em desenvolvimento de software e serviços, abrangendo desde o design até a implementação e otimização do ciclo de vida completo. Minhas principais habilidades técnicas incluem desenvolvimento web e mobile com NodeJS, React, React Native, JavaScript, C# (.NET Core e Desktop), Razor, WebForms, MVC e WebAPI, além de back-end e APIs com NodeJS, C#, Java e Python. Possuo expertise em cloud computing, trabalhando com AWS, GCP e Azure (DevOps), utilizando Docker e Kubernetes para orquestração e arquiteturas serverless. Tenho profundo conhecimento em bancos de dados SQL Server, PostgreSQL, Neo4J, MongoDB, Redis, Oracle, MySQL e ElasticSearch. Na área de Inteligência Artificial, Machine Learning e Data Science, trabalho com Python e R, NLP, IA, Deep Learning, modelos GPT (3 e 4), TensorFlow, PyTorch, RASA, Hugging Face, LangChain, Llama 2 e estatística com R Studio e Anaconda. Minhas competências se estendem a DevOps e infraestrutura, incluindo CI/CD, Git, servidores de aplicação como WebLogic e IIS, e virtualização com VMWare. Sou especialista em segurança, abrangendo Cryptography (RSA, AES, TLS), IAM (OAuth 2.0, Keycloak), DevSecOps (Snyk, Trivy), Pentesting (Kali, Nmap), SIEM (Splunk, Sentinel), OWASP Top 10, GDPR/LGPD e segurança de APIs e containers (JWT, Falco), além de resiliência (DDoS, WAF). Também possuo experiência com RabbitMQ, Kafka, ElasticSearch e SonarQube. Aplico metodologias ágeis como Scrum, Safe e Kanban, Design Thinking, UML, BPM, PMI, Gerenciamento de Mudanças (Germud), C4 Model e RUP. Tenho experiência em gerenciamento de equipes, recrutamento, gestão de projetos, definição de KPIs, gestão de custos (Capex/Opex), garantia da qualidade, operações, comunicação com executivos (CEOs) e formação de times. Aplico padrões de design e arquitetura como Abstract Factory, Facade, MVC, Microservices (Hexagonal, Vertical Slice, EDA) e SOA. Ao se apresentar responderei de forma objetiva e curta. Devo ficar esperto se a pessoa está me elogiando, agradecendo ou encerrando a conversa e nesse caso faço mesmo sem ficar falando do meu currículo a todo momento. Leve em conta sempre o nome da pessoa na hora de responder. Sempre levar em consideração as respostas anteriores para não responder besteira. O que você não souber a respeito do currículo dele diga que não sabe e passe o contato. Nas horas vagas gosto de estudar tecnologias emergentes, ver filmes com minha família, brincar com meu filho David e jogar jogos eletrônicos tipo Starcraft. Sou casado. Meus defeitos são que sou muito perfeccionista e ansioso. Minhas qualidades são entusiasmo e adoro ajudar pessoas a se desenvolverem tanto na vida profissional quanto pessoal. Prefiro backend a frontend. Gosto de comer pizza, arroz, feijão e ovo cozido. Notar se a mensagem é para mim com base no contexto das respostas anteriores, também indiretamente. Se alguém tirar ou fizer piadinhas comigo responderei ironicamente com uma piada.
`;

async function wakeUpApi() {
  const apiRootUrl = OPENROUTER_BASE_URL.replace('/api/v1', '');
  emitStatus(`Acordando a API de IA...`);
  try {
    await axios.get(apiRootUrl, { timeout: 8000 });
    emitStatus("API de IA está ativa ou acordando.");
  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      emitStatus("API de IA está acordando (timeout é normal).");
    } else {
      emitStatus(`Aviso: Ping para API falhou: ${error.message}`);
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

function userAskedForCode(text) {
  if (!text) {
      return false;
  }
  const patterns = [
    /mostre o código/i, /exemplo de código/i, /me d[eé] o código/i,
    /me mostre o código/i, /código por favor/i, /preciso do código/i,
    /snippet/i, /trecho de código/i,
  ];
  return patterns.some(rx => rx.test(text));
}

function sanitizeReply(reply, userWantedCode) {
  if (userWantedCode) {
      return reply;
  }
  let sanitized = reply.replace(/```[\s\S]*?```/g, '[código ocultado]');
  sanitized = sanitized.replace(/~~~[\s\S]*?~~~/g, '[código ocultado]');
  sanitized = sanitized.replace(/`([^`]+)`/g, '[código ocultado]');
  return sanitized;
}

function localHeuristicTrigger(text) {
  if (!text) {
      return false;
  }
  const trimmed = text.trim();
  return /^\/bot\b/i.test(trimmed) || /^anderson[:\s]/i.test(trimmed);
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
    const wantsCode = userAskedForCode(text);
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
    reply = sanitizeReply(reply, wantsCode);
    conversationHistory[sessionKey].history.push({ role: 'assistant', content: reply });
    return reply;
  } catch (error) {
    console.error(chalk.red('Erro ao processar mensagem:'), error.response?.data || error.message || error);
    return 'Desculpe, não consegui processar sua mensagem.';
  }
}

class UpstashRedisStore {
  constructor({ url, token }) {
    this.redis = new Redis({ url, token });
  }

  async sessionExists({ session }) {
    emitStatus(`Verificando sessão "${session}" no Redis...`);
    const v = await this.redis.get(`remoteauth:${session}`);
    return v !== null;
  }

  async save({ session }) {
    const zipName = `${session}.zip`;
    emitStatus(`Atualizando sessão no Redis...`);
    const buf = await fs.readFile(zipName);
    const b64 = buf.toString('base64');
    await this.redis.set(`remoteauth:${session}`, b64);
    emitStatus(`Sessão salva no Redis.`);
  }

  async extract({ session, path }) {
    emitStatus("Sessão encontrada. Restaurando agora...");
    const b64 = await this.redis.get(`remoteauth:${session}`);
    if (!b64) {
      emitStatus("Nenhuma sessão encontrada. Prepare-se para escanear o QR Code.");
      return;
    }
    const buf = Buffer.from(b64, 'base64');
    await fs.writeFile(path, buf);
    emitStatus("Sessão restaurada do Redis com sucesso!");
  }

  async delete({ session }) {
    emitStatus(`Deletando sessão "${session}"...`);
    await this.redis.del(`remoteauth:${session}`);
  }
}

async function createClient(usePinned) {
  let authStrategy;
  try {
    emitStatus("Configurando autenticação remota...");
    const store = new UpstashRedisStore({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
    await store.redis.ping();
    emitStatus("Conexão com Redis confirmada.");
    authStrategy = new RemoteAuth({ clientId: 'anderson-bot', store, backupSyncIntervalMs: 120000 });
  } catch (e) {
    emitStatus(`ERRO CRÍTICO ao conectar ao Redis: ${e.message}`);
    throw new Error("Falha na conexão com o Redis.");
  }

  const client = new Client({
    authStrategy,
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    webVersionCache: usePinned ? { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' } : undefined,
  });

  client.on('qr', (qr) => {
    emitStatus("QR Code gerado! Escaneie no terminal.");
    qrcode.generate(qr, { small: true });
  });

  client.on('ready', () => {
    emitStatus("Bot está pronto e online!");
    console.log(chalk.green('Client is ready!'));
  });

  client.on('auth_failure', (msg) => {
      emitStatus(`ERRO DE AUTENTICAÇÃO: ${msg}`);
  });
  
  client.on('disconnected', (reason) => {
      emitStatus(`Bot desconectado: ${reason}.`);
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
      const chatId = message.from;
      const userId = message.author || chatId;
      const sessionKey = `${chatId}:${userId}`;
      const chat = await message.getChat();
      const contact = await message.getContact();
      const userName = contact.pushname || contact.verifiedName || message.from;
      
      let shouldRespond = !chat.isGroup;
      if (chat.isGroup) {
        const isMentioned = message.mentionedIds.includes(client.info.wid._serialized);
        const triggered = USE_LOCAL_HEURISTIC && localHeuristicTrigger(message.body);
        if (isMentioned || triggered) {
          shouldRespond = true;
        } else {
          const context = buildContextSnippet(conversationHistory[sessionKey]?.history);
          shouldRespond = await analyzeIfMessageIsForAI(message.body, context);
        }
      }

      if (shouldRespond) {
        const responseMessage = await processMessage(message.body, sessionKey, userName, chat.name);
        if (chat.isGroup) {
          await message.reply(`@${contact.id.user} ${responseMessage}`, { mentions: [contact] });
        } else {
          await message.reply(responseMessage);
        }
      }
    } catch (err) {
      console.error(chalk.red('⚠ Erro no handler de mensagem:'), err);
      try { await message.reply('Desculpe, ocorreu um erro.'); } catch (_) {}
    }
  });

  try {
    emitStatus("Iniciando a conexão com o WhatsApp...");
    await client.initialize();
    return client;
  } catch (err) {
    emitStatus(`Inicialização falhou. Tentando de novo...`);
    if (usePinned) { return createClient(false); }
    throw err;
  }
}

server.listen(PORT, async () => {
    emitStatus("Servidor web iniciado...");
    console.log(chalk.green(`Servidor rodando na porta ${PORT}.`));
    try {
      await wakeUpApi();
      await createClient(true);
    } catch (e) {
      const errorMsg = `ERRO CRÍTICO: ${e.message}`;
      emitStatus(errorMsg);
      console.error(chalk.red(errorMsg), e);
    }
});
