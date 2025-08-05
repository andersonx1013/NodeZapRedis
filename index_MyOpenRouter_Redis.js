'use strict';

// --- ajustes de ambiente e compatibilidade ---
const os = require('os');
const path = require('path');

// evita locks no chrome debug log
process.env.CHROME_LOG_FILE = path.join(os.tmpdir(), 'wweb_chrome_debug.log');

// shim opcional de punycode (deprecated warning)
try { require('punycode'); } catch (_) { /* sem shim, warning é inofensivo */ }

const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
if (nodeMajor >= 21) {
  console.warn(`Você está rodando Node.js v${process.versions.node}. O aviso sobre punycode ([DEP0040]) é esperado e pode ser ignorado ou mitigado com um shim.`);
}

// --- dependências ---
const { Client, LocalAuth, RemoteAuth } = require('whatsapp-web.js');
const { Redis } = require('@upstash/redis');
const fs = require('fs/promises');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const express = require('express'); // <-- ADIÇÃO NECESSÁRIA

// chalk para logs com fallback
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

// --- configurações ---
// Upstash Redis hardcoded conforme você forneceu
const UPSTASH_REDIS_REST_URL = 'https://humorous-koi-8598.upstash.io';
const UPSTASH_REDIS_REST_TOKEN = 'ASGWAAIjcDFiNWQ0MmRiZjIxODg0ZTdkYWYxMzQ0N2QxYTBhZTc0YnAxMA';

// OpenRouter (Use as variáveis de ambiente no painel do Render.com)
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://myopenrouter.onrender.com/api/v1';
const MODEL = 'qwen/qwen3-coder:free';

// comportamento ajustável via env
const SKIP_CLASSIFICATION = !!process.env.SKIP_CLASSIFICATION;
const USE_LOCAL_HEURISTIC = process.env.USE_LOCAL_HEURISTIC !== '0';

// histórico por sessão
const conversationHistory = {};

// flag para cold start (courtesy ping)
let coldStart = true;

// system prompt (SEU TEXTO COMPLETO E INTACTO)
const systemMessage = `
🚫 NÃO forneça exemplos de código, trechos \`\`\`, comandos de terminal ou descrições técnicas de programação, a menos que o usuário peça explicitamente. Quando o assunto for programação sem pedido de código, responda em linguagem natural, sem mostrar sintaxe. Remova qualquer bloco de código se o usuário não solicitou.

Responderei somente o que o usuário quer saber de forma objetiva e descontraída e em primeira pessoa, sempre em português brasileiro. Se o usuário pedir para trocar o idioma, você pode falar em outro. Direi informações sobre o CV somente se o usuário perguntar. Só responderei coisas relacionadas ao meu currículo. Eu fui criado pelo Anderson. Eu sou o avatar de Anderson Xavier. Tenho 40 anos. Residente em São Paulo - SP, Brasil. Tenho mais de 20 anos de experiência no mercado de TI, atuando de forma multidisciplinar em processos e tecnologias. Meu contato é andersonx1013@gmail.com e (+55)16 99740-5919 (Business). Atuo como Arquiteto de Software e Líder Técnico, com vasta experiência em desenvolvimento de software e serviços, abrangendo desde o design até a implementação e otimização do ciclo de vida completo. Minhas principais habilidades técnicas incluem desenvolvimento web e mobile com NodeJS, React, React Native, JavaScript, C# (.NET Core e Desktop), Razor, WebForms, MVC e WebAPI, além de back-end e APIs com NodeJS, C#, Java e Python. Possuo expertise em cloud computing, trabalhando com AWS, GCP e Azure (DevOps), utilizando Docker e Kubernetes para orquestração e arquiteturas serverless. Tenho profundo conhecimento em bancos de dados SQL Server, PostgreSQL, Neo4J, MongoDB, Redis, Oracle, MySQL e ElasticSearch. Na área de Inteligência Artificial, Machine Learning e Data Science, trabalho com Python e R, NLP, IA, Deep Learning, modelos GPT (3 e 4), TensorFlow, PyTorch, RASA, Hugging Face, LangChain, Llama 2 e estatística com R Studio e Anaconda. Minhas competências se estendem a DevOps e infraestrutura, incluindo CI/CD, Git, servidores de aplicação como WebLogic e IIS, e virtualização com VMWare. Sou especialista em segurança, abrangendo Cryptography (RSA, AES, TLS), IAM (OAuth 2.0, Keycloak), DevSecOps (Snyk, Trivy), Pentesting (Kali, Nmap), SIEM (Splunk, Sentinel), OWASP Top 10, GDPR/LGPD e segurança de APIs e containers (JWT, Falco), além de resiliência (DDoS, WAF). Também possuo experiência com RabbitMQ, Kafka, ElasticSearch e SonarQube. Aplico metodologias ágeis como Scrum, Safe e Kanban, Design Thinking, UML, BPM, PMI, Gerenciamento de Mudanças (Germud), C4 Model e RUP. Tenho experiência em gerenciamento de equipes, recrutamento, gestão de projetos, definição de KPIs, gestão de custos (Capex/Opex), garantia da qualidade, operações, comunicação com executivos (CEOs) e formação de times. Aplico padrões de design e arquitetura como Abstract Factory, Facade, MVC, Microservices (Hexagonal, Vertical Slice, EDA) e SOA. Ao se apresentar responderei de forma objetiva e curta. Devo ficar esperto se a pessoa está me elogiando, agradecendo ou encerrando a conversa e nesse caso faço mesmo sem ficar falando do meu currículo a todo momento. Leve em conta sempre o nome da pessoa na hora de responder. Sempre levar em consideração as respostas anteriores para não responder besteira. O que você não souber a respeito do currículo dele diga que não sabe e passe o contato. Nas horas vagas gosto de estudar tecnologias emergentes, ver filmes com minha família, brincar com meu filho David e jogar jogos eletrônicos tipo Starcraft. Sou casado. Meus defeitos são que sou muito perfeccionista e ansioso. Minhas qualidades são entusiasmo e adoro ajudar pessoas a se desenvolverem tanto na vida profissional quanto pessoal. Prefiro backend a frontend. Gosto de comer pizza, arroz, feijão e ovo cozido. Notar se a mensagem é para mim com base no contexto das respostas anteriores, também indiretamente. Se alguém tirar ou fizer piadinhas comigo responderei ironicamente com uma piada.
`;

