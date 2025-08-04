'use strict';

// --- servidor HTTP mínimo para Render health-check / keep-alive ---
const express = require('express');
const httpApp = express();
httpApp.get('/', (_, res) => res.send('OK'));
httpApp.get('/healthz', (_, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});
const PORT = process.env.PORT || 3000;
httpApp.listen(PORT, () => {
  console.log(`HTTP health check listening on port ${PORT}`);
});

// --- ambiente / compatibilidade ---
const os = require('os');
const path = require('path');
process.env.CHROME_LOG_FILE = path.join(os.tmpdir(), 'wweb_chrome_debug.log');

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 21) {
  console.warn(`Você está rodando Node.js v${process.versions.node}. O aviso sobre punycode ([DEP0040]) é esperado e pode ser mitigado com um shim.`); 
}

// --- dependências ---
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const { Redis } = require('@upstash/redis');
const fs = require('fs/promises');
const qrcode = require('qrcode-terminal');
const axios = require('axios');

// fallback simples de chalk
let chalk;
try {
  chalk = require('chalk');
  if (chalk && chalk.default) chalk = chalk.default;
} catch (_) {
  chalk = {
    red: (s) => s,
    green: (s) => s,
    yellow: (s) => s,
    blueBright: (s) => s,
    magenta: (s) => s,
    cyan: (s) => s,
    gray: (s) => s,
  };
}

// --- configurações fixas (sem usar variáveis de ambiente para Upstash) ---
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || ''; // pode hardcodar se quiser
const OPENROUTER_BASE_URL = process.env.OPENROUTER_BASE_URL || 'https://myopenrouter.onrender.com/api/v1';
const MODEL = process.env.MODEL || 'qwen/qwen3-coder:free';
const OPENROUTER_TIMEOUT_MS = 90000; // 90s fixo

// **Hardcoded Upstash REST credentials (não usa env vars)**
const UPSTASH_REDIS_REST_URL = 'https://humorous-koi-8598.upstash.io';
const UPSTASH_REDIS_REST_TOKEN = 'ASGWAAIjcDFiNWQ0MmRiZjIxODg0ZTdkYWYxMzQ0N2QxYTBhZTc0YnAxMA';

const SKIP_CLASSIFICATION = false;
const USE_LOCAL_HEURISTIC = true;

const conversationHistory = {};
let coldStart = true;

const systemMessage = `
🚫 NÃO forneça exemplos de código, trechos \`\`\`, comandos de terminal ou descrições técnicas de programação, a menos que o usuário peça explicitamente. ...
`;

