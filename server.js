const express = require('express');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Separate caches for fast and slow exchanges
let fastCache = { data: [], timestamp: 0 };
let okxCache = { data: [], timestamp: 0 };
const FAST_TTL = 30000;
const OKX_TTL = 120000;

// ============ Exchange API Fetchers ============

async function fetchBinance() {
  try {
    const [premiumRes, tickerRes, fundingInfoRes] = await Promise.all([
      axios.get('https://fapi.binance.com/fapi/v1/premiumIndex'),
      axios.get('https://fapi.binance.com/fapi/v1/ticker/24hr'),
      axios.get('https://fapi.binance.com/fapi/v1/fundingInfo'),
    ]);
    const volumeMap = {};
    for (const t of tickerRes.data) {
      volumeMap[t.symbol] = parseFloat(t.quoteVolume || 0);
    }
    const intervalMap = {};
    for (const f of fundingInfoRes.data) {
      intervalMap[f.symbol] = f.fundingIntervalHours || 8;
    }
    return premiumRes.data
      .filter(item => item.symbol.endsWith('USDT'))
      .map(item => ({
        exchange: 'Binance',
        symbol: item.symbol.replace('USDT', ''),
        price: parseFloat(item.markPrice),
        fundingRate: parseFloat(item.lastFundingRate) * 100,
        nextFundingTime: item.nextFundingTime,
        volume24h: volumeMap[item.symbol] || 0,
        interval: intervalMap[item.symbol] || 8,
        openInterest: 0, // Binance has no batch OI endpoint
      }));
  } catch (e) {
    console.error('Binance error:', e.message);
    return [];
  }
}

async function fetchBybit() {
  try {
    const res = await axios.get('https://api.bybit.com/v5/market/tickers', {
      params: { category: 'linear' }
    });
    return (res.data.result?.list || [])
      .filter(item => item.symbol.endsWith('USDT'))
      .map(item => ({
        exchange: 'Bybit',
        symbol: item.symbol.replace('USDT', ''),
        price: parseFloat(item.markPrice),
        fundingRate: parseFloat(item.fundingRate) * 100,
        nextFundingTime: parseInt(item.nextFundingTime),
        volume24h: parseFloat(item.turnover24h || 0),
        interval: parseInt(item.fundingIntervalHour) || 8,
        openInterest: parseFloat(item.openInterestValue || 0),
      }));
  } catch (e) {
    console.error('Bybit error:', e.message);
    return [];
  }
}

async function fetchOKX() {
  try {
    const [tickerRes, oiRes] = await Promise.all([
      axios.get('https://www.okx.com/api/v5/market/tickers', { params: { instType: 'SWAP' } }),
      axios.get('https://www.okx.com/api/v5/public/open-interest', { params: { instType: 'SWAP' } }),
    ]);
    const usdtSwaps = (tickerRes.data.data || []).filter(t => t.instId.endsWith('USDT-SWAP'));

    // OI map
    const oiMap = {};
    for (const o of (oiRes.data.data || [])) {
      oiMap[o.instId] = parseFloat(o.oiUsd || 0);
    }

    // Fetch funding rates in batches
    const batchSize = 30;
    const results = [];
    for (let i = 0; i < usdtSwaps.length; i += batchSize) {
      const batch = usdtSwaps.slice(i, i + batchSize);
      const batchResults = await Promise.all(
        batch.map(t =>
          axios.get('https://www.okx.com/api/v5/public/funding-rate', {
            params: { instId: t.instId }, timeout: 5000
          }).then(r => r.data.data?.[0]).catch(() => null)
        )
      );
      results.push(...batchResults);
    }

    const fundingMap = {};
    for (const fr of results) {
      if (fr) fundingMap[fr.instId] = fr;
    }

    return usdtSwaps.map(t => {
      const fr = fundingMap[t.instId];
      let interval = 8;
      if (fr && fr.fundingTime && fr.nextFundingTime) {
        const diff = (parseInt(fr.nextFundingTime) - parseInt(fr.fundingTime)) / 3600000;
        if (diff > 0 && diff <= 24) interval = Math.round(diff);
      }
      // OKX volCcy24h is in base currency (e.g. BTC), convert to USDT
      const price = parseFloat(t.last || 0);
      const volBase = parseFloat(t.volCcy24h || 0);
      return {
        exchange: 'OKX',
        symbol: t.instId.replace('-USDT-SWAP', ''),
        price,
        fundingRate: fr ? parseFloat(fr.fundingRate) * 100 : 0,
        nextFundingTime: fr ? parseInt(fr.nextFundingTime) : 0,
        volume24h: volBase * price,
        interval,
        openInterest: oiMap[t.instId] || 0,
      };
    });
  } catch (e) {
    console.error('OKX error:', e.message);
    return [];
  }
}

