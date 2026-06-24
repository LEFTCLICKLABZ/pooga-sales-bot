const { config, validateConfig } = require("./config");
const { createStateStore } = require("./stateStore");
const { createXPoster } = require("./xClient");
const { createEnsResolver } = require("./ensResolver");
const { createOpenSeaProfileResolver } = require("./accountProfiles");
const { createSalesProcessor } = require("./salesProcessor");
const { createEthUsdConverter } = require("./ethUsdConverter");

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

async function main() {
  validateConfig();

  const force = hasFlag("force");
  const state = createStateStore(config.bot.stateFile, {
    maxPendingSales: config.bot.maxPendingSales,
    maxPendingAgeMs: config.bot.pendingMaxAgeMs,
    forbiddenBackoffMs: config.bot.forbiddenBackoffMs,
  });
  const xPoster = config.dryRun ? null : createXPoster(config.x);
  const ensResolver = createEnsResolver(config.ens);
  const profileResolver = createOpenSeaProfileResolver({
    apiKey: config.opensea.apiKey,
  });
  const usdConverter = createEthUsdConverter(config.usd);
  const salesProcessor = createSalesProcessor({
    config,
    state,
    xPoster,
    ensResolver,
    profileResolver,
    usdConverter,
  });

  const prunedPendingCount = state.prunePending();
  if (prunedPendingCount > 0) {
    console.log(`Dropped ${prunedPendingCount} stale pending sale(s)`);
  }
  console.log(
    `Retrying pending sales with DRY_RUN=${config.dryRun}, force=${force}. Queue contains ${state.pendingCount()} sale(s).`,
  );
  if (xPoster) {
    console.log(`Using X auth mode: ${xPoster.authMode}`);
  }
  await salesProcessor.drainPendingSales("manual retry", { force });
  console.log(`Retry complete. Pending queue contains ${state.pendingCount()} sale(s).`);
}

main().catch((error) => {
  console.error("Pending retry failed", error);
  process.exit(1);
});