/** TODAS AS SUAS FUNÇÕES ORIGINAIS E INTACTAS **/
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
      clientId: 'anderson-bot',
      store,
      backupSyncIntervalMs: 120000,
    });
    console.log(chalk.green('Usando RemoteAuth com Upstash Redis.'));
  } catch (e) {
    console.error(chalk.red('Falha CRÍTICA ao conectar ao Redis. O bot não pode iniciar.'), e);
    throw new Error("Não foi possível conectar ao Redis, encerrando.");
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
    console.error(chalk.red('Uncaught Exception:'), err);
    cleanExit('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    console.error(chalk.red('Unhandled Rejection:'), reason);
    cleanExit('unhandledRejection');
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
        console.log('Recebeu !ping, respondendo pong.');
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
        console.log(chalk.gray(`   Mensagem em grupo. Mencionado? ${isMentioned}`));

        if (!isMentioned) {
          if (USE_LOCAL_HEURISTIC && localHeuristicTrigger(message.body)) {
            console.log(chalk.gray('   Heurística local disparou, respondendo sem classificador.'));
            shouldRespond = true;
          } else {
            const contextSnippet = buildContextSnippet(conversationHistory[sessionKey].history, 3);
            shouldRespond = await analyzeIfMessageIsForAI(message.body, contextSnippet);
            console.log(chalk.gray(`   analyzeIfMessageIsForAI → ${shouldRespond}`));
            if (!shouldRespond) {
              console.log(chalk.yellow('   → Ignorando mensagem (não era para a IA).'));
              return;
            }
          }
        }
      }

      const responseMessage = await processMessage(message.body, sessionKey, userName, chatName);
      console.log(chalk.green(`   Resposta gerada: "${responseMessage}"`));

      const replyOptions = {};
      if (isGroup) {
        replyOptions.mentions = [contact];
        await message.reply(`@${contact.id.user} ${responseMessage}`, replyOptions);
      } else {
        await message.reply(responseMessage);
      }

      console.log(chalk.green('   ✔ Resposta enviada com sucesso!'));
    } catch (err) {
      console.error(chalk.red('⚠ Erro no handler de mensagem:'), err);
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

// --- PONTO DE ENTRADA MODIFICADO PARA O RENDER.COM ---

// 1. Inicia o servidor web para o Render não reclamar da porta
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.status(200).send('Servidor do Bot está ativo. Cliente WhatsApp rodando em segundo plano.');
});

app.listen(PORT, () => {
  console.log(chalk.green(`Servidor web de health check rodando na porta ${PORT}.`));
});

// 2. Inicia o bot do WhatsApp (seu código original) em segundo plano
(async () => {
  console.log(chalk.blueBright('Iniciando o bot do WhatsApp...'));
  try {
    await createClient(true);
  } catch (e) {
    console.error(chalk.red('Falha crítica ao inicializar o client do WhatsApp:'), e);
  }
})();
