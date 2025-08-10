'use strict';

/**
 * index_MyOpenRouter.js (novo + UI de status igual ao antigo + correções de resposta no WhatsApp)
 * - Mantém a estrutura do projeto novo
 * - UI de status igual ao antigo (/status e /status.json) e / redireciona p/ /status
 * - Logs e fallback para evitar silêncio no WhatsApp se OpenRouter/classificador falharem
 * - Sem quebrar o que já funcionava
 */

const os = require('os');
const path = require('path');
const fs = require('fs'); // Usando fs síncrono para carregar a mensagem do sistema
const fsp = require('fs/promises'); // Renomeado para evitar conflito

process.env.CHROME_LOG_FILE = path.join(os.tmpdir(), 'wweb_chrome_debug.log');

// punycode (aviso em Node 21+ é inofensivo)
try { require('punycode'); } catch (_) {}

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 21) {
  console.warn(`Você está rodando Node.js v${process.versions.node}. O aviso sobre punycode ([DEP0040]) é esperado e pode ser ignorado.`);
}

// --- dependências principais ---
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrcodeWeb = require('qrcode'); // Para gerar QR Code para a web
const axios = require('axios');
const express = require('express');
const { Redis } = require('@upstash/redis');

// chalk com fallback
let chalk;
try {
  chalk = require('chalk');
  if (chalk && chalk.default) chalk = chalk.default;
} catch (_) {
  chalk = {
    red: (s) => s, green: (s) => s, yellow: (s) => s, blueBright: (s) => s,
    magenta: (s) => s, cyan: (s) => s, gray: (s) => s,
  };
}

// --- Config OpenRouter (como no novo) ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'Qualquer chave';
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://myopenrouter.onrender.com/api/v1';
const MODEL = process.env.OPENROUTER_MODEL || 'openai/gpt-oss-20b:free';

// --- Redis (Upstash) igual ao antigo ---
const UPSTASH_REDIS_REST_URL =
  process.env.UPSTASH_REDIS_REST_URL || 'https://humorous-koi-8598.upstash.io';
const UPSTASH_REDIS_REST_TOKEN =
  process.env.UPSTASH_REDIS_REST_TOKEN || 'ASGWAAIjcDFiNWQ0MmRiZjIxODg0ZTdkYWYxMzQ0N2QxYTBhZTc0YnAxMA';

// flags opcionais
const SKIP_CLASSIFICATION = !!process.env.SKIP_CLASSIFICATION; // defina =1 para responder a tudo em grupos
const USE_LOCAL_HEURISTIC = process.env.USE_LOCAL_HEURISTIC !== '0';

// histórico em memória
const conversationHistory = {};
let qrCodeDataUrl = null; // Armazena o QR Code para a UI web

// ---------- ESTADO DE STATUS (carregamento/erro/pronto) ----------
const botStatus = {
  phase: 'starting',          // starting | ready | error
  startedAt: Date.now(),
  readyAt: null,
  errorAt: null,
  errorMessage: null,
  errorStack: null,
  notes: [],
  steps: [
    { key: 'bootstrap',     label: 'Inicializando servidor do bot',        status: 'doing',    at: Date.now() },
    { key: 'redis_ping',    label: 'Conectando ao Redis (Upstash)',        status: 'pending',  at: null },
    { key: 'auth_store',    label: 'Preparando RemoteAuth + Store',        status: 'pending',  at: null },
    { key: 'client_create', label: 'Criando cliente WhatsApp',             status: 'pending',  at: null },
    { key: 'client_init',   label: 'Inicializando cliente WhatsApp',       status: 'pending',  at: null },
    { key: 'qr',            label: 'Aguardando leitura do QR Code',        status: 'pending',  at: null },
    { key: 'ready',         label: 'Cliente pronto',                        status: 'pending',  at: null },
  ],
};
function stepSet(key, status, extraNote) {
  const s = botStatus.steps.find(x => x.key === key);
  if (!s) return;
  s.status = status; // 'pending' | 'doing' | 'done' | 'error'
  s.at = Date.now();
  if (extraNote) botStatus.notes.push(`[step:${key}] ${new Date().toISOString()} ${extraNote}`);
}
function setPhaseStarting(note) {
  botStatus.phase = 'starting';
  botStatus.notes.push(`[starting] ${new Date().toISOString()} ${note || ''}`);
  botStatus.errorMessage = null;
  botStatus.errorStack = null;
}
function setPhaseReady(note) {
  qrCodeDataUrl = null; // Limpa o QR code quando o bot está pronto
  botStatus.phase = 'ready';
  botStatus.readyAt = Date.now();
  botStatus.notes.push(`[ready] ${new Date().toISOString()} ${note || ''}`);
  stepSet('ready', 'done');
}
function setPhaseError(err, where) {
  qrCodeDataUrl = null; // Limpa o QR code em caso de erro
  botStatus.phase = 'error';
  botStatus.errorAt = Date.now();
  botStatus.errorMessage = (err && (err.message || String(err))) || 'Erro desconhecido';
  botStatus.errorStack = (err && (err.stack || err.toString())) || null;
  botStatus.notes.push(`[error] ${new Date().toISOString()} em ${where || 'n/d'}`);
  console.error(chalk.red(`✖ Status de erro (${where || 'n/d'}):`), err);
  const lastDoing = [...botStatus.steps].reverse().find(p => p.status === 'doing' || p.status === 'pending');
  if (lastDoing) stepSet(lastDoing.key, 'error');
}

