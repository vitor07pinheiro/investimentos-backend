const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");

const app  = express();
const PORT = process.env.PORT || 3001;

const BRAPI_TOKEN  = process.env.BRAPI_TOKEN  || "";
const JWT_SECRET   = process.env.JWT_SECRET   || "troque-este-segredo-em-producao";
const AUTH_USER    = process.env.AUTH_USER;
const AUTH_PASS_HASH = process.env.AUTH_PASS_HASH; // SHA-256 da senha em hex

app.use(cors());
app.use(express.json());

// ── Utilitários JWT mínimo (sem dependência externa) ─────────────────────────
function b64url(str) {
  return Buffer.from(str).toString("base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}
function signJwt(payload, secret, expiresInSeconds = 28800) {
  const header  = b64url(JSON.stringify({ alg:"HS256", typ:"JWT" }));
  const body    = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now()/1000) + expiresInSeconds }));
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64")
    .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  return `${header}.${body}.${sig}`;
}
function verifyJwt(token, secret) {
  try {
    const [header, body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64")
      .replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, "base64").toString());
    if (payload.exp < Math.floor(Date.now()/1000)) return null; // expirado
    return payload;
  } catch { return null; }
}
function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

// ── Middleware de autenticação ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token ausente" });
  const payload = verifyJwt(token, JWT_SECRET);
  if (!payload) return res.status(401).json({ error: "Token inválido ou expirado" });
  req.user = payload;
  next();
}

// ── Helper: fetch com timeout ─────────────────────────────────────────────────
async function fetchT(url, ms = 8000) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(id);
    return res;
  } catch(e) { clearTimeout(id); throw e; }
}

// ── LOGIN ─────────────────────────────────────────────────────────────────────
app.post("/api/auth/login", (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password)
    return res.status(400).json({ error: "Usuário e senha obrigatórios" });

  const passHash = sha256(password);

  const userOk = AUTH_USER     ? username === AUTH_USER     : false;
  const passOk = AUTH_PASS_HASH ? passHash === AUTH_PASS_HASH : false;

  if (!userOk || !passOk) {
    // Delay proposital para dificultar brute-force
    return setTimeout(() => res.status(401).json({ error: "Credenciais inválidas" }), 800);
  }

  const token = signJwt({ sub: username }, JWT_SECRET, 28800); // 8 horas
  res.json({ token, expiresIn: 28800 });
});

// ── VERIFY (frontend usa para checar token ao recarregar) ─────────────────────
app.get("/api/auth/verify", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user.sub });
});

