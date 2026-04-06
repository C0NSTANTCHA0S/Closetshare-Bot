const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require("discord.js");
const { config } = require("./config");
const { makeEmbed, safeEmbedUrl, logDiscordPayloadError } = require("./discord-helpers");
const {
  getTopCoinBalances,
  setLeaderboardMessage,
  getLeaderboardMessage,
  clearLeaderboardMessage
} = require("./economy-db");

const CHECK_BALANCE_BUTTON_ID = "coins:check-balance";
const REFRESH_BUTTON_ID = "coins:refresh-leaderboard";
const LEADERBOARD_LIMIT = 20;

function buildLeaderboardDescription(rows) {
  if (!rows.length) {
    return [
      "🔥TOP VOLUNTEER EARNERS🔥",
      "",
      "No members have coins yet.",
      "",
      "Use `/coins-add` to award the first coins and then refresh the board."
    ].join("\n");
  }

  const lines = rows.map((row, index) => {
    const rankIcon = index === 0 ? "🏆" : index === 1 ? "🥈" : index === 2 ? "🥉" : `${index + 1}️⃣`;
    const rankLabel = `#${index + 1}`;
    const userLabel = `<@${row.user_id}>`;
    const balanceLabel = `${Number(row.balance).toLocaleString()} coins`;
    return `${rankIcon} ${rankLabel} ${userLabel} 🪙 ${balanceLabel}`;
  });

  return ["🔥TOP VOLUNTEER EARNERS🔥", "", ...lines].join("\n");
}

function buildLeaderboardEmbed(guild, rows) {
  const embed = makeEmbed({
    title: "Closet Share Coin Leaderboard",
    description: buildLeaderboardDescription(rows),
    footer: `Top ${LEADERBOARD_LIMIT} members`
  });

  const thumbnailUrl = safeEmbedUrl(config.leaderboardThumbnailUrl);
  const imageUrl = safeEmbedUrl(config.leaderboardImageUrl);

  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (imageUrl) embed.setImage(imageUrl);

  embed.addFields({
    name: "🔧How it Works🔧",
    value:
      "Earn coins through participating in activities such as daily log ins, completing Closet Share tasks ect. Spend your coins in the Swag Shop to order custom items. Use Check Balance to see your coin balance.",
    inline: false
  });

  return embed;
}

function buildLeaderboardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CHECK_BALANCE_BUTTON_ID)
        .setLabel("Check Balance")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(REFRESH_BUTTON_ID)
        .setLabel("Refresh")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

async function renderLeaderboardMessage({ guildId, guild }) {
  const rows = getTopCoinBalances(guildId, LEADERBOARD_LIMIT);
  return {
    embeds: [buildLeaderboardEmbed(guild, rows)],
    components: buildLeaderboardComponents()
  };
}

function logLeaderboardPayloadError(stage, error, payload) {
  logDiscordPayloadError(`economy leaderboard ${stage}`, error, payload);
}

function isUnknownMessageError(error) {
  return error?.code === 10008 || error?.rawError?.code === 10008;
}

async function syncLeaderboardMessage({ client, guildId, channelId, forcePost = false }) {
  const guild = client.guilds.cache.get(guildId) || (await client.guilds.fetch(guildId));
  const targetChannelId = channelId || config.leaderboardChannelId;

  if (!targetChannelId) {
    throw new Error("Missing COINS_LEADERBOARD_CHANNEL_ID environment variable.");
  }

  const channel = guild.channels.cache.get(targetChannelId) || (await guild.channels.fetch(targetChannelId));
  if (!channel || typeof channel.send !== "function") {
    throw new Error("Configured leaderboard channel is not a text channel I can post in.");
  }

  const payload = await renderLeaderboardMessage({ guildId, guild });
  const existing = getLeaderboardMessage(guildId);

  if (!forcePost && existing && existing.channel_id === targetChannelId) {
    try {
      const message = await channel.messages.fetch(existing.message_id);
      await message.edit(payload);
      setLeaderboardMessage(guildId, channel.id, message.id);
      return { action: "updated", message };
    } catch (error) {
      if (isUnknownMessageError(error)) {
        console.warn(
          `[economy] Clearing stale leaderboard message reference for guild ${guildId} (channel ${existing.channel_id}, message ${existing.message_id}).`
        );
      } else {
        logLeaderboardPayloadError("edit", error, payload);
      }
      clearLeaderboardMessage(guildId);
    }
  }

  try {
    const posted = await channel.send(payload);
    setLeaderboardMessage(guildId, channel.id, posted.id);
    return { action: "posted", message: posted };
  } catch (error) {
    logLeaderboardPayloadError("send", error, payload);
    throw error;
  }
}

module.exports = {
  CHECK_BALANCE_BUTTON_ID,
  REFRESH_BUTTON_ID,
  LEADERBOARD_LIMIT,
  buildLeaderboardEmbed,
  syncLeaderboardMessage
};