// prompt do sistema (carregado de arquivo externo)
let systemMessage;
try {
  systemMessage = fs.readFileSync(path.join(__dirname, 'system_message.txt'), 'utf8');
  console.log(chalk.green('✔ Mensagem do sistema carregada de system_message.txt'));
} catch (error) {
  console.error(chalk.red('✖ CRÍTICO: Não foi possível carregar o system_message.txt. Usando um fallback.'), error);
  systemMessage = 'Eu sou um assistente. Por favor, configure o system_message.txt';
}

// ---------- util: HTTP com retry/backoff e timeout maior ----------
async function postWithRetry(url, data, config, retries = 2) {
  let attempt = 0;
  let delay = 1500;
  let lastErr = null;
  while (attempt <= retries) {
    try {
      const res = await axios.post(url, data, { timeout: 45000, ...config });
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt === retries) break;
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
      attempt++;
    }
  }
  throw lastErr;
}

// utilitários de histórico
function getFormattedMessages(history) {
  return history.map(m => ({ role: m.role, content: m.content }));
}
function buildContextSnippet(history, maxMessages = 3) {
  if (!history || history.length === 0) return '';
  const userMsgs = history.filter(m => m.role === 'user');
  const last = userMsgs.slice(-maxMessages);
  return last.map(m => m.content).join(' | ');
}
function userAskedForCode(text) {
  if (!text) return false;
  const patterns = [
    /mostre o código/i, /exemplo de código/i, /me d[eé] o código/i,
    /me mostre o código/i, /código por favor/i, /preciso do código/i,
    /snippet/i, /trecho de código/i,
  ];
  return patterns.some(rx => rx.test(text));
}
function sanitizeReply(reply, userWantedCode) {
  if (userWantedCode) return reply;
  let sanitized = reply.replace(/```[\s\S]*?```/g, '[código ocultado]');
  sanitized = sanitized.replace(/~~~[\s\S]*?~~~/g, '[código ocultado]');
  sanitized = sanitized.replace(/`([^`]+)`/g, '[código ocultado]');
  return sanitized;
}
function localHeuristicTrigger(text) {
  if (!text) return false;
  const t = text.trim();
  return /^\/bot\b/i.test(t) || /^anderson[:\s]/i.test(t);
}

// ---------- Oráculo de Decisão de Resposta via OpenRouter ----------
let systemMessageSummary = null;

function getSystemMessageSummary() {
  if (systemMessageSummary) return systemMessageSummary;
  const lines = systemMessage.split('\n');
  systemMessageSummary = lines.slice(0, 10).join('\n'); // Sumário com 10 linhas
  return systemMessageSummary;
}

async function shouldBotRespond(text, contextSnippet = '') {
  if (SKIP_CLASSIFICATION) {
    console.log(chalk.yellow('→ SKIP_CLASSIFICATION=1: respondendo sem classificar.'));
    return true;
  }
  try {
    console.log(chalk.magenta('→ Consultando Oráculo de Decisão...'));
    
    const prompt = `