async function fetchBitget() {
  try {
    const [tickerRes, contractRes] = await Promise.all([
      axios.get('https://api.bitget.com/api/v2/mix/market/tickers', {
        params: { productType: 'USDT-FUTURES' }
      }),
      axios.get('https://api.bitget.com/api/v2/mix/market/contracts', {
        params: { productType: 'USDT-FUTURES' }
      }),
    ]);
    const intervalMap = {};
    for (const c of (contractRes.data.data || [])) {
      intervalMap[c.symbol] = parseInt(c.fundInterval) || 8;
    }
    return (tickerRes.data.data || [])
      .filter(item => item.symbol.endsWith('USDT'))
      .map(item => {
        const price = parseFloat(item.lastPr || item.last || 0);
        const holdingAmount = parseFloat(item.holdingAmount || 0);
        return {
          exchange: 'Bitget',
          symbol: item.symbol.replace('USDT', ''),
          price,
          fundingRate: parseFloat(item.fundingRate || 0) * 100,
          nextFundingTime: parseInt(item.nextFundingTime || 0),
          volume24h: parseFloat(item.usdtVolume || item.quoteVolume || 0),
          interval: intervalMap[item.symbol] || 8,
          openInterest: holdingAmount * price,
        };
      });
  } catch (e) {
    console.error('Bitget error:', e.message);
    return [];
  }
}

async function fetchGate() {
  try {
    // Use both contracts (for funding info) and tickers (for volume/OI)
    const [contractRes, tickerRes] = await Promise.all([
      axios.get('https://api.gateio.ws/api/v4/futures/usdt/contracts'),
      axios.get('https://api.gateio.ws/api/v4/futures/usdt/tickers'),
    ]);

    // Build maps from contracts (funding rate, interval, quanto_multiplier)
    const contractMap = {};
    for (const c of contractRes.data) {
      contractMap[c.name] = c;
    }

    // Build maps from tickers (volume, OI)
    const tickerMap = {};
    for (const t of tickerRes.data) {
      tickerMap[t.contract] = t;
    }

    return contractRes.data
      .filter(item => item.name.endsWith('_USDT'))
      .map(item => {
        const ticker = tickerMap[item.name] || {};
        const price = parseFloat(ticker.mark_price || item.mark_price || item.last_price || 0);
        const quantoMultiplier = parseFloat(item.quanto_multiplier || 1);
        const totalSize = parseFloat(ticker.total_size || 0);
        return {
          exchange: 'Gate',
          symbol: item.name.replace('_USDT', ''),
          price,
          fundingRate: parseFloat(ticker.funding_rate || item.funding_rate || 0) * 100,
          nextFundingTime: (item.funding_next_apply || 0) * 1000,
          volume24h: parseFloat(ticker.volume_24h_quote || ticker.volume_24h_settle || 0),
          interval: Math.round((parseInt(item.funding_interval) || 28800) / 3600),
          openInterest: totalSize * quantoMultiplier * price,
        };
      });
  } catch (e) {
    console.error('Gate error:', e.message);
    return [];
  }
}

async function fetchHyperliquid() {
  try {
    const hlHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Content-Type': 'application/json',
      'Origin': 'https://app.hyperliquid.xyz',
      'Referer': 'https://app.hyperliquid.xyz/',
    };
    const [metaRes, ctxRes] = await Promise.all([
      axios.post('https://api.hyperliquid.xyz/info', { type: 'meta' }, { headers: hlHeaders, timeout: 15000 }),
      axios.post('https://api.hyperliquid.xyz/info', { type: 'metaAndAssetCtxs' }, { headers: hlHeaders, timeout: 15000 }),
    ]);
    const universe = metaRes.data.universe || [];
    const assetCtxs = ctxRes.data?.[1] || [];
    return universe.map((asset, i) => {
      const ctx = assetCtxs[i] || {};
      const price = parseFloat(ctx.markPx || 0);
      const oiBase = parseFloat(ctx.openInterest || 0);
      return {
        exchange: 'Hyperliquid',
        symbol: asset.name,
        price,
        fundingRate: parseFloat(ctx.funding || 0) * 100,
        nextFundingTime: 0,
        volume24h: parseFloat(ctx.dayNtlVlm || 0),
        interval: 1,
        openInterest: oiBase * price,
      };
    }).filter(item => item.price > 0);
  } catch (e) {
    console.error('Hyperliquid error:', e.message);
    return [];
  }
}

