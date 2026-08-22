const express  = require('express');
const session  = require('express-session');
const fs       = require('fs');
const fsp      = require('fs').promises;
const path     = require('path');
const https    = require('https');
const crypto   = require('crypto');

const app    = express();
const PORT   = process.env.PORT || 3000;
const SENHA  = process.env.SENHA_SISTEMA || 'compose2024';

// ── VERSÃO estável: hash dos arquivos principais ─────────────────────────────
// Usa SHA-1 dos arquivos em vez de Date.now(), então restarts sem mudança de
// código não geram uma nova versão e não forçam reload nos clientes.
function _hashArquivo(p) {
  try { return crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 10); }
  catch (_) { return '0'; }
}
const VERSAO = _hashArquivo(path.join(__dirname, 'index.html')) +
               _hashArquivo(path.join(__dirname, 'style.css'));

// ── SESSION SECRET persistente ────────────────────────────────────────────────
// Se SESSION_SECRET não está no env, lê de um arquivo local (criado na 1ª vez).
// Assim restarts não invalidam sessões abertas.
const SECRET_PATH = path.join(__dirname, '.session-secret');
function _getSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  try { return fs.readFileSync(SECRET_PATH, 'utf8').trim(); } catch (_) {}
  const s = 'cps-' + crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(SECRET_PATH, s); } catch (_) {}
  return s;
}
const SECRET = _getSecret();

// ── STORAGE: PostgreSQL (produção) ou arquivo JSON (dev local) ──────────────
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  pool.query(`
    CREATE TABLE IF NOT EXISTS dados (
      id    TEXT PRIMARY KEY,
      valor JSONB NOT NULL DEFAULT '{}'
    )
  `).catch(e => console.error('Erro ao criar tabela:', e.message));
  console.log('Storage: PostgreSQL');
} else {
  console.log('Storage: arquivo dados.json (dev local)');
}

const DADOS_PATH = path.join(process.env.DADOS_DIR || __dirname, 'dados.json');

// ── USUÁRIOS ──────────────────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, 'users.json');
function hashSenha(s){ return crypto.createHash('sha256').update(s+':cps2024').digest('hex'); }
function readUsers(){ try{ return JSON.parse(fs.readFileSync(USERS_FILE,'utf8')); }catch{ return []; } }
function writeUsers(u){ fs.writeFileSync(USERS_FILE, JSON.stringify(u,null,2)); }
if(!fs.existsSync(USERS_FILE)){
  writeUsers([{id:'1',nome:'Administrador',login:'admin',senha:hashSenha(SENHA),perfil:'admin',ativo:true,permissoes:{},criadoEm:Date.now()}]);
  console.log('users.json criado. Login: admin / Senha: '+SENHA);
}

// Cache in-memory do lastModified para evitar carregar o payload inteiro no polling
let _lastModifiedCache = null;

async function lerDados() {
  if (pool) {
    try {
      const r = await pool.query("SELECT valor FROM dados WHERE id = 'main'");
      const d = r.rows[0] ? r.rows[0].valor : {};
      if (_lastModifiedCache === null) _lastModifiedCache = d._lastModified || 0;
      return d;
    } catch (e) { console.error('lerDados erro:', e.message); return {}; }
  }
  try {
    const d = JSON.parse(fs.readFileSync(DADOS_PATH, 'utf8'));
    if (_lastModifiedCache === null) _lastModifiedCache = d._lastModified || 0;
    return d;
  } catch { return {}; }
}