Você é um assistente de IA especialista no projeto XBash, atuando em um grupo de WhatsApp. Sua principal diretriz é ser útil sem ser intrusivo. Você deve analisar a nova mensagem no contexto da conversa e da sua base de conhecimento para decidir se uma resposta sua agregaria valor.

**Sua Base de Conhecimento (Resumo):**
"""
${getSystemMessageSummary()}
"""

**Contexto da Conversa Recente:**
"""
${contextSnippet}
"""

**Nova Mensagem para Análise:**
"""
${text}
"""

**Sua Tarefa:**
Com base em tudo acima, e **dando prioridade ao contexto da conversa recente para resolver ambiguidades**, responda à seguinte pergunta: **"Seria apropriado e útil para o bot responder a esta mensagem?"**

Responda APENAS com "SIM" ou "NÃO".

- Responda "SIM" se a mensagem for uma pergunta direta para você (o bot), se for sobre um tópico que você domina e a conversa não for direcionada a outra pessoa, ou se for uma interação social clara com você.
- Responda "NÃO" se for uma conversa casual entre outras pessoas, **uma continuação de uma conversa direcionada a outra pessoa (como no contexto recente)**, ou se sua intervenção não agregaria valor.

**Exemplo de Raciocínio:** Se a mensagem anterior foi "Rafael, pode me ajudar?" e a nova mensagem for "claro, o que precisa?", você deve responder "NÃO", pois a segunda mensagem é uma continuação da conversa com Rafael.

