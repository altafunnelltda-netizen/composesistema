const express = require('express');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DADOS_DIR = process.env.DADOS_DIR || __dirname;
const DADOS_PATH = path.join(DADOS_DIR, 'dados.json');
const SENHA = process.env.SENHA_SISTEMA || 'compose2024';
const SESSION_SECRET = process.env.SESSION_SECRET || 'cps-' + Math.random().toString(36).slice(2);

if (!fs.existsSync(DADOS_PATH)) {
  fs.writeFileSync(DADOS_PATH, JSON.stringify({ cps_orc: [], cps_cor: [], cps_tap: [] }, null, 2));
}

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 } // 8 horas
}));

function auth(req, res, next) {
  if (req.session && req.session.logado) return next();
  res.redirect('/login');
}

// Login
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

// Rotas protegidas
app.get('/', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/style.css', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});

app.get('/logo.png', auth, (req, res) => {
  res.sendFile(path.join(__dirname, 'logo_transp.png'));
});

app.get('/dados', auth, (req, res) => {
  try {
    const dados = JSON.parse(fs.readFileSync(DADOS_PATH, 'utf8'));
    res.json(dados);
  } catch (e) {
    res.json({ cps_orc: [], cps_cor: [], cps_tap: [] });
  }
});

app.post('/dados', auth, (req, res) => {
  try {
    fs.writeFileSync(DADOS_PATH, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Composê rodando em http://localhost:${PORT}`);
  console.log(`Senha de acesso: ${SENHA}`);
});
