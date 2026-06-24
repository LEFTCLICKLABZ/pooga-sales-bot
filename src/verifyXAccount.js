const { config } = require("./config");
const { createXPoster } = require("./xClient");

async function main() {
  if (!config.x.expectedUsername) {
    throw new Error("X_EXPECTED_USERNAME is required before verifying the posting account.");
  }

  const poster = createXPoster(config.x);
  const user = await poster.verifyAccount({ force: true });

  if (!user) {
    throw new Error("Could not verify the X account from the configured credentials.");
  }

  console.log(`Verified X posting account: @${user.username} (${user.id})`);
  console.log("No tweet was posted.");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
