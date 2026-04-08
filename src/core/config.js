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
  csTaskChannelId: process.env.CS_TASK_CHANNEL_ID || "",
  leaderboardChannelId: process.env.COINS_LEADERBOARD_CHANNEL_ID || "",
  leaderboardThumbnailUrl: process.env.COINS_LEADERBOARD_THUMBNAIL_URL || "",
  leaderboardImageUrl: process.env.COINS_LEADERBOARD_IMAGE_URL || "",
  csTaskEmbedImageUrl: process.env.CS_TASK_EMBED_IMAGE_URL || "",
  spinWheelChannelId: process.env.SPIN_WHEEL_CHANNEL_ID || "",
  spinWheelStaticImageUrl: process.env.SPIN_WHEEL_STATIC_IMAGE_URL || "",
  spinWheelThumbnailUrl: process.env.SPIN_WHEEL_THUMBNAIL_URL || "",
  spinWheelResult1MediaUrl: process.env.SPIN_WHEEL_RESULT_1_MEDIA_URL || "",
  spinWheelResult2MediaUrl: process.env.SPIN_WHEEL_RESULT_2_MEDIA_URL || "",
  spinWheelResult3MediaUrl: process.env.SPIN_WHEEL_RESULT_3_MEDIA_URL || "",
  spinWheelResult4MediaUrl: process.env.SPIN_WHEEL_RESULT_4_MEDIA_URL || "",
  zoomFindChannelId: process.env.ZOOM_FIND_CHANNEL_ID || "",
  zoomFindImageUrl: process.env.ZOOM_FIND_IMAGE_URL || "",
  zoomFindThumbnailUrl: process.env.ZOOM_FIND_THUMBNAIL_URL || "",
  dailyLoginChannelId: process.env.DAILY_LOGIN_CHANNEL_ID || "",
  shiftVerifyChannelId: process.env.SHIFT_VERIFY_CHANNEL_ID || "",
  shiftTimezone: process.env.SHIFT_TIMEZONE || "UTC",
  shiftWindowsJson: process.env.SHIFT_WINDOWS_JSON || "[]",
  shiftAutopostEnabled: (process.env.SHIFT_AUTOPOST_ENABLED || "true").toLowerCase() !== "false",
  shiftAutopostLeadMinutes: process.env.SHIFT_AUTOPOST_LEAD_MINUTES || "15",
  shiftPayoutCoins: process.env.SHIFT_PAYOUT_COINS || "15",
  dailyLoginImageUrl: process.env.DAILY_LOGIN_IMAGE_URL || "",
  dailyLoginThumbnailUrl: process.env.DAILY_LOGIN_THUMBNAIL_URL || "",
  shiftStatsImageUrl: process.env.SHIFT_STATS_IMAGE_URL || ""
};

module.exports = { config };
