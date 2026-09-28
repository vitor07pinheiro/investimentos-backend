const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const { MongoClient } = require("mongodb");

const app  = express();
const PORT = process.env.PORT || 3001;

const BRAPI_TOKEN    = process.env.BRAPI_TOKEN    || "";
const JWT_SECRET     = process.env.JWT_SECRET     || "troque-este-segredo-em-producao";
const AUTH_USER      = process.env.AUTH_USER;
const AUTH_PASS_HASH = process.env.AUTH_PASS_HASH;
const MONGODB_URI    = process.env.MONGODB_URI;

app.use(cors());
app.use(express.json({ limit: "5mb" }));

// ── Conexão MongoDB ───────────────────────────────────────────────────────────
let db = null;
async function conectarDB() {
  if (!MONGODB_URI) { console.warn("MONGODB_URI não configurada — dados não serão persistidos"); return; }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db("investimentos");
    console.log("MongoDB conectado com sucesso");
  } catch(e) {
    console.error("Erro ao conectar MongoDB:", e.message);
  }
}
conectarDB();

// ── JWT mínimo (sem dependência externa) ──────────────────────────────────────
function b64url(str) {
  return Buffer.from(str).toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
}
function signJwt(payload, secret, expiresInSeconds = 28800) {
  const header = b64url(JSON.stringify({ alg:"HS256", typ:"JWT" }));
  const body   = b64url(JSON.stringify({ ...payload, exp: Math.floor(Date.now()/1000) + expiresInSeconds }));
  const sig = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
  return `${header}.${body}.${sig}`;
}
function verifyJwt(token, secret) {
  try {
    const [header, body, sig] = token.split(".");
    const expected = crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=/g,"");
    if (sig !== expected) return null;
    const payload = JSON.parse(Buffer.from(body, "base64").toString());
    if (payload.exp < Math.floor(Date.now()/1000)) return null;
    return payload;
  } catch { return null; }
}
function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}

function requireAuth(req, res, next) {
  const auth  = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Token ausente" });
  const payload = verifyJwt(token, JWT_SECRET);
  if (!payload) return res.status(401).json({ error: "Token inválido ou expirado" });
  req.user = payload;
  next();
}

async function fetchT(url, ms = 7000) {
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
  if (!username || !password) return res.status(400).json({ error: "Usuário e senha obrigatórios" });
  const passHash = sha256(password);
  const userOk = AUTH_USER      ? username === AUTH_USER      : false;
  const passOk = AUTH_PASS_HASH ? passHash === AUTH_PASS_HASH : false;
  if (!userOk || !passOk) {
    return setTimeout(() => res.status(401).json({ error: "Credenciais inválidas" }), 800);
  }
  const token = signJwt({ sub: username }, JWT_SECRET, 28800);
  res.json({ token, expiresIn: 28800 });
});

app.get("/api/auth/verify", requireAuth, (req, res) => {
  res.json({ ok: true, user: req.user.sub });
});

