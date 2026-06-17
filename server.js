const express = require('express');
const session = require('express-session');
const fs      = require('fs');
const path    = require('path');

const app    = express();
const PORT   = process.env.PORT || 3000;
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
app.use(express.json({ limit: '10mb' }));
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

app.listen(PORT, () => {
  console.log(`Composê rodando em http://localhost:${PORT}`);
  console.log(`Senha de acesso: ${SENHA}`);
});
