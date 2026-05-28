const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
// Em produção usa volume persistente, localmente usa a pasta do projeto
const DADOS_DIR = process.env.DADOS_DIR || __dirname;
const DADOS_PATH = path.join(DADOS_DIR, 'dados.json');

// Garante que dados.json existe com estrutura inicial
if (!fs.existsSync(DADOS_PATH)) {
  fs.writeFileSync(DADOS_PATH, JSON.stringify({ cps_orc: [], cps_cor: [], cps_tap: [] }, null, 2));
}

app.use(express.json({ limit: '10mb' }));

// Serve o index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Serve a logo
app.get('/logo.png', (req, res) => {
  res.sendFile(path.join(__dirname, 'logo_transp.png'));
});

// Serve o CSS
app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'style.css'));
});

// Lê os dados
app.get('/dados', (req, res) => {
  try {
    const dados = JSON.parse(fs.readFileSync(DADOS_PATH, 'utf8'));
    res.json(dados);
  } catch (e) {
    res.json({ cps_orc: [], cps_cor: [], cps_tap: [] });
  }
});

// Salva os dados
app.post('/dados', (req, res) => {
  try {
    fs.writeFileSync(DADOS_PATH, JSON.stringify(req.body, null, 2));
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`Composê rodando em http://localhost:${PORT}`);
});
