const { buildTweet } = require("./tweetTemplate");

function createSalesProcessor({
  config,
  state,
  xPoster,
  ensResolver,
  profileResolver,
  usdConverter,
}) {
  let postQueue = Promise.resolve();
  let lastPostAttemptAt = 0;
  let xCooldownUntil = 0;

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function errorStatus(error) {
    return Number(error?.code || error?.status || error?.data?.status || 0);
  }

  function rateLimitDelayMs(error) {
    const resetSeconds = Number(error?.rateLimit?.reset || 0);
    if (!Number.isFinite(resetSeconds) || resetSeconds <= 0) {
      return 15 * 60_000;
    }

    return Math.max(15 * 60_000, resetSeconds * 1000 - Date.now());
  }

  function cooldownDelayMs(error) {
    const status = errorStatus(error);
    if (status === 429) return rateLimitDelayMs(error);
    if (status === 403) return Number(config.bot.forbiddenBackoffMs || 60 * 60_000);
    return 0;
  }

  function summarizeError(error) {
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
      error?.message ? `message=${error.message}` : "",
      rateLimit,
    ].filter(Boolean);

    return pieces.join(" ") || String(error);
  }

  async function waitForPostSlot() {
    const postIntervalMs = Math.max(0, Number(config.bot.postIntervalMs || 0));
    const nextAllowedAt = Math.max(lastPostAttemptAt + postIntervalMs, xCooldownUntil);
    const waitMs = nextAllowedAt - Date.now();

    if (waitMs > 0) {
      console.log(`Waiting ${Math.ceil(waitMs / 1000)}s before next X post attempt`);
      await sleep(waitMs);
    }

    lastPostAttemptAt = Date.now();
  }

  async function enrichSale(sale) {
    const ensSale = ensResolver ? await ensResolver.enrichSale(sale) : sale;
    const profileSale = profileResolver ? await profileResolver.enrichSale(ensSale) : ensSale;
    return usdConverter ? usdConverter.enrichSale(profileSale) : profileSale;
  }

  async function postSaleNow(sale) {
    const displaySale = await enrichSale(sale);
    const tweet = buildTweet(displaySale, config.bot);

    if (config.dryRun) {
      console.log("DRY_RUN=true; would post this tweet:");
      console.log("---");
      console.log(tweet);
      console.log("---");
      if (displaySale.imageUrl && config.x.postImages) {
        console.log(`Would attach image: ${displaySale.imageUrl}`);
      }
      return;
    }

    try {
      await waitForPostSlot();
      const posted = await xPoster.post(tweet, {
        imageUrl: displaySale.imageUrl,
        altText: `${displaySale.collectionName || "NFT"} ${displaySale.name}`,
      });
      state.markPosted(sale);
      console.log(
        `Posted sale ${sale.id} to X as tweet ${posted.data.id} with image=${posted.mediaUploaded}`,
      );
    } catch (error) {
      const pending = state.scheduleRetry(sale, error);
      const retryAt =
        pending && pending.nextAttemptAt ? `; retrying at ${pending.nextAttemptAt}` : "";
      const cooldownMs = cooldownDelayMs(error);
      if (cooldownMs > 0) {
        xCooldownUntil = Math.max(xCooldownUntil, Date.now() + cooldownMs);
      }

      console.error(
        `Failed to post sale ${sale.id} to X${retryAt}: ${summarizeError(error)}`,
      );
    }
  }

  function postSale(sale) {
    const run = postQueue.catch(() => {}).then(() => postSaleNow(sale));
    postQueue = run.catch(() => {});
    return run;
  }

  async function handleSale(sale) {
    if (!sale.id) {
      console.warn("Skipping sale without a stable ID", sale.raw);
      return;
    }

    const saleTime = Date.parse(sale.eventTimestamp || "");
    if (
      config.bot.ignoreSalesBeforeMs &&
      Number.isFinite(saleTime) &&
      saleTime < config.bot.ignoreSalesBeforeMs
    ) {
      console.log(`Skipping pre-launch sale ${sale.id}`);
      state.markPosted(sale);
      return;
    }

    if (state.has(sale)) {
      console.log(`Skipping already-posted sale ${sale.id}`);
      return;
    }

    if (sale.ethValue < config.bot.minSaleEth) {
      console.log(`Skipping sale below MIN_SALE_ETH: ${sale.ethValue} ETH`);
      return;
    }

    if (!config.dryRun) {
      const wasPending = state.isPending(sale);
      const wasAdded = state.upsertPending(sale);
      if (wasPending && !wasAdded) {
        console.log(`Skipping already-pending sale ${sale.id}`);
        return;
      }
    }

    await postSale(sale);
  }

  async function drainPendingSales(reason, options = {}) {
    if (config.dryRun) return;

    const allDueSales = options.force ? state.pendingAll() : state.pendingDue();
    const retryBatchSize = Math.max(1, Number(config.bot.retryBatchSize || 1));
    const dueSales = allDueSales.slice(0, retryBatchSize);
    if (dueSales.length === 0) return;

    const suffix =
      allDueSales.length > dueSales.length ? ` (${allDueSales.length} due total)` : "";
    console.log(`Retrying ${dueSales.length} pending sale(s) from ${reason}${suffix}`);
    for (const sale of dueSales) {
      if (!state.has(sale)) {
        await postSale(sale);
      }
    }
  }

  return {
    drainPendingSales,
    handleSale,
    postSale,
  };
}

module.exports = {
  createSalesProcessor,
};