// ── Cotações B3 (1 ticker por requisição à BRAPI; concorrência limitada) ──────
app.get("/api/cotacoes/b3", requireAuth, async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "tickers obrigatório" });
  try {
    const lista = tickers.split(",").map(t => t.trim()).filter(Boolean);
    const cotacoes = [];
    const nao_encontrados = [];
    const CONCORRENCIA = 3;

    for (let i = 0; i < lista.length; i += CONCORRENCIA) {
      const grupo = lista.slice(i, i + CONCORRENCIA);
      await Promise.all(grupo.map(async (ticker) => {
        try {
          const url = `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}`;
          const r = await fetchT(url, 6000);
          const d = await r.json();
          const q = d && d.results && d.results[0];
          if (q && typeof q.regularMarketPrice === "number") {
            cotacoes.push({
              ticker: q.symbol,
              preco: q.regularMarketPrice,
              variacao_dia: q.regularMarketChangePercent,
              nome: q.longName || q.shortName || q.symbol,
            });
          } else {
            nao_encontrados.push(ticker);
          }
        } catch(e) {
          nao_encontrados.push(ticker);
        }
      }));
      if (i + CONCORRENCIA < lista.length) await new Promise(r => setTimeout(r, 150));
    }

    res.json({ cotacoes, nao_encontrados, fonte: "brapi", atualizado: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Cotações EUA (1 ticker por requisição; concorrência limitada) ─────────────
app.get("/api/cotacoes/eua", requireAuth, async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "tickers obrigatório" });
  try {
    const lista = tickers.split(",").map(t => t.trim()).filter(Boolean);
    const cotacoes = [];
    const nao_encontrados = [];
    const CONCORRENCIA = 3;

    for (let i = 0; i < lista.length; i += CONCORRENCIA) {
      const grupo = lista.slice(i, i + CONCORRENCIA);
      await Promise.all(grupo.map(async (ticker) => {
        try {
          const url = `https://brapi.dev/api/quote/${ticker}?token=${BRAPI_TOKEN}&country=us`;
          const r = await fetchT(url, 6000);
          const d = await r.json();
          const q = d && d.results && d.results[0];
          if (q && typeof q.regularMarketPrice === "number") {
            cotacoes.push({
              ticker: q.symbol,
              preco_usd: q.regularMarketPrice,
              variacao_dia: q.regularMarketChangePercent,
              nome: q.longName || q.shortName || q.symbol,
            });
          } else {
            nao_encontrados.push(ticker);
          }
        } catch(e) {
          nao_encontrados.push(ticker);
        }
      }));
      if (i + CONCORRENCIA < lista.length) await new Promise(r => setTimeout(r, 150));
    }

    res.json({ cotacoes, nao_encontrados, fonte: "brapi", atualizado: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Helpers de cotação (câmbio e Bitcoin) ─────────────────────────────────────
// Busca JSON com timeout, User-Agent e sem cache. Lança erro se HTTP != 2xx.
async function getJSON(url, ms = 7000, headers = {}) {
  const ctrl = new AbortController();
  const id   = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { "Accept": "application/json", "User-Agent": "investimentos-app/1.0", "Cache-Control": "no-cache", ...headers },
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(id); }
}
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
// Faixas de sanidade: descartam respostas absurdas (ex.: 0, null, valor em outra moeda)
const cambioValido = v => v !== null && v > 2 && v < 20;
const btcValido    = v => v !== null && v > 1000;

// Cache curto em memória: evita estourar limite das APIs gratuitas se o botão for clicado várias vezes.
// Também guarda o último valor bom, usado se todas as fontes falharem.
const cacheCot = { cambio: null, btc: null };
const CACHE_MS = 60 * 1000;

// ── Bitcoin (CoinGecko → Mercado Bitcoin → Coinbase) ──────────────────────────
async function btcCoinGecko() {
  const key = process.env.COINGECKO_API_KEY; // opcional (plano Demo gratuito)
  const d = await getJSON(
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl,usd&include_24hr_change=true",
    7000, key ? { "x-cg-demo-api-key": key } : {}
  );
  const b = d && d.bitcoin;
  if (!b || !btcValido(num(b.brl))) throw new Error("resposta inválida");
  return { preco_brl: num(b.brl), preco_usd: num(b.usd), variacao_24h: num(b.brl_24h_change) };
}
async function btcMercadoBitcoin() {
  const d = await getJSON("https://api.mercadobitcoin.net/api/v4/tickers?symbols=BTC-BRL");
  const t = Array.isArray(d) && d[0];
  const last = t && num(t.last), open = t && num(t.open);
  if (!btcValido(last)) throw new Error("resposta inválida");
  return { preco_brl: last, preco_usd: null, variacao_24h: open ? (last / open - 1) * 100 : null };
}
async function btcCoinbase() {
  const [brl, usd] = await Promise.all([
    getJSON("https://api.coinbase.com/v2/prices/BTC-BRL/spot"),
    getJSON("https://api.coinbase.com/v2/prices/BTC-USD/spot").catch(() => null),
  ]);
  const p = num(brl && brl.data && brl.data.amount);
  if (!btcValido(p)) throw new Error("resposta inválida");
  return { preco_brl: p, preco_usd: num(usd && usd.data && usd.data.amount), variacao_24h: null };
}

async function obterBitcoin() {
  const fontes = [["coingecko", btcCoinGecko], ["mercadobitcoin", btcMercadoBitcoin], ["coinbase", btcCoinbase]];
  const erros = [];
  for (const [nome, fn] of fontes) {
    try { return { ...(await fn()), fonte: nome }; }
    catch (e) { erros.push(`${nome}: ${e.message}`); console.warn(`[BTC] ${nome} falhou: ${e.message}`); }
  }
  throw new Error(erros.join(" | "));
}

app.get("/api/cotacoes/crypto", requireAuth, async (req, res) => {
  if (cacheCot.btc && Date.now() - cacheCot.btc.ts < CACHE_MS)
    return res.json({ bitcoin: cacheCot.btc.dado, fonte: cacheCot.btc.fonte, atualizado: cacheCot.btc.atualizado, cache: true });
  try {
    const { fonte, ...bitcoin } = await obterBitcoin();
    // Se a fonte não trouxe preço em USD, deriva pelo câmbio em cache (se houver)
    if (!bitcoin.preco_usd && cacheCot.cambio) bitcoin.preco_usd = bitcoin.preco_brl / cacheCot.cambio.valor;
    const atualizado = new Date().toISOString();
    cacheCot.btc = { dado: bitcoin, fonte, atualizado, ts: Date.now() };
    res.json({ bitcoin, fonte, atualizado });
  } catch (e) {
    if (cacheCot.btc) // devolve o último valor bom, sinalizando que está desatualizado
      return res.json({ bitcoin: cacheCot.btc.dado, fonte: cacheCot.btc.fonte, atualizado: cacheCot.btc.atualizado, stale: true });
    res.status(503).json({ error: "Bitcoin indisponível: " + e.message });
  }
});

// ── Câmbio USD/BRL (BRAPI → AwesomeAPI → PTAX BCB → implícito via BTC) ────────
async function cambioBrapi() {
  if (!BRAPI_TOKEN) throw new Error("sem BRAPI_TOKEN");
  const d = await getJSON(`https://brapi.dev/api/v2/currency?currency=USD-BRL&token=${BRAPI_TOKEN}`, 6000);
  const c = d && d.currency && d.currency[0];
  // BRAPI v2 usa askPrice/bidPrice (o campo "ask" não existe — era o bug do valor fixo)
  const v = c && num(c.askPrice ?? c.bidPrice ?? c.ask ?? c.bid);
  if (!cambioValido(v)) throw new Error("resposta inválida");
  return v;
}
async function cambioAwesome() {
  const d = await getJSON("https://economia.awesomeapi.com.br/json/last/USD-BRL", 6000);
  const v = num(d && d.USDBRL && (d.USDBRL.ask ?? d.USDBRL.bid));
  if (!cambioValido(v)) throw new Error("resposta inválida");
  return v;
}
async function cambioPtax() {
  // Janela dos últimos 10 dias corridos (cobre fins de semana, feriados e virada de mês)
  const fmt = d => `${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}-${d.getFullYear()}`;
  const fim = new Date();
  const ini = new Date(fim.getTime() - 10 * 86400000);
  const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='${fmt(ini)}'&@dataFinalCotacao='${fmt(fim)}'&$format=json&$select=cotacaoVenda,dataHoraCotacao`;
  const d = await getJSON(url, 8000);
  const lista = (d && d.value) || [];
  const ultimo = lista.sort((a, b) => String(b.dataHoraCotacao).localeCompare(String(a.dataHoraCotacao)))[0];
  const v = num(ultimo && ultimo.cotacaoVenda);
  if (!cambioValido(v)) throw new Error("resposta inválida");
  return v;
}
async function cambioViaBtc() {
  // Último recurso: câmbio implícito = BTC em BRL ÷ BTC em USD (mesma fonte). Aproximado (~0,5%).
  const d = await getJSON("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl,usd", 7000);
  const v = d && d.bitcoin && num(d.bitcoin.brl) / num(d.bitcoin.usd);
  if (!cambioValido(v)) throw new Error("resposta inválida");
  return v;
}

app.get("/api/cambio", requireAuth, async (req, res) => {
  if (cacheCot.cambio && Date.now() - cacheCot.cambio.ts < CACHE_MS)
    return res.json({ usd_brl: cacheCot.cambio.valor, fonte: cacheCot.cambio.fonte, atualizado: cacheCot.cambio.atualizado, cache: true });
  const fontes = [["brapi", cambioBrapi], ["awesomeapi", cambioAwesome], ["bcb_ptax", cambioPtax], ["implicito_btc", cambioViaBtc]];
  const erros = [];
  for (const [fonte, fn] of fontes) {
    try {
      const valor = await fn();
      const atualizado = new Date().toISOString();
      cacheCot.cambio = { valor, fonte, atualizado, ts: Date.now() };
      return res.json({ usd_brl: valor, fonte, atualizado });
    } catch (e) { erros.push(`${fonte}: ${e.message}`); console.warn(`[Câmbio] ${fonte} falhou: ${e.message}`); }
  }
  if (cacheCot.cambio)
    return res.json({ usd_brl: cacheCot.cambio.valor, fonte: cacheCot.cambio.fonte, atualizado: cacheCot.cambio.atualizado, stale: true });
  res.status(503).json({ error: "Câmbio indisponível: " + erros.join(" | "), usd_brl: null });
});

// ── Indicadores (CDI anualizado via Selic Over, Selic meta, IPCA) ─────────────
app.get("/api/indicadores", requireAuth, async (req, res) => {
  try {
    const [r1,r2,r3] = await Promise.all([
      fetchT("https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/2?formato=json"),
      fetchT("https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json"),
      fetchT("https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados/ultimos/1?formato=json"),
    ]);
    const selicOver = await r1.json();
    const selicMetaArr = await r2.json();
    const ipcaArr = await r3.json();
    const selicMeta = selicMetaArr[0];
    const ipca = ipcaArr[0];
    const taxaDiaria = parseFloat((selicOver[0] && selicOver[0].valor) || 0);
    const cdiAnual = parseFloat(((Math.pow(1 + taxaDiaria/100, 252) - 1) * 100).toFixed(2));
    res.json({
      cdi_anual: cdiAnual,
      cdi_diario: taxaDiaria,
      selic: parseFloat((selicMeta && selicMeta.valor) || 0),
      ipca_mensal: parseFloat((ipca && ipca.valor) || 0),
      fonte: "bcb",
      atualizado: new Date().toISOString(),
    });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── IPCA acumulado entre duas datas (real, mês a mês) ─────────────────────────
app.get("/api/ipca-acumulado", requireAuth, async (req, res) => {
  const { inicio, fim } = req.query;
  if (!inicio) return res.status(400).json({ error: "data de início obrigatória" });
  try {
    const di = new Date(inicio);
    const df = fim ? new Date(fim) : new Date();
    const fmtBCB = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados?formato=json&dataInicial=${fmtBCB(di)}&dataFinal=${fmtBCB(df)}`;
    const r = await fetchT(url, 8000);
    const dados = await r.json();
    let fator = 1;
    const meses = dados.map(d => {
      const v = parseFloat(d.valor);
      fator *= (1 + v/100);
      return { mes: d.data, ipca: v };
    });
    res.json({ fator, percentual: parseFloat(((fator-1)*100).toFixed(4)), meses, qtd_meses: meses.length, fonte: "bcb", atualizado: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── CDI acumulado entre duas datas (real, dia a dia) ──────────────────────────
app.get("/api/cdi-acumulado", requireAuth, async (req, res) => {
  const { inicio, fim } = req.query;
  if (!inicio) return res.status(400).json({ error: "data de início obrigatória" });
  try {
    const di = new Date(inicio);
    const df = fim ? new Date(fim) : new Date();
    const fmtBCB = d => `${String(d.getDate()).padStart(2,"0")}/${String(d.getMonth()+1).padStart(2,"0")}/${d.getFullYear()}`;
    const url = `https://api.bcb.gov.br/dados/serie/bcdata.sgs.12/dados?formato=json&dataInicial=${fmtBCB(di)}&dataFinal=${fmtBCB(df)}`;
    const r = await fetchT(url, 8000);
    const dados = await r.json();
    let fator = 1;
    dados.forEach(d => { fator *= (1 + parseFloat(d.valor)/100); });
    res.json({ fator, percentual: parseFloat(((fator-1)*100).toFixed(4)), qtd_dias: dados.length, fonte: "bcb", atualizado: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Proventos B3 ──────────────────────────────────────────────────────────────
app.get("/api/proventos/:ticker", requireAuth, async (req, res) => {
  const { ticker } = req.params;
  try {
    const r = await fetchT(`https://brapi.dev/api/quote/${ticker}?modules=dividendsData&token=${BRAPI_TOKEN}`);
    const d = await r.json();
    const divs = (d && d.results && d.results[0] && d.results[0].dividendsData && d.results[0].dividendsData.cashDividends) || [];
    res.json({ ticker, proventos: divs.slice(0,12).map(x => ({ ticker, tipo:x.label||"Dividendo", valor:x.rate, data_com:x.lastDatePrior, data_pagamento:x.paymentDate })), fonte:"brapi", atualizado:new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Dados do portfólio: carregar e salvar (compartilhado por todos os logins) ──
// Documento único identificado por "portfolio_familiar"
app.get("/api/dados", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Banco de dados indisponível" });
  try {
    const doc = await db.collection("portfolios").findOne({ _id: "portfolio_familiar" });
    if (!doc) {
      return res.json({ assets:[], provs:[], operacoes:[], snapshots:{}, ativosZerados:{}, goalsTotal:null, goalsClass:null, fatoresAcum:{} });
    }
    const { _id, atualizado, ...dados } = doc;
    res.json({ ...dados, atualizado });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/dados", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Banco de dados indisponível" });
  try {
    const dados = req.body || {};
    // Remove campos que não devem ser persistidos
    delete dados._id;
    await db.collection("portfolios").updateOne(
      { _id: "portfolio_familiar" },
      { $set: { ...dados, atualizado: new Date().toISOString(), atualizadoPor: req.user.sub } },
      { upsert: true }
    );
    res.json({ ok: true, atualizado: new Date().toISOString() });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status:"ok", versao:"4.1.0", msg:"Backend com MongoDB", db: db ? "conectado" : "desconectado" });
});

app.listen(PORT, () => console.log(`Servidor na porta ${PORT}`));
