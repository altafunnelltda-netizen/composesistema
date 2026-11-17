// ── INTEGRAÇÃO eDECORAÇÃO (SOMENTE LEITURA) ─────────────────────────────────
// Entra no site da loja com um usuário de integração, lista os pedidos de venda
// pela API interna do site e lê o detalhe (itens, totais, parcelas) da página do pedido.
// Nunca cria, altera ou exclui nada no eDecoração.
//
// Configuração (variáveis de ambiente do servidor — nunca no código):
//   EDECOR_URL    ex.: https://composesantos.edecoracao.com
//   EDECOR_EMAIL  usuário de integração (só leitura de Vendas → Pedidos)
//   EDECOR_SENHA  senha desse usuário
'use strict';
const https = require('https');

const BASE = (process.env.EDECOR_URL || 'https://composesantos.edecoracao.com').replace(/\/$/, '');
const EMAIL = process.env.EDECOR_EMAIL || '';
const SENHA = process.env.EDECOR_SENHA || '';
const UA = 'Compose-Integracao/1.0';

function configurado() { return !!(EMAIL && SENHA); }

class ErroEdecor extends Error {
  constructor(msg, codigo) { super(msg); this.codigo = codigo || 'erro'; }
}

function req(url, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = https.request({
      method, hostname: u.hostname, path: u.pathname + u.search,
      headers: Object.assign({ 'User-Agent': UA }, headers)
    }, res => {
      let raw = ''; res.setEncoding('utf8');
      res.on('data', d => { raw += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: raw }));
    });
    r.on('error', reject);
    r.setTimeout(30000, () => r.destroy(new Error('tempo esgotado ao acessar o eDecoração')));
    if (body) r.write(body);
    r.end();
  });
}

function juntarCookies(atual, setCookie) {
  const jar = {};
  (atual || '').split('; ').filter(Boolean).forEach(c => { const i = c.indexOf('='); jar[c.slice(0, i)] = c.slice(i + 1); });
  (setCookie || []).forEach(sc => {
    const c = sc.split(';')[0]; const i = c.indexOf('=');
    const nome = c.slice(0, i), valor = c.slice(i + 1);
    if (valor === '' || /expires=Thu, 01-Jan-1970/i.test(sc)) delete jar[nome]; else jar[nome] = valor;
  });
  return Object.keys(jar).map(k => k + '=' + jar[k]).join('; ');
}

// ── Sessão (reaproveitada por alguns minutos para não logar a cada chamada) ──
let _sessao = null;
const SESSAO_MS = 15 * 60 * 1000;

