const fs = require("node:fs");
const path = require("node:path");

const MAX_POSTED_IDS = 1000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

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
  return error.message || JSON.stringify(error.data || error);
}

function createStateStore(filePath, options = {}) {
  let state = loadState(filePath);
  let posted = new Set(state.postedSaleIds);
  const maxPendingSales = options.maxPendingSales || 250;

  function persist() {
    state.postedSaleIds = Array.from(posted).slice(-MAX_POSTED_IDS);
    state.pendingSales = state.pendingSales
      .filter((sale) => sale && sale.id && !saleIds(sale).some((id) => posted.has(id)))
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
        if (!sale || hasAny(saleIds(sale))) return false;
        return !sale.nextAttemptAt || Date.parse(sale.nextAttemptAt) <= now;
      });
    },

    pendingAll() {
      return state.pendingSales.filter((sale) => sale && !hasAny(saleIds(sale)));
    },

    upsertPending(sale) {
      if (!sale || !sale.id || hasAny(saleIds(sale))) return;

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
    },

    scheduleRetry(value, error) {
      const index = pendingIndex(value);
      if (index < 0) return null;

      const sale = state.pendingSales[index];
      const attempts = (sale.attempts || 0) + 1;
      const delay = Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
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
      return state.pendingSales.filter((sale) => sale && !hasAny(saleIds(sale))).length;
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