// ── Cotações B3 ───────────────────────────────────────────────────────────────
app.get("/api/cotacoes/b3", requireAuth, async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "tickers obrigatório" });
  try {
    const r = await fetchT(`https://brapi.dev/api/quote/${tickers}?token=${BRAPI_TOKEN}`);
    const d = await r.json();
    if (!d.results) return res.status(502).json({ error: "Resposta inválida", raw: d });
    res.json({ cotacoes: d.results.map(q=>({ ticker:q.symbol, preco:q.regularMarketPrice, variacao_dia:q.regularMarketChangePercent, nome:q.longName||q.shortName||q.symbol })), fonte:"brapi", atualizado:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Cotações EUA ──────────────────────────────────────────────────────────────
app.get("/api/cotacoes/eua", requireAuth, async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "tickers obrigatório" });
  try {
    const r = await fetchT(`https://brapi.dev/api/quote/${tickers}?token=${BRAPI_TOKEN}&country=us`);
    const d = await r.json();
    if (!d.results) return res.status(502).json({ error: "Resposta inválida", raw: d });
    res.json({ cotacoes: d.results.map(q=>({ ticker:q.symbol, preco_usd:q.regularMarketPrice, variacao_dia:q.regularMarketChangePercent, nome:q.longName||q.shortName||q.symbol })), fonte:"brapi", atualizado:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Bitcoin ───────────────────────────────────────────────────────────────────
app.get("/api/cotacoes/crypto", requireAuth, async (req, res) => {
  try {
    const r = await fetchT("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl,usd&include_24hr_change=true");
    const d = await r.json();
    res.json({ bitcoin:{ preco_brl:d.bitcoin.brl, preco_usd:d.bitcoin.usd, variacao_24h:d.bitcoin.brl_24h_change }, fonte:"coingecko", atualizado:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Câmbio USD/BRL ────────────────────────────────────────────────────────────
app.get("/api/cambio", requireAuth, async (req, res) => {
  try {
    const r = await fetchT(`https://brapi.dev/api/v2/currency?currency=USD-BRL&token=${BRAPI_TOKEN}`, 5000);
    const d = await r.json();
    const rate = d?.currency?.[0]?.ask;
    if (rate && parseFloat(rate) > 1)
      return res.json({ usd_brl:parseFloat(rate), fonte:"brapi", atualizado:new Date().toISOString() });
  } catch(_) {}
  try {
    const hoje = new Date();
    const mm   = String(hoje.getMonth()+1).padStart(2,"0");
    const dd   = String(hoje.getDate()).padStart(2,"0");
    const yyyy = hoje.getFullYear();
    const fim  = `${mm}%2F${dd}%2F${yyyy}`;
    const ini  = `${mm}%2F${String(hoje.getDate()-7).padStart(2,"0")}%2F${yyyy}`;
    const url  = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='${ini}'&@dataFinalCotacao='${fim}'&$top=1&$orderby=dataHoraCotacao%20desc&$format=json&$select=cotacaoVenda,dataHoraCotacao`;
    const r = await fetchT(url, 6000);
    const d = await r.json();
    const rate = d?.value?.[0]?.cotacaoVenda;
    if (rate) return res.json({ usd_brl:parseFloat(rate), fonte:"bcb_ptax", atualizado:new Date().toISOString() });
  } catch(_) {}
  res.status(503).json({ error:"Câmbio indisponível", usd_brl:null });
});

// ── Indicadores ───────────────────────────────────────────────────────────────
app.get("/api/indicadores", requireAuth, async (req, res) => {
  try {
    const [r1,r2,r3] = await Promise.all([
      fetchT("https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/2?formato=json"),
      fetchT("https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json"),
      fetchT("https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados/ultimos/1?formato=json"),
    ]);
    const selicOver = await r1.json();
    const [selicMeta] = await r2.json();
    const [ipca]      = await r3.json();
    const taxaDiaria  = parseFloat(selicOver?.[0]?.valor || 0);
    const cdiAnual    = parseFloat(((Math.pow(1+taxaDiaria/100,252)-1)*100).toFixed(2));
    res.json({ cdi_anual:cdiAnual, cdi_diario:taxaDiaria, selic:parseFloat(selicMeta?.valor||0), ipca_mensal:parseFloat(ipca?.valor||0), fonte:"bcb", atualizado:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IPCA acumulado entre duas datas (real, mês a mês) ─────────────────────────
// GET /api/ipca-acumulado?inicio=2024-01-15&fim=2026-06-14
// Retorna { fator: 1.0834, percentual: 8.34, meses: [...] }
app.get("/api/ipca-acumulado", requireAuth, async (req, res) => {
  const { inicio, fim } = req.query;
  if (!inicio) return res.status(400).json({ error: "data de início obrigatória" });
  try {
    const di = new Date(inicio);
    const df = fim ? new Date(fim) : new Date();
    // BCB usa formato DD/MM/AAAA
    const fmtBCB = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=${fmtBCB(di)}&dataFinal=${fmtBCB(df)}`;
    const r = await fetchT(url, 8000);
    const dados = await r.json();
    // Acumula: produto de (1 + ipca/100)
    let fator = 1;
    const meses = dados.map(d => {
      const v = parseFloat(d.valor);
      fator *= (1 + v/100);
      return { mes: d.data, ipca: v };
    });
    res.json({
      fator,
      percentual: parseFloat(((fator-1)*100).toFixed(4)),
      meses,
      qtd_meses: meses.length,
      fonte: "bcb",
      atualizado: new Date().toISOString(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CDI acumulado entre duas datas (real, dia a dia) ──────────────────────────
// GET /api/cdi-acumulado?inicio=2024-01-15&fim=2026-06-14
app.get("/api/cdi-acumulado", requireAuth, async (req, res) => {
  const { inicio, fim } = req.query;
  if (!inicio) return res.status(400).json({ error: "data de início obrigatória" });
  try {
    const di = new Date(inicio);
    const df = fim ? new Date(fim) : new Date();
    const fmtBCB = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
    // Série 12 = CDI diário
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=${fmtBCB(di)}&dataFinal=${fmtBCB(df)}`;
    const r = await fetchT(url, 8000);
    const dados = await r.json();
    let fator = 1;
    dados.forEach(d => { fator *= (1 + parseFloat(d.valor)/100); });
    res.json({
      fator,
      percentual: parseFloat(((fator-1)*100).toFixed(4)),
      qtd_dias: dados.length,
      fonte: "bcb",
      atualizado: new Date().toISOString(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Proventos B3 ──────────────────────────────────────────────────────────────
app.get("/api/proventos/:ticker", requireAuth, async (req, res) => {
  const { ticker } = req.params;
  try {
    const r = await fetchT(`https://brapi.dev/api/quote/${ticker}?modules=dividendsData&token=${BRAPI_TOKEN}`);
    const d = await r.json();
    const divs = d?.results?.[0]?.dividendsData?.cashDividends || [];
    res.json({ ticker, proventos: divs.slice(0,12).map(d=>({ ticker, tipo:d.label||"Dividendo", valor:d.rate, data_com:d.lastDatePrior, data_pagamento:d.paymentDate })), fonte:"brapi", atualizado:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status:"ok", versao:"3.2.0", msg:"Backend resiliente a tickers individuais" });
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