async function sessao(forcar) {
  if (!configurado()) throw new ErroEdecor('Integração não configurada: defina EDECOR_EMAIL e EDECOR_SENHA no servidor.', 'nao_configurado');
  if (!forcar && _sessao && Date.now() - _sessao.em < SESSAO_MS) return _sessao;
  let r = await req(BASE + '/conta/login');
  let cookie = juntarCookies('', r.headers['set-cookie']);
  const form = 'Email=' + encodeURIComponent(EMAIL) + '&Password=' + encodeURIComponent(SENHA);
  r = await req(BASE + '/conta/login?ReturnUrl=%2Fvendas%2Fpedidos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(form), Cookie: cookie },
    body: form
  });
  cookie = juntarCookies(cookie, r.headers['set-cookie']);
  if (r.status !== 302 || /login/i.test(r.headers.location || '') || !/ApplicationCookie=/.test(cookie)) {
    throw new ErroEdecor('O eDecoração recusou o login. Confira e-mail e senha do usuário de integração.', 'login');
  }
  r = await req(BASE + '/vendas/pedidos', { headers: { Cookie: cookie } });
  const titulo = (r.body.match(/<title>([^<]*)/) || [])[1] || '';
  if (/PERMISS/i.test(titulo.replace(/&#213;/g, 'Õ'))) {
    throw new ErroEdecor('O usuário de integração entrou, mas não tem permissão para ver Vendas → Pedidos no eDecoração.', 'permissao');
  }
  const token = (r.body.match(/window\.__token\s*=\s*"([^"]+)"/) || [])[1];
  const apiUrl = (r.body.match(/window\.__apiUrl\s*=\s*"([^"]+)"/) || [])[1];
  if (!token || !apiUrl) throw new ErroEdecor('A página de pedidos do eDecoração mudou e não traz mais o acesso à API. A integração precisa ser revisada.', 'layout');
  _sessao = { cookie, token, apiUrl: apiUrl.replace(/\/$/, ''), em: Date.now() };
  return _sessao;
}

async function api(s, caminho, params) {
  const qs = params ? '?' + new URLSearchParams(params).toString() : '';
  const r = await req(s.apiUrl + '/' + caminho + qs, { headers: { Authorization: 'Bearer ' + s.token, Accept: 'application/json' } });
  if (r.status === 401) throw new ErroEdecor('Acesso à API expirou.', 'expirado');
  if (r.status !== 200) throw new ErroEdecor('API do eDecoração respondeu ' + r.status + '.', 'api');
  try { return JSON.parse(r.body); } catch (e) { throw new ErroEdecor('Resposta inesperada da API do eDecoração.', 'layout'); }
}

// Data do site → "AAAA-MM-DD"
function dataISO(v) {
  if (!v) return '';
  const s = String(v);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/); if (m) return m[3] + '-' + m[2] + '-' + m[1];
  m = s.match(/\/Date\((\d+)/); if (m) return new Date(+m[1]).toISOString().slice(0, 10);
  return '';
}
function numBR(s) {
  if (s == null) return 0;
  if (typeof s === 'number') return s;
  const t = String(s).replace(/[^\d,.-]/g, '');
  if (!t) return 0;
  return parseFloat(t.replace(/\./g, '').replace(',', '.')) || 0;
}

// Lista de pedidos (mais novos primeiro) até chegar na data "desde"
async function listar(s, desdeISO) {
  const pedidos = [];
  for (let page = 1; page <= 40; page++) {
    const j = await api(s, 'SaleOrder', { Quantity: '50', Page: String(page), Sort: 'Id', SortDirection: 'DESC', IsActive: 'true' });
    const lista = j.Result || [];
    let passou = false;
    for (const p of lista) {
      const d = dataISO(p.SaleOrderDate);
      if (desdeISO && d && d < desdeISO) { passou = true; continue; }
      const nome = o => (o && (o.Name || o.AlternativeName)) || '';
      pedidos.push({
        edId: p.Id, codigo: p.Code, data: d,
        cliente: nome(p.Person) || p.PersonName || '', empresa: nome(p.Office) || p.OfficeName || '',
        consultor: nome(p.Seller) || p.SellerName || '', arquiteto: nome(p.Architect) || p.ArchitectName || '',
        total: numBR(p.Total), etapaId: p.SaleOrderStepId,
        etapa: nome(p.SaleOrderStatus) || p.SaleOrderStepName || '',
        cancelado: !!p.HasCanceled, entregue: !!p.HasDelivered
      });
    }
    if (passou || lista.length < 50) break;
  }
  return pedidos;
}

// ── Leitura da página do pedido (/vendas/pedidos/ver/{id}) ──
function textoLimpo(html) {
  return html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '\n')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
    .split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean);
}
function celulas(linhaHtml) {
  return linhaHtml.split(/<\/t[dh]>/i).slice(0, -1).map(c =>
    c.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/\s+/g, ' ').trim());
}
function ultimoValor(s) {  // "260,00 256,06" → 256,06 (preço com desconto aparece por último)
  const nums = String(s || '').match(/-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+(?:,\d+)?/g);
  return nums ? numBR(nums[nums.length - 1]) : 0;
}

