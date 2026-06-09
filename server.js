const express = require("express");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3001;

const BRAPI_TOKEN = process.env.BRAPI_TOKEN || "";
const CDI_ANUAL = 10.65;

app.use(cors());
app.use(express.json());

// ── Cotações B3 (ações + FIIs) ──────────────────────────────────────────────
app.get("/api/cotacoes/b3", async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "tickers obrigatório" });

  try {
    const url = `https://brapi.dev/api/quote/${tickers}?token=${BRAPI_TOKEN}`;
    const r = await fetch(url);
    const data = await r.json();

    if (!data.results) return res.status(502).json({ error: "Resposta inválida da BRAPI", raw: data });

    const cotacoes = data.results.map(q => ({
      ticker: q.symbol,
      preco: q.regularMarketPrice,
      variacao_dia: q.regularMarketChangePercent,
      nome: q.longName || q.shortName || q.symbol,
    }));

    res.json({ cotacoes, fonte: "brapi", atualizado: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Cotações EUA (ações + REITs + ETFs) ─────────────────────────────────────
app.get("/api/cotacoes/eua", async (req, res) => {
  const { tickers } = req.query;
  if (!tickers) return res.status(400).json({ error: "tickers obrigatório" });

  try {
    const url = `https://brapi.dev/api/quote/${tickers}?token=${BRAPI_TOKEN}&country=us`;
    const r = await fetch(url);
    const data = await r.json();

    if (!data.results) return res.status(502).json({ error: "Resposta inválida da BRAPI", raw: data });

    const cotacoes = data.results.map(q => ({
      ticker: q.symbol,
      preco_usd: q.regularMarketPrice,
      variacao_dia: q.regularMarketChangePercent,
      nome: q.longName || q.shortName || q.symbol,
    }));

    res.json({ cotacoes, fonte: "brapi", atualizado: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Bitcoin (BRL e USD) ──────────────────────────────────────────────────────
app.get("/api/cotacoes/crypto", async (req, res) => {
  try {
    const r = await fetch(
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

// ── Câmbio USD/BRL ───────────────────────────────────────────────────────────
app.get("/api/cambio", async (req, res) => {
  try {
    const r = await fetch(
      `https://brapi.dev/api/v2/currency?currency=USD-BRL&token=${BRAPI_TOKEN}`
    );
    const data = await r.json();
    const rate = data?.currency?.[0]?.ask;

    res.json({
      usd_brl: rate ? parseFloat(rate) : null,
      fonte: "brapi",
      atualizado: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Indicadores (CDI / Selic / IPCA) ─────────────────────────────────────────
app.get("/api/indicadores", async (req, res) => {
  try {
    const [selicR, ipcaR] = await Promise.all([
      fetch("https://api.bcb.gov.br/dados/serie/bcdata.sgs.11/dados/ultimos/1?formato=json"),
      fetch("https://api.bcb.gov.br/dados/serie/bcdata.sgs.433/dados/ultimos/1?formato=json"),
    ]);
    const [selic] = await selicR.json();
    const [ipca] = await ipcaR.json();

    res.json({
      cdi_anual: CDI_ANUAL,
      selic: parseFloat(selic?.valor || 0),
      ipca_mensal: parseFloat(ipca?.valor || 0),
      fonte: "bcb",
      atualizado: new Date().toISOString(),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Proventos B3 ─────────────────────────────────────────────────────────────
app.get("/api/proventos/:ticker", async (req, res) => {
  const { ticker } = req.params;
  try {
    const url = `https://brapi.dev/api/quote/${ticker}?modules=dividendsData&token=${BRAPI_TOKEN}`;
    const r = await fetch(url);
    const data = await r.json();
    const divs = data?.results?.[0]?.dividendsData?.cashDividends || [];

    const proventos = divs.slice(0, 12).map(d => ({
      ticker,
      tipo: d.label || "Dividendo",
      valor: d.rate,
      data_com: d.lastDatePrior,
      data_pagamento: d.paymentDate,
    }));

    res.json({ ticker, proventos, fonte: "brapi", atualizado: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health check ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "ok", versao: "1.0.0", msg: "Backend Investimentos Familiares rodando" });
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