async function salvarDados(data) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO dados(id, valor) VALUES('main', $1)
         ON CONFLICT(id) DO UPDATE SET valor = $1`,
        [JSON.stringify(data)]
      );
    } catch (e) { console.error('salvarDados erro:', e.message); throw e; }
    return;
  }
  // Modo dev: escreve de forma assíncrona (não bloqueia o event loop)
  await fsp.writeFile(DADOS_PATH, JSON.stringify(data, null, 2));
}

// ── MUTEX de escrita ──────────────────────────────────────────────────────────
// Serializa todas as chamadas de leitura-modificação-escrita em fila para
// eliminar race condition quando dois dispositivos salvam ao mesmo tempo.
let _writeLock = Promise.resolve();
function writeLocked(fn) {
  const result = _writeLock.then(fn);
  _writeLock = result.catch(function () {}); // erro não quebra a fila
  return result;
}

// Inicializa arquivo JSON local se necessário
if (!pool && !fs.existsSync(DADOS_PATH)) {
  fs.writeFileSync(DADOS_PATH, JSON.stringify({
    cps_orc: [], cps_cor: [], cps_tap: [], cps_piso: [],
    cps_cort: [], cps_kb: {}, cps_notas: [], cps_lixeira: [],
    cps_agenda: [], cps_colab: []
  }, null, 2));
}

// ── MIDDLEWARES ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }
}));

function auth(req, res, next) {
  if (req.session && req.session.logado) return next();
  res.redirect('/login');
}
function authAdmin(req, res, next) {
  if (req.session && req.session.logado && (req.session.perfil === 'admin' || !req.session.perfil)) return next();
  res.status(403).json({ erro: 'Acesso negado.' });
}

// ── RATE LIMITING DO LOGIN ────────────────────────────────────────────────────
const _loginAttempts = new Map();
const LOGIN_MAX    = 10;                // máx tentativas
const LOGIN_JANELA = 15 * 60 * 1000;   // janela de 15 minutos

function _loginBloqueado(ip) {
  const agora = Date.now();
  const e = _loginAttempts.get(ip) || { n: 0, inicio: agora };
  if (agora - e.inicio > LOGIN_JANELA) {
    _loginAttempts.set(ip, { n: 1, inicio: agora });
    return false;
  }
  if (e.n >= LOGIN_MAX) return true;
  e.n++;
  _loginAttempts.set(ip, e);
  return false;
}
function _loginReset(ip) { _loginAttempts.delete(ip); }

// Limpa entradas antigas a cada hora
setInterval(() => {
  const agora = Date.now();
  for (const [ip, e] of _loginAttempts) {
    if (agora - e.inicio > LOGIN_JANELA) _loginAttempts.delete(ip);
  }
}, 60 * 60 * 1000);

// ── ROTAS ────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.logado) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  if (_loginBloqueado(ip)) return res.redirect('/login?erro=2');
  const { login: loginInput, senha } = req.body;
  const users = readUsers();
  const user = users.find(u => u.ativo && u.login === (loginInput||'').trim() && u.senha === hashSenha(senha||''));
  if (user) {
    _loginReset(ip);
    req.session.logado = true;
    req.session.userId = user.id;
    req.session.perfil = user.perfil;
    req.session.nome = user.nome;
    req.session.login = user.login;
    req.session.permissoes = user.permissoes || {};
    res.redirect('/');
  } else {
    res.redirect('/login?erro=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', auth, (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/style.css', auth, (req, res) => res.sendFile(path.join(__dirname, 'style.css')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo_transp.png')));
app.get('/update-gif.gif', (req, res) => res.sendFile(path.join(__dirname, 'update-gif.gif')));

app.get('/update-video.mp4', (req, res) => {
  const p = path.join(__dirname, 'update-video.mp4');
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});
app.get('/update-audio.mp3', (req, res) => {
  const p = path.join(__dirname, 'update-audio.mp3');
  if (!fs.existsSync(p)) return res.status(404).end();
  res.sendFile(p);
});

app.get('/versao', (req, res) => res.json({ v: VERSAO }));

app.get('/me', auth, (req, res) => {
  res.json({
    id: req.session.userId || null,
    nome: req.session.nome || 'Administrador',
    login: req.session.login || 'admin',
    perfil: req.session.perfil || 'admin',
    permissoes: req.session.permissoes || {}
  });
});

// ── CRUD USUÁRIOS (admin) ─────────────────────────────────────────────────────
app.get('/usuarios', authAdmin, (req, res) => {
  res.json(readUsers().map(u => ({ id:u.id, nome:u.nome, login:u.login, perfil:u.perfil, ativo:u.ativo, permissoes:u.permissoes||{}, criadoEm:u.criadoEm })));
});

app.post('/usuarios', authAdmin, (req, res) => {
  const users = readUsers();
  const { nome, login, senha, perfil, permissoes } = req.body;
  if (!nome || !login || !senha || !perfil) return res.status(400).json({ erro: 'Campos obrigatórios.' });
  if (users.some(u => u.login === login.trim())) return res.status(400).json({ erro: 'Login já existe.' });
  const user = { id: crypto.randomBytes(8).toString('hex'), nome: nome.trim(), login: login.trim(), senha: hashSenha(senha), perfil, ativo: true, permissoes: permissoes||{}, criadoEm: Date.now() };
  users.push(user);
  writeUsers(users);
  res.json({ ok: true, user: { ...user, senha: undefined } });
});

app.put('/usuarios/:id', authAdmin, (req, res) => {
  const users = readUsers();
  const idx = users.findIndex(u => u.id === req.params.id);
  if (idx === -1) return res.status(404).json({ erro: 'Não encontrado.' });
  const { nome, login, senha, perfil, ativo, permissoes } = req.body;
  if (login && login.trim() !== users[idx].login && users.some(u => u.login === login.trim())) return res.status(400).json({ erro: 'Login já existe.' });
  users[idx] = { ...users[idx],
    nome: nome ? nome.trim() : users[idx].nome,
    login: login ? login.trim() : users[idx].login,
    perfil: perfil || users[idx].perfil,
    ativo: ativo !== undefined ? ativo : users[idx].ativo,
    permissoes: permissoes !== undefined ? permissoes : users[idx].permissoes,
    ...(senha ? { senha: hashSenha(senha) } : {})
  };
  writeUsers(users);
  res.json({ ok: true, user: { ...users[idx], senha: undefined } });
});

app.delete('/usuarios/:id', authAdmin, (req, res) => {
  const users = readUsers();
  const user = users.find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ erro: 'Não encontrado.' });
  if (user.perfil === 'admin' && users.filter(u => u.perfil === 'admin' && u.ativo).length <= 1) return res.status(400).json({ erro: 'Não pode excluir o único administrador.' });
  writeUsers(users.filter(u => u.id !== req.params.id));
  res.json({ ok: true });
});

app.get('/dados', auth, async (req, res) => {
  try { res.json(await lerDados()); }
  catch (e) { res.status(500).json({ erro: e.message }); }
});

// Endpoint leve de polling — retorna só o timestamp da última modificação.
// Usa cache in-memory, sem carregar o payload inteiro do banco a cada 12s.
app.get('/dados/status', auth, (req, res) => {
  res.json({ lastModified: _lastModifiedCache || 0 });
});

app.post('/dados', auth, async (req, res) => {
  try {
    const lm = await writeLocked(async () => {
      const existing = await lerDados();
      const incoming = req.body;
      const changedKey = incoming._changed || null;
      const ts = Date.now();

      const merged = Object.assign({}, existing);
      if (changedKey && Object.prototype.hasOwnProperty.call(incoming, changedKey)) {
        merged[changedKey] = incoming[changedKey];
      }
      merged._lastModified = ts;

      // Backup automático diário em dev (arquivo local)
      if (!pool) {
        const today = new Date().toISOString().slice(0, 10);
        const backupPath = path.join(process.env.DADOS_DIR || __dirname, `dados_backup_${today}.json`);
        if (!fs.existsSync(backupPath) && fs.existsSync(DADOS_PATH)) {
          try { await fsp.copyFile(DADOS_PATH, backupPath); } catch (_) {}
        }
      }

      await salvarDados(merged);
      _lastModifiedCache = ts; // atualiza cache
      return ts;
    });

    res.json({ ok: true, lastModified: lm });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// Endpoint de backup — download do JSON completo
app.get('/backup', auth, async (req, res) => {
  try {
    const d = await lerDados();
    const filename = `compose_backup_${new Date().toISOString().slice(0, 10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(d, null, 2));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/importar', auth, async (req, res) => {
  try {
    const { senha, dados } = req.body;
    if (!senha || senha !== SENHA)
      return res.status(403).json({ ok: false, erro: 'Senha incorreta.' });
    if (!dados || typeof dados !== 'object' || Array.isArray(dados))
      return res.status(400).json({ ok: false, erro: 'Arquivo inválido.' });

    // Valida que ao menos uma chave conhecida existe — impede importar JSON aleatório
    const CHAVES_VALIDAS = ['cps_orc','cps_cor','cps_tap','cps_piso','cps_cort',
                            'cps_kb','cps_notas','cps_lixeira','cps_agenda','cps_colab'];
    const temChaveValida = CHAVES_VALIDAS.some(k => k in dados);
    if (!temChaveValida)
      return res.status(400).json({ ok: false, erro: 'Arquivo não parece ser um backup Composê válido.' });

    const lm = Date.now();
    const payload = Object.assign({}, dados, { _lastModified: lm });

    // Backup do estado atual antes de sobrescrever
    if (!pool) {
      const today = new Date().toISOString().slice(0, 10);
      const backupPath = path.join(process.env.DADOS_DIR || __dirname, `dados_backup_pre_import_${today}.json`);
      try { const cur = await lerDados(); await fsp.writeFile(backupPath, JSON.stringify(cur, null, 2)); } catch (_) {}
    }

    await writeLocked(async () => {
      await salvarDados(payload);
      _lastModifiedCache = lm;
    });

    res.json({ ok: true, lastModified: lm });
  } catch (e) { res.status(500).json({ ok: false, erro: e.message }); }
});

