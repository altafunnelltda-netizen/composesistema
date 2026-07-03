const express  = require('express');
const session  = require('express-session');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');

const app    = express();
const PORT   = process.env.PORT || 3000;
const VERSAO = Date.now(); // timestamp de inicialização — muda a cada novo deploy
const SENHA  = process.env.SENHA_SISTEMA || 'compose2024';
const SECRET = process.env.SESSION_SECRET || 'cps-' + Math.random().toString(36).slice(2);

// ── STORAGE: PostgreSQL (produção) ou arquivo JSON (dev local) ──────────────
const DATABASE_URL = process.env.DATABASE_URL;
let pool = null;

if (DATABASE_URL) {
  const { Pool } = require('pg');
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  // Garante que a tabela existe
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

async function lerDados() {
  if (pool) {
    try {
      const r = await pool.query("SELECT valor FROM dados WHERE id = 'main'");
      return r.rows[0] ? r.rows[0].valor : {};
    } catch (e) {
      console.error('lerDados erro:', e.message);
      return {};
    }
  }
  try {
    return JSON.parse(fs.readFileSync(DADOS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function salvarDados(data) {
  if (pool) {
    try {
      await pool.query(
        `INSERT INTO dados(id, valor) VALUES('main', $1)
         ON CONFLICT(id) DO UPDATE SET valor = $1`,
        [JSON.stringify(data)]
      );
    } catch (e) {
      console.error('salvarDados erro:', e.message);
      throw e;
    }
    return;
  }
  fs.writeFileSync(DADOS_PATH, JSON.stringify(data, null, 2));
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

// ── ROTAS ────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session && req.session.logado) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'login.html'));
});

app.post('/login', (req, res) => {
  if (req.body.senha === SENHA) {
    req.session.logado = true;
    res.redirect('/');
  } else {
    res.redirect('/login?erro=1');
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

app.get('/', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/style.css', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});

app.get('/logo.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo_transp.png'));
});

app.get('/versao', (req, res) => {
  res.json({ v: VERSAO });
});

app.get('/dados', auth, async (req, res) => {
  try {
    res.json(await lerDados());
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// Endpoint leve — só retorna o timestamp da última modificação
app.get('/dados/status', auth, async (req, res) => {
  try {
    const d = await lerDados();
    res.json({ lastModified: d._lastModified || 0 });
  } catch (e) {
    res.json({ lastModified: 0 });
  }
});

app.post('/dados', auth, async (req, res) => {
  try {
    const existing = await lerDados();
    const incoming = req.body;
    const changedKey = incoming._changed || null;
    const lm = Date.now();

    // Merge inteligente: protege arrays existentes de serem apagados por arrays vazios
    // A chave explicitamente alterada (_changed) sempre é aplicada — inclusive se vazia (deleção intencional)
    const merged = Object.assign({}, existing);
    for (const [k, v] of Object.entries(incoming)) {
      if (k.startsWith('_')) continue;
      if (k === changedKey) { merged[k] = v; continue; } // deleção intencional permitida
      if (Array.isArray(v) && v.length === 0 && Array.isArray(existing[k]) && existing[k].length > 0) continue;
      merged[k] = v;
    }
    merged._lastModified = lm;

    // Backup automático diário (mantém o último do dia em dados_backup_YYYY-MM-DD.json)
    if (!pool) {
      const today = new Date().toISOString().slice(0, 10);
      const backupPath = path.join(process.env.DADOS_DIR || __dirname, `dados_backup_${today}.json`);
      if (!fs.existsSync(backupPath) && fs.existsSync(DADOS_PATH)) {
        try { fs.copyFileSync(DADOS_PATH, backupPath); } catch (_) {}
      }
    }

    await salvarDados(merged);
    res.json({ ok: true, lastModified: lm });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

// Endpoint de backup — download do JSON completo
app.get('/backup', auth, async (req, res) => {
  try {
    const d = await lerDados();
    const filename = `compose_backup_${new Date().toISOString().slice(0,10)}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.send(JSON.stringify(d, null, 2));
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/importar', auth, async (req, res) => {
  try {
    const { senha, dados } = req.body;
    if (!senha || senha !== SENHA) {
      return res.status(403).json({ ok: false, erro: 'Senha incorreta.' });
    }
    if (!dados || typeof dados !== 'object') {
      return res.status(400).json({ ok: false, erro: 'Arquivo inválido.' });
    }
    const lm = Date.now();
    const payload = Object.assign({}, dados, { _lastModified: lm });
    // Backup do estado atual antes de sobrescrever
    if (!pool) {
      const today = new Date().toISOString().slice(0, 10);
      const backupPath = path.join(process.env.DADOS_DIR || __dirname, `dados_backup_pre_import_${today}.json`);
      try { const cur = await lerDados(); fs.writeFileSync(backupPath, JSON.stringify(cur, null, 2)); } catch (_) {}
    }
    await salvarDados(payload);
    res.json({ ok: true, lastModified: lm });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
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
    const lista = xmlParseList(body, 'Orcamento');
    res.json(lista);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.get('/auge/orcamento-itens/:id', auth, async (req, res) => {
  try {
    const { status, body } = await augeRequest('dyn/fn/OrcamentoItem?idOrcamento=' + encodeURIComponent(req.params.id));
    console.log('[Auge itens] status:', status, '| body:', body.slice(0, 500));
    if (status !== 200) return res.status(status).json({ erro: 'Auge retornou ' + status });
    const lista = xmlParseList(body, 'OrcamentoItem');
    console.log('[Auge itens] parsed:', lista.length, 'itens');
    res.json(lista);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// rota de debug — retorna XML bruto (remover após diagnóstico)
app.get('/auge/raw/:caminho(*)', auth, async (req, res) => {
  try {
    const { status, body } = await augeRequest(req.params.caminho);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(`STATUS: ${status}\n\n${body}`);
  } catch (e) {
    res.send('ERRO: ' + e.message);
  }
});

// ── IA — GEMINI ─────────────────────────────────────────────────────────────
const GEMINI_KEY = process.env.GEMINI_API_KEY || '';

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

  const geminiCall = (body) => new Promise((resolve, reject) => {
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-flash-latest:generateContent',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI_KEY, 'Content-Length': Buffer.byteLength(body) }
    };
    const req2 = https.request(opts, r => {
      let raw = ''; r.on('data', d => raw += d); r.on('end', () => resolve({ status: r.statusCode, body: raw }));
    });
    req2.on('error', reject); req2.write(body); req2.end();
  });

  try {
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });

    let result;
    for (let t = 1; t <= 3; t++) {
      result = await geminiCall(body);
      if (result.status !== 503) break;
      console.log(`[Gemini] 503 sobrecarga, tentativa ${t}/3...`);
      await sleep(2000 * t);
    }

    if (result.status !== 200) {
      console.error('[Gemini] status', result.status, result.body.slice(0, 500));
      let detalhe = '';
      try { detalhe = JSON.parse(result.body)?.error?.message || ''; } catch(_) {}
      return res.status(502).json({ erro: 'Gemini ' + result.status + (detalhe ? ': ' + detalhe : '') });
    }

    const parsed = JSON.parse(result.body);
    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ erro: 'IA não retornou JSON válido.' });

    const itens = JSON.parse(jsonMatch[0]);
    res.json(itens);
  } catch (e) {
    console.error('[Gemini] erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
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
    ? `Você é um assistente que lê fotos ou PDFs de um quantitativo/planilha de medidas de piso e extrai os dados por ambiente.

Para cada ambiente encontrado, extraia:
- "ambiente": nome do ambiente (ex: "SALA", "QUARTO 1")
- "area": metragem quadrada (m²) do ambiente, como número (ex: 22.5). Se só houver largura e comprimento, calcule a área multiplicando-os.
- "rodape": metragem linear (ml) de rodapé do ambiente, como número, se houver essa informação. Caso não exista, use null.

Responda APENAS com o JSON, sem texto adicional:
{"ambientes": [{"ambiente": "...", "area": 0, "rodape": null}]}`
    : `Você é um assistente que lê fotos ou PDFs de um quantitativo/planilha de medidas de cortina e extrai os dados por ambiente.

Para cada ambiente encontrado, extraia:
- "ambiente": nome do ambiente (ex: "SALA", "QUARTO 1")
- "largura": largura do vão/ambiente em metros, como número (ex: 3.07)
- "altura": altura em metros, como número (ex: 2.76)

Responda APENAS com o JSON, sem texto adicional:
{"ambientes": [{"ambiente": "...", "largura": 0, "altura": 0}]}`;

  const geminiCall = (body) => new Promise((resolve, reject) => {
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-flash-latest:generateContent',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI_KEY, 'Content-Length': Buffer.byteLength(body) }
    };
    const req2 = https.request(opts, r => {
      let raw = ''; r.on('data', d => raw += d); r.on('end', () => resolve({ status: r.statusCode, body: raw }));
    });
    req2.on('error', reject); req2.write(body); req2.end();
  });

  try {
    const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }, ...partesArquivo] }] });

    let result;
    for (let t = 1; t <= 3; t++) {
      result = await geminiCall(body);
      if (result.status !== 503) break;
      console.log(`[Gemini] 503 sobrecarga, tentativa ${t}/3...`);
      await sleep(2000 * t);
    }

    if (result.status !== 200) {
      console.error('[Gemini] status', result.status, result.body.slice(0, 500));
      let detalhe = '';
      try { detalhe = JSON.parse(result.body)?.error?.message || ''; } catch(_) {}
      return res.status(502).json({ erro: 'Gemini ' + result.status + (detalhe ? ': ' + detalhe : '') });
    }

    const parsed = JSON.parse(result.body);
    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(502).json({ erro: 'IA não retornou JSON válido.' });

    const dados = JSON.parse(jsonMatch[0]);
    res.json({ ambientes: dados.ambientes || [] });
  } catch (e) {
    console.error('[Gemini] erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
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
    parts: [{ text: `Você é a assistente de IA da Composê Home, empresa de cortinas, persianas, tapetes, pisos e tapeçaria em Santos-SP. Ajude o usuário (um vendedor/orçamentista da empresa) a interpretar quantitativos, fotos de medidas, planilhas e anotações de clientes, e a montar orçamentos e cálculos. Seja direto, prático e converse em português. Quando o usuário enviar fotos ou PDFs de quantitativos, leia com atenção e responda com os ambientes e medidas encontrados, tirando dúvidas quando a leitura estiver ambígua.` }]
  };

  const geminiCall = (body) => new Promise((resolve, reject) => {
    const opts = {
      hostname: 'generativelanguage.googleapis.com',
      path: '/v1beta/models/gemini-flash-latest:generateContent',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-goog-api-key': GEMINI_KEY, 'Content-Length': Buffer.byteLength(body) }
    };
    const req2 = https.request(opts, r => {
      let raw = ''; r.on('data', d => raw += d); r.on('end', () => resolve({ status: r.statusCode, body: raw }));
    });
    req2.on('error', reject); req2.write(body); req2.end();
  });

  try {
    const body = JSON.stringify({ system_instruction: systemInstruction, contents });

    let result;
    for (let t = 1; t <= 3; t++) {
      result = await geminiCall(body);
      if (result.status !== 503) break;
      console.log(`[Gemini] 503 sobrecarga, tentativa ${t}/3...`);
      await sleep(2000 * t);
    }

    if (result.status !== 200) {
      console.error('[Gemini] status', result.status, result.body.slice(0, 500));
      let detalhe = '';
      try { detalhe = JSON.parse(result.body)?.error?.message || ''; } catch(_) {}
      return res.status(502).json({ erro: 'Gemini ' + result.status + (detalhe ? ': ' + detalhe : '') });
    }

    const parsed = JSON.parse(result.body);
    const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    if (!text) return res.status(502).json({ erro: 'IA não retornou resposta.' });

    res.json({ resposta: text });
  } catch (e) {
    console.error('[Gemini] erro:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Composê rodando em http://localhost:${PORT}`);
  console.log(`Senha de acesso: ${SENHA}`);
});
