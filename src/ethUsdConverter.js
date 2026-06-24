const DEFAULT_ETH_USD_URL = "https://api.coinbase.com/v2/prices/ETH-USD/spot";

function formatUsd(value) {
  if (!Number.isFinite(value)) return "";

  const maximumFractionDigits = value >= 100 ? 0 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits,
  }).format(value);
}

async function fetchJsonWithTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "pooga-labs-sales-bot/0.1",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      throw new Error(`ETH/USD fetch failed with ${response.status}`);
    }

    return response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function extractEthUsdRate(body) {
  const amount = body && body.data && body.data.amount;
  const rate = Number(amount);
  return Number.isFinite(rate) && rate > 0 ? rate : null;
}

function createEthUsdConverter(options = {}) {
  const enabled = options.enabled !== false;
  const sourceUrl = options.sourceUrl || DEFAULT_ETH_USD_URL;
  const timeoutMs = options.timeoutMs || 3000;
  const cacheTtlMs = options.cacheTtlMs || 2 * 60 * 1000;
  let cache = null;

  async function getRate() {
    if (!enabled) return null;
    if (cache && cache.expiresAt > Date.now()) return cache.rate;

    const body = await fetchJsonWithTimeout(sourceUrl, timeoutMs);
    const rate = extractEthUsdRate(body);
    if (!rate) {
      throw new Error("ETH/USD response did not include a valid price");
    }

    cache = {
      rate,
      expiresAt: Date.now() + cacheTtlMs,
    };
    return rate;
  }

  async function enrichSale(sale) {
    if (!enabled) return sale;

    const ethValue = Number(sale.ethValue || 0);
    if (!Number.isFinite(ethValue) || ethValue <= 0) return sale;

    try {
      const rate = await getRate();
      if (!rate) return sale;

      const usdValue = ethValue * rate;
      return {
        ...sale,
        ethUsdRate: rate,
        usdValue,
        usdDisplay: formatUsd(usdValue),
      };
    } catch (error) {
      console.warn(`ETH/USD conversion skipped: ${error.message}`);
      return sale;
    }
  }

  return {
    enrichSale,
    getRate,
  };
}

module.exports = {
  createEthUsdConverter,
  extractEthUsdRate,
  formatUsd,
};
