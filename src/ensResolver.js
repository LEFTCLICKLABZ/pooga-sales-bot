const { ethers } = require("ethers");

function withTimeout(promise, timeoutMs) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("ENS lookup timed out")), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function createProvider(rpcUrl) {
  if (rpcUrl) {
    return new ethers.JsonRpcProvider(rpcUrl, "mainnet");
  }

  return ethers.getDefaultProvider("mainnet");
}

function createEnsResolver(options = {}) {
  const enabled = options.enabled !== false;
  const provider = enabled ? createProvider(options.rpcUrl) : null;
  const timeoutMs = options.timeoutMs || 1500;
  const cacheTtlMs = options.cacheTtlMs || 24 * 60 * 60 * 1000;
  const cache = new Map();

  async function lookup(address) {
    if (!enabled || !address || !ethers.isAddress(address)) return null;

    const cacheKey = address.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.name;
    }

    try {
      const name = await withTimeout(provider.lookupAddress(address), timeoutMs);
      cache.set(cacheKey, {
        name: name || null,
        expiresAt: Date.now() + cacheTtlMs,
      });
      return name || null;
    } catch (error) {
      console.warn(`ENS lookup failed for ${address}: ${error.message}`);
      cache.set(cacheKey, {
        name: null,
        expiresAt: Date.now() + Math.min(cacheTtlMs, 5 * 60 * 1000),
      });
      return null;
    }
  }

  async function enrichSale(sale) {
    const [sellerEns, buyerEns] = await Promise.all([
      lookup(sale.seller),
      lookup(sale.buyer),
    ]);

    return {
      ...sale,
      sellerDisplay: sellerEns || sale.sellerShort || sale.seller,
      buyerDisplay: buyerEns || sale.buyerShort || sale.buyer,
    };
  }

  return {
    lookup,
    enrichSale,
  };
}

module.exports = {
  createEnsResolver,
};