Seu julgamento é crucial. Na dúvida, prefira não ser intrusivo.
`;

    const response = await postWithRetry(
      `${OPENROUTER_BASE_URL}/chat/completions`,
      { model: MODEL, temperature: 0, messages: [{ role: 'user', content: prompt }] },
      { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    const decision = (response.data?.choices?.[0]?.message?.content || 'NÃO').trim();
    console.log(chalk.magenta(`   Decisão do Oráculo: ${decision}`));
    
    return /^sim$/i.test(decision);

  } catch (e) {
    console.error(chalk.red('Erro no Oráculo de Decisão:'), e.response?.data || e.message || e);
    botStatus.notes.push(`[decision-oracle-error] ${new Date().toISOString()} ${e.message || e}`);
    // Em caso de erro, assume que deve responder para não ficar em silêncio.
    return true;
  }
}


// ---------- envio principal ao OpenRouter com fallback e retentativas ----------
async function processMessage(text, sessionKey, userName, chatName) {
  const MAX_RETRIES = 3;
  let attempt = 0;
  let reply = '';

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

  while (attempt < MAX_RETRIES && !reply) {
    attempt++;
    try {
      console.log(chalk.cyan(`   Chamando OpenRouter... (Tentativa ${attempt}/${MAX_RETRIES})`));
      const response = await postWithRetry(
        `${OPENROUTER_BASE_URL}/chat/completions`,
        { model: MODEL, messages },
        { headers: { Authorization: `Bearer ${OPENROUTER_API_KEY}`, 'Content-Type': 'application/json' } },
        2
      );

      const rawReply = response.data?.choices?.[0]?.message?.content?.trim() || '';
      console.log(chalk.cyan(`   OpenRouter bruto (tentativa ${attempt}): "${rawReply}"`));
      
      if (rawReply) {
        reply = sanitizeReply(rawReply, wantsCode);
      } else if (attempt < MAX_RETRIES) {
        console.log(chalk.yellow(`   Resposta vazia. Tentando novamente em 2s...`));
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.error(chalk.red(`Erro na tentativa ${attempt} de processMessage:`), e.response?.data || e.message || e);
      if (attempt >= MAX_RETRIES) {
        botStatus.notes.push(`[process-message-error] ${new Date().toISOString()} ${e.message || e}`);
        return 'Estou online ✅ (modo seguro).'; // Erro de rede/API após todas as tentativas
      }
      await new Promise(r => setTimeout(r, 2000)); // Espera antes de tentar novamente em caso de erro
    }
  }

  if (!reply) {
    console.log(chalk.red(`   Falha ao obter resposta após ${MAX_RETRIES} tentativas.`));
    return 'Não consegui gerar uma resposta desta vez. Por favor, tente novamente mais tarde.';
  }
  
  conversationHistory[sessionKey].history.push({ role: 'assistant', content: reply });
  return reply;
}

// ---------- Upstash Redis Store com chunking ----------
const CHUNK_SIZE = 8 * 1024 * 1024; // 8MB

class UpstashRedisStore {
  constructor({ url, token }) {
    this.redis = new Redis({ url, token });
    console.log(chalk.blueBright('Inicializando UpstashRedisStore...'));
  }

  async sessionExists({ session }) {
    try {
      const meta = await this.redis.hgetall(`remoteauth:${session}:meta`);
      return !!(meta && meta.totalParts);
    } catch {
      return false;
    }
  }

  async save({ session }) {
    const zipName = `${session}.zip`;
    const buf = await fsp.readFile(zipName);
    const b64 = buf.toString('base64');
    const oldKeys = await this.redis.keys(`remoteauth:${session}:part:*`);
    if (oldKeys && oldKeys.length) await this.redis.del(...oldKeys);
    await this.redis.del(`remoteauth:${session}:meta`);
    let part = 0;
    for (let i = 0; i < b64.length; i += CHUNK_SIZE) {
      const slice = b64.slice(i, i + CHUNK_SIZE);
      await this.redis.set(`remoteauth:${session}:part:${part}`, slice);
      part++;
    }
    await this.redis.hset(`remoteauth:${session}:meta`, {
      totalParts: String(part),
      ts: String(Date.now()),
    });
  }

  async extract({ session, path }) {
    const meta = await this.redis.hgetall(`remoteauth:${session}:meta`);
    const totalParts = meta && meta.totalParts ? parseInt(meta.totalParts, 10) : 0;
    if (!totalParts) return;
    const partKeys = Array.from({ length: totalParts }, (_, i) => `remoteauth:${session}:part:${i}`);
    const parts = await this.redis.mget(...partKeys);
    const b64 = parts.join('');
    const buf = Buffer.from(b64, 'base64');
    await fsp.writeFile(path, buf);
  }

  async delete({ session }) {
    const keys = await this.redis.keys(`remoteauth:${session}:part:*`);
    if (keys && keys.length) await this.redis.del(...keys);
    await this.redis.del(`remoteauth:${session}:meta`);
  }
}

// --- cria o client mantendo estrutura do novo, com passos marcados ---
async function createClient() {
  let authStrategy;

  // Passo: Redis Ping
  stepSet('redis_ping', 'doing', 'Testando conexão ao Upstash Redis');
  try {
    const testRedis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
    await testRedis.ping();
    stepSet('redis_ping', 'done', 'Ping OK');
  } catch (e) {
    stepSet('redis_ping', 'error', e.message || String(e));
    setPhaseError(e, 'redis_ping');
    throw e;
  }

  // Passo: Auth Store
  stepSet('auth_store', 'doing', 'Instanciando Store e RemoteAuth');
  try {
    const store = new UpstashRedisStore({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
    authStrategy = new RemoteAuth({ clientId: 'anderson-bot', store, backupSyncIntervalMs: 120000 });
    stepSet('auth_store', 'done', 'RemoteAuth pronto');
  } catch (e) {
    stepSet('auth_store', 'error', e.message || String(e));
    authStrategy = new LocalAuth({ clientId: 'anderson-bot', rmMaxRetries: 8 }); // fallback sem quebrar
    botStatus.notes.push('[fallback] RemoteAuth falhou; usando LocalAuth.');
  }

  // Passo: client_create
  stepSet('client_create', 'doing', 'Criando instância do cliente');
  const client = new Client({
    authStrategy,
    puppeteer: {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
      ],
    },
  });
  stepSet('client_create', 'done');

  // Encerramento
  async function cleanExit(reason) {
    try { await client.destroy(); } catch (_) {}
    process.exit(0);
  }
  process.on('SIGINT', () => cleanExit('SIGINT'));
  process.on('SIGTERM', () => cleanExit('SIGTERM'));
  process.on('uncaughtException', (err) => { setPhaseError(err, 'uncaughtException'); cleanExit('uncaughtException'); });
  process.on('unhandledRejection', (reason) => { setPhaseError(reason, 'unhandledRejection'); cleanExit('unhandledRejection'); });

  client.on('qr', (qr) => {
    // Exibe no terminal
    qrcode.generate(qr, { small: true });
    // Gera para a web
    qrcodeWeb.toDataURL(qr, (err, url) => {
      if (!err) qrCodeDataUrl = url;
    });
    stepSet('qr', 'doing', 'QR code gerado. Aguardando leitura...');
  });
  client.on('ready', () => {
    qrCodeDataUrl = null;
    stepSet('client_init', 'done');
    stepSet('qr', 'done', 'Sessão autenticada');
    setPhaseReady('Cliente WhatsApp inicializado');
  });
  client.on('auth_failure', (msg) => {
    qrCodeDataUrl = null;
    stepSet('qr', 'error', msg || 'auth_failure');
    setPhaseError(new Error(msg || 'auth_failure'), 'auth_failure');
  });
  client.on('disconnected', (reason) => {
    qrCodeDataUrl = null;
    botStatus.notes.push(`[disconnected] ${new Date().toISOString()} ${reason || ''}`);
  });

  // ======= HANDLER DE MENSAGENS (com logs e fallbacks) =======
  let coldStart = true;

  client.on('message', async (message) => {
    console.log(chalk.blueBright('--- evento: message ---'));
    console.log(chalk.gray(`from=${message.from} body="${(message.body||'').slice(0,200)}"`));

    try {
      // Comando simples de teste
      if (message.body === '!ping') {
        console.log('Recebeu !ping, respondendo pong.');
        await message.reply('pong!');
        return;
      }

      if (coldStart) {
        try { await message.reply('✅ Bot ativo. Pode falar comigo!'); } catch (_) {}
        coldStart = false;
      }

      const chatId = message.from;
      const userId = message.author || chatId;
      const sessionKey = `${chatId}:${userId}`;

      if (!conversationHistory[sessionKey]) {
        conversationHistory[sessionKey] = { name: '', history: [] };
      }

      let chatName = null;
      let isGroup = false;
      try {
        const chat = await message.getChat();
        if (chat.isGroup) {
          isGroup = true;
          chatName = chat.name;
        }
      } catch (e) {
        console.warn(chalk.yellow('Não conseguiu obter chat info:'), e.message || e);
      }

      const contact = await message.getContact();
      const userName = contact.pushname || contact.verifiedName || message.from;
      conversationHistory[sessionKey].name = userName;

      let shouldRespond = true;
      if (isGroup) {
        const botId = (client.info && client.info.wid && client.info.wid._serialized) || null;
        const isMentioned = botId ? (message.mentionedIds || []).includes(botId) : false;
        console.log(chalk.gray(`   Grupo? sim | mencionado=${isMentioned}`));

        if (!isMentioned) {
          const contextSnippet = buildContextSnippet(conversationHistory[sessionKey].history, 3);
          shouldRespond = await shouldBotRespond(message.body, contextSnippet);

          if (!shouldRespond) {
            console.log(chalk.yellow('   → Decisão da IA: Não responder.'));
            return;
          }
        }
      }

      if (shouldRespond) {
        const chat = await message.getChat();
        await chat.sendStateTyping(); // Envia o status "digitando..."

        const responseMessage = await processMessage(message.body, sessionKey, userName, chatName);
        console.log(chalk.green(`   Resposta: "${responseMessage}"`));

        await chat.clearState(); // Limpa o status "digitando..."

        if (isGroup) {
          // Correção para o aviso de "deprecation": Usar o ID serializado (string) em vez do objeto Contact.
          const authorContact = await message.getContact();
          
          if (authorContact && authorContact.id && authorContact.id._serialized) {
            const mentionUser = authorContact.id.user;
            const mentionId = authorContact.id._serialized;
            await chat.sendMessage(`@${mentionUser} ${responseMessage}`, {
              mentions: [mentionId] // Usando a string do ID, como recomendado pela nova versão.
            });
          } else {
            await chat.sendMessage(responseMessage); // Fallback se não conseguir obter o contato
          }
        } else {
          await message.reply(responseMessage);
        }
      }

      console.log(chalk.green('   ✔ Enviado!'));
    } catch (err) {
      console.error(chalk.red('⚠ Erro no handler de mensagem:'), err);
      botStatus.notes.push(`[message-handler-error] ${new Date().toISOString()} ${err.message || err}`);
      try { await message.reply('Desculpe, ocorreu um erro ao processar sua mensagem.'); } catch (_) {}
    }
  });

  // Passo: client_init
  stepSet('client_init', 'doing', 'Inicializando cliente');
  try {
    await client.initialize();
    return client;
  } catch (err) {
    stepSet('client_init', 'error', err.message || String(err));
    setPhaseError(err, 'client.initialize');
    throw err;
  }
}

// --- servidor web de status (igual ao antigo) ---
const app = express();
const PORT = process.env.PORT || 3006;

// A rota raiz agora renderiza a página de status diretamente
app.get('/', (_req, res) => {
  const isReady = botStatus.phase === 'ready';
  const isError = botStatus.phase === 'error';
  const isQrPending = botStatus.steps.find(s => s.key === 'qr')?.status === 'doing';
  const autoRefresh = !isReady ? '<meta http-equiv="refresh" content="3">' : '';
  const icon = isError ? '❌' : (isReady ? '✅' : '⏳');
  const title = isError ? 'Falha ao iniciar o bot' : (isReady ? 'Bot pronto' : 'Carregando bot...');
  const subtitle = isError
    ? (botStatus.errorMessage || 'Erro desconhecido')
    : (isReady ? 'Cliente WhatsApp inicializado com sucesso.' : 'Executando etapas de inicialização...');

  const total = botStatus.steps.length;
  const done = botStatus.steps.filter(s => s.status === 'done').length;
  const pct = Math.round((done / total) * 100);

  const li = botStatus.steps.map(s => {
    const badge =
      s.status === 'done'  ? '<span class="b ok">concluído</span>' :
      s.status === 'doing' ? '<span class="b doing">executando</span>' :
      s.status === 'error' ? '<span class="b err">erro</span>' :
                             '<span class="b pend">aguardando</span>';
    const when = s.at ? new Date(s.at).toLocaleTimeString() : '--';
    return `<li>
      <div class="row">
        <div class="label">${s.label}</div>
        <div class="meta">${when} ${badge}</div>
      </div>
    </li>`;
  }).join('');

  const notes = botStatus.notes.slice(-50).map(n => `<li>${n}</li>`).join('');

  const errorBlock = isError
    ? `<div class="section"><h3>Detalhes do erro</h3>
         <pre class="pre">${(botStatus.errorStack || botStatus.errorMessage || '').toString().substring(0, 20000)}</pre>
       </div>`
    : '';
  
  const qrBlock = isQrPending
    ? `<div class="section qr">
         <h3>Escaneie o QR Code</h3>
         <img src="/qr?t=${Date.now()}" alt="QR Code para conectar ao WhatsApp" style="max-width: 250px; display: block; margin: 10px auto;">
       </div>`
    : '';

  res.status(isError ? 500 : 200).send(`<!doctype html>
