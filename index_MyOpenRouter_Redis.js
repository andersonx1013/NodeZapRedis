relaxa 😅 — bora deixar **com contexto em memória** durante a conversa e **Redis só pro login** (RemoteAuth). Mantive a heurística esperta pra grupos e o store com **chunking** (não estoura o Upstash). Segue o **código completo**:

```js
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
<!doctype html><html lang="pt-BR"><head>
<meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Status do Bot</title>
<style>
:root{--bg:#0d1117;--fg:#c9d1d9;--acc:#58a6ff;--ok:#238636;--err:#da3633;--pen:#8b949e;--bd:#30363d;--card:#161b22}
@keyframes spin{to{transform:rotate(360deg)}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;display:grid;place-items:center;height:100vh;padding:24px}
h1{margin:0 0 24px;font:700 40px/1.1 system-ui,sans-serif;color:var(--acc)}
ul{list-style:none;margin:0;padding:0;width:min(640px,100%)}
li{display:flex;gap:12px;align-items:center;border-bottom:1px solid var(--bd);padding:12px 0}
.badge{width:14px;height:14px;border-radius:50%}
.pending .badge{background:var(--pen)}.running .badge{background:var(--acc);animation:spin 1s linear infinite}.success .badge{background:var(--ok)}.error .badge{background:var(--err)}
#activity{margin-top:16px;background:var(--card);padding:16px;border-radius:10px}
</style></head><body>
<main>
<h1>Bot Status</h1>
<ul id="steps"></ul>
<div id="activity">Aguardando...</div>
</main>
<script src="/socket.io/socket.io.js"></script>
<script>
const stepsEl=document.getElementById('steps'),act=document.getElementById('activity');
const render=s=>{stepsEl.innerHTML='';s.steps.forEach(st=>{const li=document.createElement('li');li.className=st.status;li.innerHTML='<span class="badge"></span><span>'+st.text+'</span>';stepsEl.appendChild(li)});act.textContent=s.currentActivity;}
const io_ = io(); io_.on('progressUpdate', render); io_.on('connect', ()=>io_.emit('requestHistory')); io_.on('history', s=>s?.steps&&render(s));
</script>
</body></html>
`;
app.get('/', (req,res)=>res.send(statusPageHtml));
io.on('connection', (socket)=>socket.emit('history', progressState));

// ===== Config (.env no Render) =====
const UPSTASH_REDIS_REST_URL   = process.env.UPSTASH_REDIS_REST_URL || 'https://humorous-koi-8598.upstash.io';
const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || 'TROQUE_AQUI';
const OPENROUTER_API_KEY       = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL      = process.env.OPENROUTER_BASE_URL || 'https://myopenrouter.onrender.com/api/v1';
const MODEL                    = process.env.OPENROUTER_MODEL || 'deepseek/deepseek-r1-0528:free';
const USE_LOCAL_HEURISTIC      = process.env.USE_LOCAL_HEURISTIC !== '0'; // on por padrão
const REMOTEAUTH_CLIENT_ID     = process.env.REMOTEAUTH_CLIENT_ID || 'anderson-bot';
const BACKUP_EVERY_MS          = Number(process.env.BACKUP_EVERY_MS || (10 * 60 * 1000)); // 10min
const MEM_HISTORY_COUNT        = Number(process.env.MEM_HISTORY_COUNT || 12); // nº de mensagens por sessão em memória

// ===== Prompt base =====
const systemMessage = `
Você é o assistente virtual (avatar) do Anderson Xavier. Responda curto, direto e em PT-BR.
Não se apresente a cada mensagem. Seja educado e leve.
`;

// ===== Ping leve para acordar a API =====
async function wakeUpApi() {
  updateProgress('api', 'running', 'Enviando "ping" para acordar a API de IA...');
  const apiRootUrl = OPENROUTER_BASE_URL.replace('/api/v1','');
  try {
    await axios.get(apiRootUrl, { timeout: 8000 });
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
    if (!OPENROUTER_API_KEY) {
      console.warn(chalk.yellow('⚠ OPENROUTER_API_KEY não definido — usando resposta local.'));
      return 'Oi! (modo offline da IA) — configure OPENROUTER_API_KEY para respostas melhores.';
    }
    const sess = conversationHistory[sessionKey];
    const messages = [
      { role: 'system', content: systemMessage },
      { role: 'system', content: `Nome do usuário: ${chatName ? `${userName} (no grupo "${chatName}")` : userName}` },
      ...(sess ? getFormattedMessages(sess.history) : []),
      { role: 'user', content: text }
    ];
    const doCall = () => axios.post(
      `${OPENROUTER_BASE_URL}/chat/completions`,
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

async function createClient(usePinnedHtml) {
  updateProgress('redis', 'running', 'Conectando ao banco de dados Redis...');
  let store;
  try {
    store = new UpstashRedisStore({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
    await store.redis.ping();
    updateProgress('redis', 'success', 'Conexão com Redis estabelecida.');
  } catch (e) {
    updateProgress('redis', 'error', `Falha ao conectar ao Redis: ${e.message}`);
    throw e;
  }

  const authStrategy = new RemoteAuth({
    clientId: REMOTEAUTH_CLIENT_ID,
    store,
    backupSyncIntervalMs: BACKUP_EVERY_MS,
  });

  const client = new Client({
    authStrategy,
    puppeteer: { headless: true, args: ['--no-sandbox','--disable-setuid-sandbox'] },
    webVersionCache: usePinnedHtml
      ? { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
      : undefined,
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

// ===== Boot =====
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
```

Se quiser que eu **aumente/diminua** o tamanho do contexto, é só ajustar `MEM_HISTORY_COUNT` (env). Também dá pra **trocar a heurística** do grupo pra mais restrita (responder só quando marcado/reply). Quer que eu já deixe assim?
