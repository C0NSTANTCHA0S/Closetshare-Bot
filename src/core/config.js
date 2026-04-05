const path = require("path");

function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

const rootDir = path.resolve(__dirname, "../..");

const config = {
  rootDir,
  token: required("DISCORD_TOKEN"),
  clientId: required("DISCORD_CLIENT_ID"),
  guildId: process.env.DISCORD_GUILD_ID || "",
  nodeEnv: process.env.NODE_ENV || "development",
  logLevel: process.env.BOT_LOG_LEVEL || "info",
  dataDir: path.resolve(rootDir, process.env.DATA_DIR || "./data"),
  economyDbPath: path.resolve(rootDir, process.env.DATA_DIR || "./data", "economy", "economy.sqlite"),
  ownerRoleId: process.env.OWNER_ROLE_ID || "",
  leaderboardChannelId: process.env.COINS_LEADERBOARD_CHANNEL_ID || "",
  leaderboardThumbnailUrl: process.env.COINS_LEADERBOARD_THUMBNAIL_URL || "",
  leaderboardImageUrl: process.env.COINS_LEADERBOARD_IMAGE_URL || ""
};

module.exports = { config };
