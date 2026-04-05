const { loadEnv } = require("./core/env");

loadEnv();

const { createBotClient } = require("./core/client");
const { config } = require("./core/config");
const { loadFeatures } = require("./core/storage");
const { wireInteractionHandlers } = require("./interactions/interactions");

async function main() {
  const features = loadFeatures();
  const client = createBotClient(features);
  wireInteractionHandlers(client);

  client.once("clientReady", async () => {
    console.log(`[bot] Logged in as ${client.user.tag}`);

    for (const feature of features) {
      if (typeof feature.onReady === "function") {
        await feature.onReady({ client });
      }
    }
  });

  await client.login(config.token);
}

main().catch((error) => {
  console.error("[bot] Startup failed:", error);
  process.exit(1);
});