// helpers
function getFormattedMessages(history) {
  return history.map(m => ({ role: m.role, content: m.content }));
}
function userAskedForCode(text) {
  if (!text) return false;
  const patterns = [
    /mostre o código/i,
    /exemplo de código/i,
    /me d[eé] o código/i,
    /me mostre o código/i,
    /código por favor/i,
    /preciso do código/i,
    /snippet/i,
    /trecho de código/i,
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
  return /^\/bot\b/i.test(text.trim()) || /^anderson[:\s]/i.test(text);
}

async function analyzeIfMessageIsForAI(text, contextSnippet = '') {
  if (SKIP_CLASSIFICATION) {
    console.log(chalk.yellow('→ SKIP_CLASSIFICATION ativo: respondendo sem análise.'));
    return true;
  }
  try {
    console.log(chalk.magenta('→ Classificando se mensagem é para a IA...'));

    if (!OPENROUTER_API_KEY) {
      console.warn(chalk.yellow('Chave OpenRouter não configurada corretamente. Pulando classificação.'));
      return false;
    }

    const classificationPrompt = `
Você é um classificador binário. Responda apenas "SIM" ou "NÃO".

Considere que a mensagem é para a IA quando:
• O texto menciona: "IA do Anderson", "Anderson bot", "bot do Anderson", "Apelido IA" (case-insensitive) OU
• Pelo contexto recente (abaixo) fica claro que o usuário está falando com a IA.

Contexto recente: "${contextSnippet}"

Mensagem: "${text}"
`;
    const response = await sendOpenRouterRequest({
      model: MODEL,
      temperature: 0,
      messages: [{ role: 'user', content: classificationPrompt }],
    });
    const resultRaw = response.data.choices?.[0]?.message?.content || '';
    console.log(chalk.magenta(`   Classificador retornou: "${resultRaw.replace(/\n/g, ' ')}"`));
    return /^sim$/i.test(resultRaw.trim());
  } catch (error) {
    console.error(chalk.red('Erro ao classificar mensagem:'), error.response?.data || error.message || error);
    return false;
  }
}

async function sendOpenRouterRequest(body) {
  if (!OPENROUTER_API_KEY) {
    throw new Error('OpenRouter API key não configurada corretamente.');
  }

  const headers = {
    Authorization: `Bearer ${OPENROUTER_API_KEY}`,
    'Content-Type': 'application/json',
  };

  const maxAttempts = 3;
  let attempt = 0;
  while (attempt < maxAttempts) {
    try {
      const response = await axios.post(
        `${OPENROUTER_BASE_URL}/chat/completions`,
        body,
        {
          headers,
          timeout: OPENROUTER_TIMEOUT_MS,
        }
      );
      return response;
    } catch (err) {
      attempt++;
      const isTimeout = err.code === 'ECONNABORTED' || (err.message && err.message.toLowerCase().includes('timeout'));
      if (attempt >= maxAttempts || !isTimeout) {
        throw err;
      }
      const backoffMs = 500 * attempt;
      console.log(chalk.yellow(`Tentativa ${attempt} falhou por timeout, dando backoff de ${backoffMs}ms...`));
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }
}

async function processMessage(text, sessionKey, userName, chatName) {
  try {
    console.log(chalk.cyan(`→ processMessage para sessão ${sessionKey} (${userName})`));
    console.log(chalk.gray('OPENROUTER_API_KEY presente?', !!OPENROUTER_API_KEY));

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
    const response = await sendOpenRouterRequest({
      model: MODEL,
      messages: messages,
    });

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

/** store customizado Upstash Redis **/
class UpstashRedisStore {
  constructor({ url, token }) {
    this.redis = new Redis({ url, token });
    console.log(chalk.blueBright('Inicializando UpstashRedisStore...'));
  }

  async sessionExists({ session }) {
    try {
      const v = await this.redis.get(`remoteauth:${session}`);
      const exists = v !== null;
      console.log(chalk.green(`[RedisStore] sessionExists("${session}") → ${exists}`));
      return exists;
    } catch (e) {
      console.error(chalk.red(`[RedisStore] erro em sessionExists("${session}"): `), e);
      return false;
    }
  }

  async save({ session }) {
    const zipName = `${session}.zip`;
    try {
      const buf = await fs.readFile(zipName);
      const b64 = buf.toString('base64');
      await this.redis.set(`remoteauth:${session}`, b64);
      console.log(chalk.green(`[RedisStore] save("${session}") → gravado ${buf.length} bytes (base64 len=${b64.length})`));
    } catch (e) {
      console.error(chalk.red(`[RedisStore] erro em save("${session}"): `), e);
      throw e;
    }
  }

  async extract({ session, path }) {
    try {
      const b64 = await this.redis.get(`remoteauth:${session}`);
      if (!b64) {
        console.log(chalk.yellow(`[RedisStore] extract("${session}") → nada para extrair`));
        return;
      }
      const buf = Buffer.from(b64, 'base64');
      await fs.writeFile(path, buf);
      console.log(chalk.green(`[RedisStore] extract("${session}") → restaurado para "${path}" (${buf.length} bytes)`));
    } catch (e) {
      console.error(chalk.red(`[RedisStore] erro em extract("${session}"): `), e);
      throw e;
    }
  }

  async delete({ session }) {
    try {
      await this.redis.del(`remoteauth:${session}`);
      console.log(chalk.green(`[RedisStore] delete("${session}") → removido`));
    } catch (e) {
      console.error(chalk.red(`[RedisStore] erro em delete("${session}"): `), e);
    }
  }
}

async function createClient(usePinned) {
  let authStrategy;

  // usa sempre as credenciais hardcoded para RemoteAuth
  try {
    const testRedis = new Redis({
      url: UPSTASH_REDIS_REST_URL,
      token: UPSTASH_REDIS_REST_TOKEN,
    });
    const pong = await testRedis.ping().catch((e) => {
      console.warn(chalk.yellow('[Upstash] ping falhou:'), e.message || e);
      return null;
    });
    if (pong) {
      console.log(chalk.green(`[Upstash] conexão OK, ping retornou: ${pong}`));
    } else {
      console.warn(chalk.yellow('[Upstash] não validou conexão, mas segue tentando.'));
    }

    const store = new UpstashRedisStore({
      url: UPSTASH_REDIS_REST_URL,
      token: UPSTASH_REDIS_REST_TOKEN,
    });
    authStrategy = new RemoteAuth({
      clientId: 'anderson-bot', // ID fixo agora
      store,
      backupSyncIntervalMs: 10000, // sincroniza rápido
    });
    console.log(chalk.green('Usando RemoteAuth com Upstash Redis.'));
  } catch (e) {
    console.warn(chalk.yellow('Falha ao inicializar RemoteAuth (Upstash). Caindo para LocalAuth:'), e);
    authStrategy = new LocalAuth({
      clientId: 'anderson-bot', // mesma sessão fallback
      rmMaxRetries: 8,
    });
  }

  const clientOpts = {
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
  };

  if (usePinned) {
    clientOpts.webVersionCache = {
      type: 'remote',
      remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
      strict: false,
    };
  }

  const client = new Client(clientOpts);

  async function cleanExit(reason) {
    try {
      console.log(chalk.yellow('Encerrando cliente WhatsApp...'), reason || '');
      await client.destroy();
    } catch (_) {}
    process.exit(0);
  }

  process.on('SIGINT', () => cleanExit('SIGINT'));
  process.on('SIGTERM', () => cleanExit('SIGTERM'));
  process.on('uncaughtException', (err) => {
    console.error(chalk.red('Uncaught Exception (não sai automaticamente):'), err);
  });
  process.on('unhandledRejection', (reason) => {
    console.error(chalk.red('Unhandled Rejection (não sai automaticamente):'), reason);
  });

  client.on('qr', (qr) => {
    console.log(chalk.blueBright('QR code gerado (escaneie com o WhatsApp):'));
    qrcode.generate(qr, { small: true });
  });
  client.on('ready', () => {
    console.log(chalk.green('Client is ready!'));
  });

  client.on('message', async (message) => {
    console.log(chalk.blueBright('--- novo evento de message ---'));
    console.log(chalk.gray(`isGroup? ${message.from}, body: "${message.body}", mentionedIds: ${JSON.stringify(message.mentionedIds)}`));

    try {
      if (message.body === '!ping') {
        await message.reply('pong!');
        return;
      }

      if (coldStart) {
        await message.reply('⚙️  Aguarde enquanto meu servidor está carregando…');
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
        const botId = client.info?.wid?._serialized;
        const isMentioned = message.mentionedIds?.includes(botId);
        if (!isMentioned) {
          if (USE_LOCAL_HEURISTIC && localHeuristicTrigger(message.body)) {
            shouldRespond = true;
          } else {
            const contextSnippet = '';
            shouldRespond = await analyzeIfMessageIsForAI(message.body, contextSnippet);
            if (!shouldRespond) return;
          }
        }
      }

      const responseMessage = await processMessage(message.body, sessionKey, userName, chatName);
      if (isGroup) {
        await message.reply(responseMessage, { mentions: [contact] });
      } else {
        await message.reply(responseMessage);
      }
    } catch (err) {
      console.error(chalk.red('Erro no handler de mensagem:'), err);
      try {
        await message.reply('Desculpe, ocorreu um erro ao processar sua mensagem.');
      } catch (_) {}
    }
  });

  try {
    await client.initialize();
    return client;
  } catch (err) {
    console.warn(chalk.yellow('Inicialização com pinagem falhou, tentando sem versionamento fixo...'), err.message);
    if (usePinned) {
      return createClient(false);
    }
    throw err;
  }
}

(async () => {
  console.log(chalk.blueBright('Iniciando bot do WhatsApp...'));
  try {
    await createClient(true);
  } catch (e) {
    console.error(chalk.red('Falha crítica ao inicializar o client:'), e);
    process.exit(1);
  }
})();