// ── PROXY AUGE API ───────────────────────────────────────────────────────────
const AUGE_BASE = process.env.AUGE_BASE || 'https://api-kazza.auge.app/portal/';
const AUGE_USER = process.env.AUGE_USER || '60010394000190';
const AUGE_PASS = process.env.AUGE_PASS || '12345678';

function augeRequest(caminho) {
  return new Promise((resolve, reject) => {
    const url = new URL(caminho, AUGE_BASE);
    const auth = Buffer.from(`${AUGE_USER}:${AUGE_PASS}`).toString('base64');
    https.get(url.toString(), { headers: { Authorization: `Basic ${auth}` } }, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    }).on('error', reject);
  });
}

function xmlParseList(xml, tag) {
  const items = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`, 'g');
  let m;
  while ((m = re.exec(xml)) !== null) {
    const block = m[1];
    const obj = {};
    const fieldRe = /<(\w+)>([\s\S]*?)<\/\1>/g;
    let f;
    while ((f = fieldRe.exec(block)) !== null) obj[f[1]] = f[2].trim();
    items.push(obj);
  }
  return items;
}

app.get('/auge/orcamentos', auth, async (req, res) => {
  try {
    const qs = new URLSearchParams(req.query).toString();
    const { status, body } = await augeRequest('dyn/fn/Orcamento' + (qs ? '?' + qs : ''));
    if (status !== 200) return res.status(status).json({ erro: 'Auge retornou ' + status });
    res.json(xmlParseList(body, 'Orcamento'));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.get('/auge/orcamento-itens/:id', auth, async (req, res) => {
  try {
    const { status, body } = await augeRequest('dyn/fn/OrcamentoItem?idOrcamento=' + encodeURIComponent(req.params.id));
    if (status !== 200) return res.status(status).json({ erro: 'Auge retornou ' + status });
    res.json(xmlParseList(body, 'OrcamentoItem'));
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

// Rota de debug do Auge — disponível apenas se AUGE_DEBUG=true no ambiente
if (process.env.AUGE_DEBUG === 'true') {
  app.get('/auge/raw/:caminho(*)', auth, async (req, res) => {
    try {
      const { status, body } = await augeRequest(req.params.caminho);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(`STATUS: ${status}\n\n${body}`);
    } catch (e) { res.send('ERRO: ' + e.message); }
  });
}

// ── IA — GEMINI ─────────────────────────────────────────────────────────────
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function geminiCall(body) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-flash-latest:generateContent',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-goog-api-key': GEMINI_KEY,
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req2 = https.request(opts, r => {
      let raw = ''; r.on('data', d => raw += d); r.on('end', () => resolve({ status: r.statusCode, body: raw }));
    });
    req2.on('error', reject); req2.write(body); req2.end();
  });
}

async function geminiComRetry(body) {
  let result;
  for (let t = 1; t <= 3; t++) {
    result = await geminiCall(body);
    if (result.status !== 503) break;
    console.log(`[Gemini] 503 sobrecarga, tentativa ${t}/3...`);
    await sleep(2000 * t);
  }
  return result;
}

app.post('/ia/gerar-orcamento', auth, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ erro: 'IA não configurada (GEMINI_API_KEY ausente).' });
  const { texto, exemplos } = req.body;
  if (!texto) return res.status(400).json({ erro: 'Texto das anotações não informado.' });

  const exemplosTxt = (exemplos || []).slice(0, 6).map((e, i) =>
    `EXEMPLO ${i+1}:\nAnotação: ${e.anotacao}\nOrçamento gerado:\n${e.itens.map(it =>
      `- Título: ${it.titulo}\n  Preço: ${it.preco}\n  Detalhes: ${it.linhas.join(' | ')}`
    ).join('\n')}`
  ).join('\n\n');

  const prompt = `Você é um assistente especializado em orçamentos para a empresa Composê Home, que vende cortinas, persianas, tapetes e tapeçaria em Santos-SP.

${exemplosTxt ? `EXEMPLOS DE ORÇAMENTOS JÁ FEITOS PELA COMPOSÊ (use como referência de estilo e preços):\n${exemplosTxt}\n\n` : ''}ANOTAÇÃO DO CLIENTE:
${texto}

Com base nas anotações acima, gere os itens do orçamento no formato JSON abaixo. Cada item deve ter:
- "titulo": nome do ambiente + tipo do produto em MAIÚSCULAS (ex: "SALA - CORTINA ROLÔ")
- "preco": valor em reais formatado (ex: "R$ 1.200,00")
- "linhas": array com 4 linhas de detalhes em MAIÚSCULAS:
  - Linha 1: quantidade + tipo + cor/modelo
  - Linha 2: MANUAL ou MOTORIZADO
  - Linha 3: 3 ANOS DE GARANTIA
  - Linha 4: INSTALAÇÃO INCLUSA

Responda APENAS com o JSON, sem texto adicional:
{"itens": [...]}`;

  try {
    const result = await geminiComRetry(JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }));
    if (result.status !== 200) {
      let detalhe = ''; try { detalhe = JSON.parse(result.body)?.error?.message || ''; } catch(_) {}
      return res.status(502).json({ erro: 'Gemini ' + result.status + (detalhe ? ': ' + detalhe : '') });
    }
    const parsed = JSON.parse(result.body);
    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ erro: 'IA não retornou JSON válido.' });
    res.json(JSON.parse(jsonMatch[0]));
  } catch (e) { console.error('[Gemini] erro:', e.message); res.status(500).json({ erro: e.message }); }
});

app.post('/ia/ler-quantitativo', auth, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ erro: 'IA não configurada (GEMINI_API_KEY ausente).' });
  const { arquivos, tipo } = req.body;
  if (!Array.isArray(arquivos) || !arquivos.length) return res.status(400).json({ erro: 'Nenhum arquivo enviado.' });
  if (arquivos.length > 6) return res.status(400).json({ erro: 'Envie no máximo 6 arquivos por vez.' });

  const partesArquivo = [];
  for (const a of arquivos) {
    if (!a || !a.mimeType || !a.data) return res.status(400).json({ erro: 'Arquivo inválido.' });
    if (!/^(image\/|application\/pdf)/.test(a.mimeType)) return res.status(400).json({ erro: 'Tipo de arquivo não suportado: ' + a.mimeType });
    partesArquivo.push({ inline_data: { mime_type: a.mimeType, data: a.data } });
  }

  const ehPiso = tipo === 'piso';
  const prompt = ehPiso
    ? `Você é um assistente que lê fotos ou PDFs de um quantitativo/planilha de medidas de piso e extrai os dados por ambiente.\n\nPara cada ambiente encontrado, extraia:\n- "ambiente": nome do ambiente (ex: "SALA", "QUARTO 1")\n- "area": metragem quadrada (m²) do ambiente, como número (ex: 22.5). Se só houver largura e comprimento, calcule a área multiplicando-os.\n- "rodape": metragem linear (ml) de rodapé do ambiente, como número, se houver essa informação. Caso não exista, use null.\n\nResponda APENAS com o JSON, sem texto adicional:\n{"ambientes": [{"ambiente": "...", "area": 0, "rodape": null}]}`
    : `Você é um assistente que lê fotos ou PDFs de um quantitativo/planilha de medidas de cortina e extrai os dados por ambiente.\n\nPara cada ambiente encontrado, extraia:\n- "ambiente": nome do ambiente (ex: "SALA", "QUARTO 1")\n- "largura": largura do vão/ambiente em metros, como número (ex: 3.07)\n- "altura": altura em metros, como número (ex: 2.76)\n\nResponda APENAS com o JSON, sem texto adicional:\n{"ambientes": [{"ambiente": "...", "largura": 0, "altura": 0}]}`;

  try {
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }, ...partesArquivo] }] });
    const result = await geminiComRetry(body);
    if (result.status !== 200) {
      let detalhe = ''; try { detalhe = JSON.parse(result.body)?.error?.message || ''; } catch(_) {}
      return res.status(502).json({ erro: 'Gemini ' + result.status + (detalhe ? ': ' + detalhe : '') });
    }
    const parsed = JSON.parse(result.body);
    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ erro: 'IA não retornou JSON válido.' });
    const dados = JSON.parse(jsonMatch[0]);
    res.json({ ambientes: dados.ambientes || [] });
  } catch (e) { console.error('[Gemini] erro:', e.message); res.status(500).json({ erro: e.message }); }
});

app.post('/ia/chat', auth, async (req, res) => {
  if (!GEMINI_KEY) return res.status(503).json({ erro: 'IA não configurada (GEMINI_API_KEY ausente).' });
  const { mensagens } = req.body;
  if (!Array.isArray(mensagens) || !mensagens.length) return res.status(400).json({ erro: 'Nenhuma mensagem enviada.' });
  if (mensagens.length > 40) return res.status(400).json({ erro: 'Conversa muito longa, inicie um novo chat.' });

  const contents = [];
  for (const m of mensagens) {
    if (!m || (m.role !== 'user' && m.role !== 'model')) return res.status(400).json({ erro: 'Mensagem inválida.' });
    const parts = [];
    if (m.texto) parts.push({ text: String(m.texto) });
    if (Array.isArray(m.arquivos)) {
      for (const a of m.arquivos) {
        if (!a || !a.mimeType || !a.data) continue;
        if (!/^(image\/|application\/pdf)/.test(a.mimeType)) return res.status(400).json({ erro: 'Tipo de arquivo não suportado: ' + a.mimeType });
        parts.push({ inline_data: { mime_type: a.mimeType, data: a.data } });
      }
    }
    if (!parts.length) continue;
    contents.push({ role: m.role, parts });
  }
  if (!contents.length) return res.status(400).json({ erro: 'Mensagens vazias.' });

  const systemInstruction = {
    parts: [{ text: `Você é o assistente interno da Composê Home, empresa de cortinas, persianas, tapetes, pisos e tapeçaria em Santos-SP. Você conhece todo o sistema de gestão da empresa (orçamentos, pipeline de vendas, calculadoras de cortina e piso, tabelas de preço de fornecedores cadastradas, agenda de visitas/instalações e clientes) e conversa com o vendedor/orçamentista para ajudá-lo a:
- Interpretar quantitativos, fotos de medidas, planilhas e anotações de clientes;
- Montar e revisar orçamentos e cálculos de cortina/piso;
- Consultar as tabelas de preço cadastradas (fornecedor, tipo, observações) quando o usuário perguntar sobre preços ou materiais disponíveis;
- Ajudar a decidir prioridades: o que cobrar primeiro, quais orçamentos estão pendentes há muito tempo, o que está agendado a seguir;
- Dar sugestões práticas de precificação, prazos e follow-up com clientes.

A cada mensagem, você recebe um bloco "[CONTEXTO ATUAL DO SISTEMA]" com dados reais e atualizados (tabelas cadastradas, orçamentos pendentes de cobrança, próximos compromissos da agenda) — use esses dados para responder com precisão, cite nomes e números reais quando fizer sentido, e não invente informações que não estejam lá. Nunca repita esse bloco de contexto de volta para o usuário, apenas use-o para embasar a resposta.

Seja MUITO direto e breve: respostas curtas, de preferência 1 a 4 frases ou uma lista curta. Sem introduções longas, sem repetir a pergunta, sem parágrafos de contexto desnecessário. Só se aprofunde se o usuário pedir mais detalhes. Converse em português, como um colega de trabalho que conhece o negócio. Quando o usuário enviar fotos ou PDFs de quantitativos, leia com atenção e responda direto com os ambientes e medidas encontrados, tirando dúvidas apenas quando a leitura estiver ambígua.

REGRA CRÍTICA DE CONFERÊNCIA: antes de enviar QUALQUER resposta que envolva números, medidas, datas ou cálculo (metragem, valores, quantidades, prazos, leitura de quantitativo, etc.), refaça o cálculo mentalmente do zero e confira o resultado no mínimo 4 vezes, inclusive testando o cálculo por um caminho diferente (ex: refazer a conta na ordem inversa, ou conferir a soma somando os termos em outra sequência) até bater as 4 conferências. Se alguma conferência der um resultado diferente, refaça tudo de novo até as 4 baterem. Não mostre essas conferências ao usuário — faça isso silenciosamente e só entregue a resposta final já revisada. Se não tiver certeza absoluta de um número após conferir, diga isso claramente em vez de arriscar um valor errado.` }]
  };

  try {
    const body = JSON.stringify({ system_instruction: systemInstruction, contents });
    const result = await geminiComRetry(body);
    if (result.status !== 200) {
      let detalhe = ''; try { detalhe = JSON.parse(result.body)?.error?.message || ''; } catch(_) {}
      return res.status(502).json({ erro: 'Gemini ' + result.status + (detalhe ? ': ' + detalhe : '') });
    }
    const parsed = JSON.parse(result.body);
    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) return res.status(502).json({ erro: 'IA não retornou resposta.' });
    res.json({ resposta: text });
  } catch (e) { console.error('[Gemini] erro:', e.message); res.status(500).json({ erro: e.message }); }
});

app.listen(PORT, () => {
  console.log(`Composê rodando em http://localhost:${PORT}`);
  console.log(`Versão: ${VERSAO}`);
});
