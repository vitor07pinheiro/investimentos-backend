const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;
const BRAPI_TOKEN = process.env.BRAPI_TOKEN || "";

app.use(cors());
app.use(express.json());

// ── Helper: fetch com timeout ─────────────────────────────────────────────────
async function fetchWithTimeout(url, ms = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(id);
    return res;
  } catch (e) {
    clearTimeout(id);
    throw e;
  }
}

// ── Cotações B3 (ações + FIIs) ───────────────────────────────────────────────
app.get("/api/cotacoes/b3", async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "tickers obrigatório" });
  try {
    const r = await fetchWithTimeout(`https://brapi.dev/api/quote/${tickers}?token=${BRAPI_TOKEN}`);
    const data = await r.json();
    if (!data.results) return res.status(502).json({ error: "Resposta inválida da BRAPI", raw: data });
    res.json({
      cotacoes: data.results.map(q => ({
        ticker: q.symbol,
        preco: q.regularMarketPrice,
        variacao_dia: q.regularMarketChangePercent,
        nome: q.longName || q.shortName || q.symbol,
      })),
      fonte: "brapi",
      atualizado: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cotações EUA ─────────────────────────────────────────────────────────────
app.get("/api/cotacoes/eua", async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "tickers obrigatório" });
  try {
    const r = await fetchWithTimeout(`https://brapi.dev/api/quote/${tickers}?token=${BRAPI_TOKEN}&country=us`);
    const data = await r.json();
    if (!data.results) return res.status(502).json({ error: "Resposta inválida da BRAPI", raw: data });
    res.json({
      cotacoes: data.results.map(q => ({
        ticker: q.symbol,
        preco_usd: q.regularMarketPrice,
        variacao_dia: q.regularMarketChangePercent,
        nome: q.longName || q.shortName || q.symbol,
      })),
      fonte: "brapi",
      atualizado: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bitcoin ───────────────────────────────────────────────────────────────────
app.get("/api/cotacoes/crypto", async (req, res) => {
  try {
    const r = await fetchWithTimeout(
      "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=brl,usd&include_24hr_change=true"
    );
    const data = await r.json();
    res.json({
      bitcoin: {
        preco_brl: data.bitcoin.brl,
        preco_usd: data.bitcoin.usd,
        variacao_24h: data.bitcoin.brl_24h_change,
      },
      fonte: "coingecko",
      atualizado: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Câmbio USD/BRL — CORRIGIDO ────────────────────────────────────────────────
// Tenta BRAPI primeiro; se falhar, cai no Banco Central (série 1 = PTAX venda)
app.get("/api/cambio", async (req, res) => {
  // Tentativa 1: BRAPI
  try {
    const r = await fetchWithTimeout(
      `https://brapi.dev/api/v2/currency?currency=USD-BRL&token=${BRAPI_TOKEN}`, 5000
    );
    const data = await r.json();
    const rate = data?.currency?.[0]?.ask;
    if (rate && parseFloat(rate) > 1) {
      return res.json({
        usd_brl: parseFloat(rate),
        fonte: "brapi",
        atualizado: new Date().toISOString(),
      });
    }
  } catch (_) {}

  // Tentativa 2: Banco Central — PTAX Venda (série 10813)
  try {
    const hoje = new Date();
    const dd = String(hoje.getDate()).padStart(2, "0");
    const mm = String(hoje.getMonth() + 1).padStart(2, "0");
    const yyyy = hoje.getFullYear();
    // BCB usa formato MM/DD/YYYY nas datas
    const dataFim = `${mm}%2F${dd}%2F${yyyy}`;
    // Busca os últimos 5 dias úteis para garantir que tenha resultado
    const dataIni = `${mm}%2F${String(hoje.getDate() - 7).padStart(2,"0")}%2F${yyyy}`;
    const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='${dataIni}'&@dataFinalCotacao='${dataFim}'&$top=1&$orderby=dataHoraCotacao%20desc&$format=json&$select=cotacaoVenda,dataHoraCotacao`;
    const r = await fetchWithTimeout(url, 6000);
    const data = await r.json();
    const rate = data?.value?.[0]?.cotacaoVenda;
    if (rate) {
      return res.json({
        usd_brl: parseFloat(rate),
        fonte: "bcb_ptax",
        atualizado: new Date().toISOString(),
      });
    }
  } catch (_) {}

  // Fallback: retorna null para o app saber que falhou
  res.status(503).json({ error: "Não foi possível obter câmbio", usd_brl: null });
});

// ── Indicadores — CORRIGIDO ───────────────────────────────────────────────────
// CDI: proxy via taxa Selic Over diária (série BCB 11) acumulada para % anual
// Selic meta: série BCB 432
// IPCA mensal: série BCB 433
app.get("/api/indicadores", async (req, res) => {
  try {
    const [selicOverR, selicMetaR, ipcaR] = await Promise.all([
      // Selic Over diária — últimos 2 registros
      fetchWithTimeout("https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/2?formato=json"),
      // Selic meta (% a.a.)
      fetchWithTimeout("https://api.bcb.gov.br/dados/serie/bcdata.sgs.432/dados/ultimos/1?formato=json"),
      // IPCA mensal
      fetchWithTimeout("https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados/ultimos/1?formato=json"),
    ]);

    const selicOverData = await selicOverR.json();
    const [selicMeta]   = await selicMetaR.json();
    const [ipca]        = await ipcaR.json();

    // Selic Over diária → anualizar: (1 + taxa_diaria/100)^252 - 1
    const taxaDiaria = parseFloat(selicOverData?.[0]?.valor || 0);
    const cdiAnual   = parseFloat(((Math.pow(1 + taxaDiaria / 100, 252) - 1) * 100).toFixed(2));

    res.json({
      cdi_anual:    cdiAnual,
      cdi_diario:   taxaDiaria,
      selic:        parseFloat(selicMeta?.valor  || 0),
      ipca_mensal:  parseFloat(ipca?.valor || 0),
      fonte:        "bcb",
      atualizado:   new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Proventos B3 ─────────────────────────────────────────────────────────────
app.get("/api/proventos/:ticker", async (req, res) => {
  const { ticker } = req.params;
  try {
    const r = await fetchWithTimeout(
      `https://brapi.dev/api/quote/${ticker}?modules=dividendsData&token=${BRAPI_TOKEN}`
    );
    const data = await r.json();
    const divs = data?.results?.[0]?.dividendsData?.cashDividends || [];
    res.json({
      ticker,
      proventos: divs.slice(0, 12).map(d => ({
        ticker,
        tipo: d.label || "Dividendo",
        valor: d.rate,
        data_com: d.lastDatePrior,
        data_pagamento: d.paymentDate,
      })),
      fonte: "brapi",
      atualizado: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", versao: "1.1.0", msg: "Backend Investimentos Familiares rodando" });
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
