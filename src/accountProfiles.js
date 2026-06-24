function normalizeXHandle(value) {
  if (!value) return "";
  const handle = String(value)
    .trim()
    .replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, "")
    .replace(/^@/, "")
    .split(/[/?#]/)[0]
    .replace(/[^A-Za-z0-9_]/g, "");

  return handle ? `@${handle}` : "";
}

function socialAccountHandle(account) {
  if (!account || typeof account !== "object") return "";

  const platform = String(
    account.platform || account.provider || account.type || account.service || "",
  ).toLowerCase();
  const isX = ["x", "twitter"].some((name) => platform.includes(name));
  if (!isX) return "";

  return normalizeXHandle(
    account.username || account.handle || account.account || account.value || account.url,
  );
}

function extractXHandle(profile) {
  if (!profile || typeof profile !== "object") return "";

  const direct = normalizeXHandle(
    profile.twitter_username ||
      profile.x_username ||
      profile.twitter ||
      profile.x ||
      profile.twitter_url ||
      profile.x_url,
  );
  if (direct) return direct;

  const accounts = Array.isArray(profile.social_media_accounts)
    ? profile.social_media_accounts
    : [];
  for (const account of accounts) {
    const handle = socialAccountHandle(account);
    if (handle) return handle;
  }

  return "";
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 2500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function createOpenSeaProfileResolver(options = {}) {
  const apiKey = options.apiKey;
  const cacheTtlMs = options.cacheTtlMs || 12 * 60 * 60 * 1000;
  const timeoutMs = options.timeoutMs || 2500;
  const cache = new Map();

  async function getProfile(address) {
    if (!apiKey || !address) return null;

    const cacheKey = address.toLowerCase();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.profile;
    }

    try {
      const response = await fetchJsonWithTimeout(
        `https://api.opensea.io/api/v2/accounts/${encodeURIComponent(address)}`,
        {
          headers: {
            accept: "application/json",
            "x-api-key": apiKey,
          },
        },
        timeoutMs,
      );

      if (response.status === 404) {
        cache.set(cacheKey, { profile: null, expiresAt: Date.now() + cacheTtlMs });
        return null;
      }

      if (!response.ok) {
        throw new Error(`OpenSea profile lookup failed with ${response.status}`);
      }

      const profile = await response.json();
      cache.set(cacheKey, { profile, expiresAt: Date.now() + cacheTtlMs });
      return profile;
    } catch (error) {
      console.warn(`OpenSea profile lookup failed for ${address}: ${error.message}`);
      cache.set(cacheKey, {
        profile: null,
        expiresAt: Date.now() + Math.min(cacheTtlMs, 5 * 60 * 1000),
      });
      return null;
    }
  }

  async function enrichSale(sale) {
    const [sellerProfile, buyerProfile] = await Promise.all([
      getProfile(sale.seller),
      getProfile(sale.buyer),
    ]);

    return {
      ...sale,
      sellerXHandle: extractXHandle(sellerProfile),
      buyerXHandle: extractXHandle(buyerProfile),
      sellerOpenSeaUsername: sellerProfile && sellerProfile.username,
      buyerOpenSeaUsername: buyerProfile && buyerProfile.username,
    };
  }

  return {
    getProfile,
    enrichSale,
  };
}

module.exports = {
  createOpenSeaProfileResolver,
  extractXHandle,
  normalizeXHandle,
};