<html lang="pt-br">
<head>
<meta charset="utf-8">
${autoRefresh}
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status do Bot</title>
<style>
  :root { --bg:#0b1220; --card:#111827; --dim:#9ca3af; --fg:#e6e6e6; --line:#1f2937; --accent:#1d4ed8; --ok:#065f46; --ok2:#a7f3d0; --err:#7c2d12; --err2:#fed7aa; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font-family: system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,'Helvetica Neue',Arial,'Noto Sans','Liberation Sans',sans-serif; }
  .wrap { max-width: 980px; margin: 24px auto; padding: 0 16px; }
  .card { background:var(--card); border:1px solid #273449; border-radius:16px; padding:24px; box-shadow:0 10px 30px rgba(0,0,0,.25); }
  .title { display:flex; gap:10px; align-items:center; font-size:24px; font-weight:700; }
  .subtitle { color:var(--dim); margin-top:6px; }
  .progress { height:10px; width:100%; background:#0f172a; border:1px solid var(--line); border-radius:999px; overflow:hidden; margin-top:14px; }
  .bar { height:100%; width:${pct}%; background:linear-gradient(90deg,#2563eb,#38bdf8); }
  .grid { display:grid; grid-template-columns:1fr; gap:16px; margin-top:18px; }
  .section { background:#0f172a; border:1px solid var(--line); border-radius:12px; padding:16px; }
  .steps ul { list-style:none; margin:0; padding:0; }
  .steps li { padding:10px 6px; border-bottom:1px dashed #273449; }
  .steps li:last-child { border-bottom:0; }
  .row { display:flex; justify-content:space-between; align-items:center; gap:10px; }
  .label { font-weight:600; }
  .meta { color:#cbd5e1; font-size:12px; display:flex; gap:8px; align-items:center; }
  .b { padding:2px 8px; border-radius:999px; border:1px solid transparent; font-weight:700; font-size:11px; text-transform:uppercase; letter-spacing:.4px; }
  .b.ok { background: var(--ok); color: var(--ok2); border-color:#064e3b; }
  .b.doing { background:#1e3a8a; color:#bfdbfe; border-color:#1d4ed8; }
  .b.pend { background:#334155; color:#e2e8f0; border-color:#475569; }
  .b.err { background: var(--err); color: var(--err2); border-color:#9a3412; }
  .pre { background:#1e1e1e; color:#ddd; padding:12px; border-radius:8px; white-space:pre-wrap; overflow:auto; max-height:420px; }
  .notes ul { margin:0; padding-left:1.1rem; }
  .notes li { color:#cbd5e1; line-height:1.45; }
  .footer { margin-top:10px; color:#64748b; font-size:12px; }
  .badges { margin-top:8px; display:flex; gap:10px; flex-wrap:wrap; color:#93c5fd; }
  .qr h3 { text-align: center; margin-top: 0; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="title">${icon} ${title}</div>
      <div class="subtitle">${subtitle}</div>
      <div class="progress"><div class="bar"></div></div>

      <div class="badges">
        <div>Node: ${process.version}</div>
        <div>PID: ${process.pid}</div>
        <div>Uptime: ${Math.floor(process.uptime())}s</div>
        <div>Fase: ${botStatus.phase}</div>
      </div>

      <div class="grid">
        ${qrBlock}
        <div class="section steps">
          <h3>Passos</h3>
          <ul>${li}</ul>
        </div>

        ${errorBlock}

        <div class="section notes">
          <h3>Últimos eventos</h3>
          <ul>${notes || '<li>Sem eventos ainda.</li>'}</ul>
        </div>
      </div>

      <div class="footer">
        ${isReady ? 'Pronto.' : 'Atualizando automaticamente a cada 3s enquanto carrega…'} &middot; Veja também <code>/status.json</code>
      </div>
    </div>
  </div>
</body>
</html>`);
});

app.get('/healthz', (_req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Endpoint para o QR Code
app.get('/qr', (_req, res) => {
  if (qrCodeDataUrl) {
    const img = Buffer.from(qrCodeDataUrl.split(',')[1], 'base64');
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': img.length,
    });
    res.end(img);
  } else {
    res.status(404).send('QR Code não disponível.');
  }
});

// Endpoint JSON
app.get('/status.json', (_req, res) => {
  res.status(200).json({
    phase: botStatus.phase,
    startedAt: botStatus.startedAt,
    readyAt: botStatus.readyAt,
    errorAt: botStatus.errorAt,
    errorMessage: botStatus.errorMessage,
    qrCodeAvailable: !!qrCodeDataUrl,
    notes: botStatus.notes.slice(-50),
    steps: botStatus.steps,
    node: process.version,
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
  });
});

// A rota /status foi removida para evitar duplicidade.
// A lógica agora está na rota raiz '/'.

// --- bootstrap ---
const server = app.listen(PORT, () => console.log(chalk.green(`Servidor web de status na porta ${PORT}`)));

(async () => {
  setPhaseStarting('Bootstrap inicial');
  stepSet('bootstrap', 'done');
  try {
    await createClient();
  } catch (e) {
    setPhaseError(e, 'bootstrap');
  }
})();