async function fetchAster() {
  try {
    const [tickerRes, fundingRes, fundingInfoRes] = await Promise.all([
      axios.get('https://fapi.asterdex.com/fapi/v3/ticker/bookTicker'),
      axios.get('https://fapi.asterdex.com/fapi/v1/premiumIndex'),
      axios.get('https://fapi.asterdex.com/fapi/v1/fundingInfo'),
    ]);
    const priceMap = {};
    for (const t of (tickerRes.data || [])) {
      priceMap[t.symbol] = parseFloat(t.bidPrice || 0);
    }
    const intervalMap = {};
    for (const f of (fundingInfoRes.data || [])) {
      intervalMap[f.symbol] = f.fundingIntervalHours || 8;
    }
    return (fundingRes.data || [])
      .filter(item => item.symbol && item.symbol.endsWith('USDT'))
      .map(item => ({
        exchange: 'Aster',
        symbol: item.symbol.replace('USDT', ''),
        price: parseFloat(item.markPrice || priceMap[item.symbol] || 0),
        fundingRate: parseFloat(item.lastFundingRate || 0) * 100,
        nextFundingTime: parseInt(item.nextFundingTime || 0),
        volume24h: 0,
        interval: intervalMap[item.symbol] || 8,
        openInterest: 0,
      }))
      .filter(item => item.price > 0);
  } catch (e) {
    console.error('Aster error:', e.message);
    return [];
  }
}

// ============ Background OKX updater ============
async function updateOKX() {
  try {
    const data = await fetchOKX();
    okxCache = { data, timestamp: Date.now() };
    console.log(`OKX updated: ${data.length} pairs`);
  } catch (e) {
    console.error('OKX background update error:', e.message);
  }
}

updateOKX();
setInterval(updateOKX, OKX_TTL);

// ============ Main API Route ============

app.get('/api/funding-rates', async (req, res) => {
  const now = Date.now();

  if (!fastCache.data.length || now - fastCache.timestamp > FAST_TTL) {
    // If we have stale data, return it immediately and refresh in background
    if (fastCache.data.length && now - fastCache.timestamp > FAST_TTL) {
      setImmediate(async () => {
        try {
          const results = await Promise.allSettled([
            fetchBinance(), fetchBybit(), fetchBitget(),
            fetchGate(), fetchHyperliquid(), fetchAster(),
          ]);
          const fastData = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
          if (fastData.length) fastCache = { data: fastData, timestamp: Date.now(), results };
        } catch (e) { console.error('Background fast fetch error:', e.message); }
      });
    } else {
      // First load: wait for data
      try {
        const results = await Promise.allSettled([
          fetchBinance(), fetchBybit(), fetchBitget(),
          fetchGate(), fetchHyperliquid(), fetchAster(),
        ]);
        const fastData = results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
        fastCache = { data: fastData, timestamp: now, results };
      } catch (e) {
        console.error('Fast fetch error:', e.message);
      }
    }
  }

  const allData = [...fastCache.data, ...okxCache.data];
  const r = fastCache.results || [];

  const exchangeStatus = {
    Binance: r[0]?.status === 'fulfilled' ? r[0].value.length : 0,
    Bybit: r[1]?.status === 'fulfilled' ? r[1].value.length : 0,
    OKX: okxCache.data.length,
    Bitget: r[2]?.status === 'fulfilled' ? r[2].value.length : 0,
    Gate: r[3]?.status === 'fulfilled' ? r[3].value.length : 0,
    Hyperliquid: r[4]?.status === 'fulfilled' ? r[4].value.length : 0,
    Aster: r[5]?.status === 'fulfilled' ? r[5].value.length : 0,
  };

  res.json({
    timestamp: now,
    exchangeStatus,
    data: allData,
  });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
