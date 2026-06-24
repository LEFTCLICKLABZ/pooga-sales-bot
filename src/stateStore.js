const fs = require("node:fs");
const path = require("node:path");

const MAX_POSTED_IDS = 1000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;
const DEFAULT_FORBIDDEN_BACKOFF_MS = 60 * 60_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60_000;

function loadState(filePath) {
  if (!fs.existsSync(filePath)) {
    return { postedSaleIds: [], pendingSales: [] };
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  return {
    postedSaleIds: Array.isArray(parsed.postedSaleIds) ? parsed.postedSaleIds : [],
    pendingSales: Array.isArray(parsed.pendingSales) ? parsed.pendingSales : [],
  };
}

function saveState(filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function sanitizeSale(sale) {
  const { raw, ...rest } = sale;
  return rest;
}

function saleIds(value) {
  if (!value) return [];
  if (typeof value === "string") return [value].filter(Boolean);

  return [value.id, ...(Array.isArray(value.legacyIds) ? value.legacyIds : [])]
    .filter(Boolean)
    .map(String);
}

function errorMessage(error) {
  if (!error) return "";
  if (typeof error === "string") return error;

  const status = errorStatus(error);
  const title = error?.data?.title || error?.title;
  const detail = error?.data?.detail || error?.detail;
  const rateLimit = error?.rateLimit
    ? ` rateLimit=${error.rateLimit.remaining}/${error.rateLimit.limit} reset=${error.rateLimit.reset}`
    : "";
  const pieces = [
    status ? `status=${status}` : "",
    title ? `title=${title}` : "",
    detail ? `detail=${detail}` : "",
    error.message ? `message=${error.message}` : "",
    rateLimit,
  ].filter(Boolean);

  return pieces.join(" ");
}

function errorStatus(error) {
  return Number(error?.code || error?.status || error?.data?.status || 0);
}

function rateLimitDelayMs(error) {
  const resetSeconds = Number(error?.rateLimit?.reset || 0);
  if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) {
    return DEFAULT_RATE_LIMIT_BACKOFF_MS;
  }

  const resetDelay = resetSeconds * 1000 - Date.now();
  return Math.max(DEFAULT_RATE_LIMIT_BACKOFF_MS, resetDelay);
}

function retryDelayMs(error, attempts, options) {
  const status = errorStatus(error);

  if (status === 429) {
    return rateLimitDelayMs(error);
  }

  if (status === 403) {
    return Number(options.forbiddenBackoffMs || DEFAULT_FORBIDDEN_BACKOFF_MS);
  }

  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

function pendingStartedAt(sale) {
  const timestamp = Date.parse(sale?.pendingSince || sale?.eventTimestamp || "");
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function createStateStore(filePath, options = {}) {
  let state = loadState(filePath);
  let posted = new Set(state.postedSaleIds);
  const maxPendingSales = options.maxPendingSales || 250;
  const maxPendingAgeMs = Number(options.maxPendingAgeMs || 0);

  function isFreshPending(sale, now = Date.now()) {
    if (!sale || hasAny(saleIds(sale))) return false;
    if (!maxPendingAgeMs) return true;

    const startedAt = pendingStartedAt(sale);
    if (!startedAt) return true;
    return now - startedAt <= maxPendingAgeMs;
  }

  function persist() {
    const now = Date.now();
    state.postedSaleIds = Array.from(posted).slice(-MAX_POSTED_IDS);
    state.pendingSales = state.pendingSales
      .filter((sale) => sale && sale.id && isFreshPending(sale, now))
      .slice(-maxPendingSales);
    posted = new Set(state.postedSaleIds);
    saveState(filePath, state);
  }

  function hasAny(ids) {
    return ids.some((id) => posted.has(id));
  }

  function pendingIndex(value) {
    const ids = new Set(saleIds(value));
    return state.pendingSales.findIndex((sale) =>
      saleIds(sale).some((id) => ids.has(id)),
    );
  }

  return {
    has(value) {
      return hasAny(saleIds(value));
    },

    pendingDue(now = Date.now()) {
      return state.pendingSales.filter((sale) => {
        if (!isFreshPending(sale, now)) return false;
        return !sale.nextAttemptAt || Date.parse(sale.nextAttemptAt) <= now;
      });
    },

    pendingAll() {
      return state.pendingSales.filter((sale) => isFreshPending(sale));
    },

    isPending(value) {
      return pendingIndex(value) >= 0;
    },

    upsertPending(sale) {
      if (!sale || !sale.id || hasAny(saleIds(sale))) return false;

      const index = pendingIndex(sale);
      const existing = index >= 0 ? state.pendingSales[index] : {};
      const pendingSale = {
        ...existing,
        ...sanitizeSale(sale),
        pendingSince: existing.pendingSince || new Date().toISOString(),
        attempts: existing.attempts || 0,
        nextAttemptAt: existing.nextAttemptAt || null,
      };

      if (index >= 0) {
        state.pendingSales[index] = pendingSale;
      } else {
        state.pendingSales.push(pendingSale);
      }
      persist();
      return index < 0;
    },

    scheduleRetry(value, error) {
      const index = pendingIndex(value);
      if (index < 0) return null;

      const sale = state.pendingSales[index];
      const attempts = (sale.attempts || 0) + 1;
      const delay = retryDelayMs(error, attempts, options);
      const nextAttemptAt = new Date(Date.now() + delay).toISOString();

      state.pendingSales[index] = {
        ...sale,
        attempts,
        nextAttemptAt,
        lastError: errorMessage(error).slice(0, 500),
      };
      persist();
      return state.pendingSales[index];
    },

    pendingCount() {
      return state.pendingSales.filter((sale) => isFreshPending(sale)).length;
    },

    prunePending() {
      const before = state.pendingSales.length;
      persist();
      return Math.max(0, before - state.pendingSales.length);
    },

    dropPending(value) {
      const ids = new Set(saleIds(value));
      const before = state.pendingSales.length;
      state.pendingSales = state.pendingSales.filter(
        (pendingSale) => !saleIds(pendingSale).some((id) => ids.has(id)),
      );
      persist();
      return before !== state.pendingSales.length;
    },

    markPosted(sale) {
      saleIds(sale).forEach((id) => posted.add(id));
      const ids = new Set(saleIds(sale));
      state.pendingSales = state.pendingSales.filter(
        (pendingSale) => !saleIds(pendingSale).some((id) => ids.has(id)),
      );
      persist();
    },
  };
}

module.exports = {
  createStateStore,
};