function lerDetalhe(html) {
  const iAmb = html.indexOf('>Ambiente<');
  if (iAmb < 0) throw new ErroEdecor('Não encontrei a tabela de itens na página do pedido (o layout do eDecoração pode ter mudado).', 'layout');

  // Cabeçalho: rótulo seguido do valor
  const iTopo = html.lastIndexOf('Pedido de Venda', iAmb);
  const topo = textoLimpo(html.slice(iTopo >= 0 ? iTopo : 0, iAmb));
  const ROT = { 'Cliente': 'cliente', 'CPF/CNPJ': 'cpf', 'Telefone': 'fone', 'Email': 'email', 'E-mail': 'email', 'Endereço de Entrega': 'end', 'Arquiteto': 'arq', 'Consultor(a)': 'consultor', 'Consultor': 'consultor' };
  const cab = {};
  topo.forEach((t, i) => { if (ROT[t] && topo[i + 1] && !ROT[topo[i + 1]]) cab[ROT[t]] = topo[i + 1]; });
  const num = (topo.find(t => /^#\d+$/.test(t)) || '').replace('#', '').replace(/^0+/, '');
  const data = dataISO(topo.find(t => /^\d{2}\/\d{2}\/\d{4}$/.test(t)) || '');

  // Itens: mantém células vazias para não deslocar colunas
  const ini = html.lastIndexOf('<table', iAmb), fim = html.indexOf('</table>', iAmb);
  const linhas = html.slice(ini, fim).split(/<tr[^>]*>/i).slice(1).map(celulas).filter(c => c.length);
  const head = linhas.shift().map(h => h.toLowerCase());
  const col = nome => head.findIndex(h => h.indexOf(nome) === 0);
  const C = { amb: col('ambiente'), ref: col('refer'), cor: col('cor'), produto: col('produto'), medidas: col('medida'), qtd: col('qtd'), un: col('un'), preco: col('pre'), total: col('total') };
  if (C.produto < 0 || C.qtd < 0) throw new ErroEdecor('A tabela de itens do eDecoração mudou de formato.', 'layout');
  const itens = linhas.filter(c => c.length >= head.length - 1 && (c[C.produto] || '').length).map(c => ({
    amb: c[C.amb] || '', ref: c[C.ref] || '', cor: c[C.cor] || '', produto: c[C.produto] || '',
    medidas: C.medidas >= 0 ? (c[C.medidas] || '') : '', qtd: ultimoValor(c[C.qtd]), un: c[C.un] || '',
    precoVenda: ultimoValor(c[C.preco]), total: ultimoValor(c[C.total])
  }));

  // Rodapé: pagamento, totais, observações, entrega
  const rod = textoLimpo(html.slice(fim, fim + 20000));
  const depois = rot => { const i = rod.findIndex(t => t.replace(/\s/g, '').toLowerCase().indexOf(rot) === 0); return i >= 0 ? rod[i + 1] : ''; };
  const parcelas = [];
  rod.forEach((t, i) => {
    const m = t.match(/^(\d+)\/(\d+)$/);
    if (m && /^\d{2}\/\d{2}\/\d{4}$/.test(rod[i + 1] || '') && /R\$/.test(rod[i + 2] || '')) {
      parcelas.push({ num: +m[1], de: +m[2], venc: dataISO(rod[i + 1]), valor: numBR(rod[i + 2]) });
    }
  });
  const pag = rod.indexOf('Forma de Pagamento') >= 0 ? rod[rod.indexOf('Forma de Pagamento') + 1] : '';
  return {
    num, data, cab, itens, parcelas,
    formaPagamento: /\d+\/\d+/.test(pag || '') ? '' : (pag || ''),
    subtotal: numBR(depois('subtotal:')), desconto: numBR(depois('desconto:')), total: numBR(depois('total:')),
    obs: depois('observações:') || '', previsaoEntrega: depois('previsãodeentrega:') || ''
  };
}

async function detalhe(s, edId) {
  const r = await req(BASE + '/vendas/pedidos/ver/' + encodeURIComponent(edId), { headers: { Cookie: s.cookie } });
  if (r.status === 302) throw new ErroEdecor('Sessão do eDecoração expirou.', 'expirado');
  if (r.status !== 200) throw new ErroEdecor('Página do pedido respondeu ' + r.status + '.', 'api');
  return lerDetalhe(r.body);
}

const esperar = ms => new Promise(r => setTimeout(r, ms));

// Sincroniza em lotes: lista desde a data e busca o detalhe só dos pedidos que o sistema
// ainda não tem, no máximo `limite` por chamada (a página de cada pedido leva ~3 s).
async function sincronizar({ desde, conhecidos, limite }) {
  limite = Math.max(1, Math.min(+limite || 10, 20));
  let s = await sessao();
  let lista;
  try { lista = await listar(s, desde); }
  catch (e) { if (e.codigo !== 'expirado') throw e; s = await sessao(true); lista = await listar(s, desde); }
  const ja = new Set((conhecidos || []).map(String));
  const saida = [], falhas = [];
  const novos = lista.filter(p => !ja.has(String(p.edId)) && !p.cancelado); // cancelado e ainda não importado: não traz
  const lote = new Set(novos.slice(0, limite).map(p => String(p.edId)));
  for (const p of lista) {
    if (ja.has(String(p.edId))) { saida.push(p); continue; }
    if (!lote.has(String(p.edId))) continue;
    try {
      p.detalhe = await detalhe(s, p.edId);
    } catch (e) {
      if (e.codigo === 'expirado') { s = await sessao(true); try { p.detalhe = await detalhe(s, p.edId); } catch (e2) { falhas.push({ codigo: p.codigo, erro: e2.message }); } }
      else falhas.push({ codigo: p.codigo, erro: e.message });
    }
    saida.push(p);
    await esperar(300); // gentil com o site
  }
  return { pedidos: saida, falhas, novosTotal: novos.length, restantes: Math.max(0, novos.length - lote.size) };
}

function registrarRotas(app, auth) {
  app.get('/edecor/status', auth, (req, res) => res.json({ configurado: configurado(), site: BASE }));
  app.post('/edecor/sincronizar', auth, async (req, res) => {
    try {
      const desde = /^\d{4}-\d{2}-\d{2}$/.test((req.body || {}).desde || '') ? req.body.desde : '';
      const conhecidos = Array.isArray((req.body || {}).conhecidos) ? req.body.conhecidos.slice(0, 5000) : [];
      res.json(Object.assign({ ok: true }, await sincronizar({ desde, conhecidos, limite: (req.body || {}).limite })));
    } catch (e) {
      const status = e.codigo === 'nao_configurado' ? 503 : (e.codigo === 'login' || e.codigo === 'permissao') ? 403 : 502;
      res.status(status).json({ ok: false, codigo: e.codigo || 'erro', erro: e.message });
    }
  });
}

module.exports = { registrarRotas, lerDetalhe, configurado, sincronizar };
