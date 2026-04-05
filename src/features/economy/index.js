const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} = require("discord.js");
const { config } = require("../../core/config");
const {
  ensureOwnerAccess,
  logDiscordPayloadError,
  makeEmbed,
  reply,
  safeEmbedUrl
} = require("../../core/discord-helpers");
const {
  sharedPath,
  getCoinBalance,
  applyCoinDelta,
  setMemberHidden,
  getTopCoinBalances,
  setLeaderboardMessage,
  getLeaderboardMessage,
  clearLeaderboardMessage
} = require("../../core/shared-db");

const CHECK_BALANCE_BUTTON_ID = "coins:check-balance";
const REFRESH_BUTTON_ID = "coins:refresh-leaderboard";
const LEADERBOARD_LIMIT = 20;

function coinsDisplay(value) {
  return `${Number(value || 0).toLocaleString()} coin${Math.abs(Number(value || 0)) === 1 ? "" : "s"}`;
}

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
    return `${rankIcon} ${rankLabel} ${userLabel} 💰 ${balanceLabel}`;
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
      "Earn coins through participating in activities such as daily log ins, completing Closet Share tasks ect. Spend your coins in the Swag Shop to order custom items.",
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


function logLeaderboardPayloadError(stage, error, payload) {
  logDiscordPayloadError(`economy leaderboard ${stage}`, error, payload);
}

async function renderLeaderboardMessage(target) {
  const rows = getTopCoinBalances(target.guildId, LEADERBOARD_LIMIT);
  return {
    embeds: [buildLeaderboardEmbed(target.guild, rows)],
    components: buildLeaderboardComponents()
  };
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
      logLeaderboardPayloadError("edit", error, payload);
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

function createFeature() {
  const commands = [
    {
      data: new SlashCommandBuilder()
        .setName("coins")
        .setDescription("Check your current coin balance."),
      async execute(interaction) {
        const balance = getCoinBalance(interaction.guildId || "dm", interaction.user.id);
        return reply(interaction, {
          embeds: [
            makeEmbed({
              title: "Coin balance",
              description: `You currently have **${coinsDisplay(balance)}**.`
            })
          ],
          ephemeral: true
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName("coins-top")
        .setDescription("Preview the top 20 coin balances in this server."),
      async execute(interaction) {
        const rows = getTopCoinBalances(interaction.guildId || "dm", LEADERBOARD_LIMIT);
        return reply(interaction, {
          embeds: [buildLeaderboardEmbed(interaction.guild, rows)],
          ephemeral: false
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName("coins-add")
        .setDescription("Add coins to a member. Owner only.")
        .addUserOption((option) => option.setName("member").setDescription("Member to reward").setRequired(true))
        .addIntegerOption((option) =>
          option.setName("amount").setDescription("How many coins to add").setRequired(true).setMinValue(1)
        )
        .addStringOption((option) =>
          option.setName("reason").setDescription("Why they earned coins").setRequired(false)
        ),
      async execute(interaction, { client }) {
        const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
        if (denied) return denied;

        const member = interaction.options.getUser("member", true);
        const amount = interaction.options.getInteger("amount", true);
        const reason = interaction.options.getString("reason") || "Manual coin award";

        const result = applyCoinDelta({
          guildId: interaction.guildId || "dm",
          userId: member.id,
          amount,
          reason,
          createdBy: interaction.user.id,
          source: "manual_add"
        });

        await syncLeaderboardMessage({
          client,
          guildId: interaction.guildId,
          channelId: config.leaderboardChannelId,
          forcePost: false
        }).catch(() => null);

        return reply(interaction, {
          embeds: [
            makeEmbed({
              title: "Coins added",
              description: `${member} received **${coinsDisplay(amount)}** and now has **${coinsDisplay(result.balance)}**.`,
              fields: [{ name: "Reason", value: reason }]
            })
          ],
          ephemeral: true
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName("coins-deduct")
        .setDescription("Deduct coins from a member. Owner only.")
        .addUserOption((option) => option.setName("member").setDescription("Member to deduct from").setRequired(true))
        .addIntegerOption((option) =>
          option.setName("amount").setDescription("How many coins to deduct").setRequired(true).setMinValue(1)
        )
        .addStringOption((option) =>
          option.setName("reason").setDescription("Why coins were deducted").setRequired(false)
        ),
      async execute(interaction, { client }) {
        const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
        if (denied) return denied;

        const member = interaction.options.getUser("member", true);
        const amount = interaction.options.getInteger("amount", true);
        const reason = interaction.options.getString("reason") || "Manual coin deduction";

        try {
          const result = applyCoinDelta({
            guildId: interaction.guildId || "dm",
            userId: member.id,
            amount: -amount,
            reason,
            createdBy: interaction.user.id,
            source: "manual_deduct"
          });

          await syncLeaderboardMessage({
            client,
            guildId: interaction.guildId,
            channelId: config.leaderboardChannelId,
            forcePost: false
          }).catch(() => null);

          return reply(interaction, {
            embeds: [
              makeEmbed({
                title: "Coins deducted",
                description: `${member} lost **${coinsDisplay(amount)}** and now has **${coinsDisplay(result.balance)}**.`,
                fields: [{ name: "Reason", value: reason }]
              })
            ],
            ephemeral: true
          });
        } catch (error) {
          if (error?.code === "INSUFFICIENT_BALANCE") {
            return reply(interaction, {
              content: `${member} only has ${coinsDisplay(error.currentBalance)}. I will not let the balance go below 0.`,
              ephemeral: true
            });
          }
          throw error;
        }
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName("remove-member")
        .setDescription("Hide a member from the leaderboard. Owner only.")
        .addUserOption((option) =>
          option.setName("member").setDescription("Member to remove from the leaderboard").setRequired(true)
        )
        .addStringOption((option) =>
          option.setName("reason").setDescription("Why they are being removed").setRequired(false)
        ),
      async execute(interaction, { client }) {
        const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
        if (denied) return denied;

        const member = interaction.options.getUser("member", true);
        const reason = interaction.options.getString("reason") || "Removed from leaderboard by owner";
        setMemberHidden(interaction.guildId || "dm", member.id, true, reason, interaction.user.id);

        await syncLeaderboardMessage({
          client,
          guildId: interaction.guildId,
          channelId: config.leaderboardChannelId,
          forcePost: false
        }).catch(() => null);

        return reply(interaction, {
          embeds: [
            makeEmbed({
              title: "Member removed from leaderboard",
              description: `${member} has been hidden from the leaderboard. Their balance and transaction history are still stored.`,
              fields: [{ name: "Reason", value: reason }]
            })
          ],
          ephemeral: true
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName("post-leaderboard")
        .setDescription("Post or resync the main coin leaderboard embed. Owner only."),
      async execute(interaction, { client }) {
        const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
        if (denied) return denied;

        const result = await syncLeaderboardMessage({
          client,
          guildId: interaction.guildId,
          channelId: config.leaderboardChannelId,
          forcePost: false
        });

        return reply(interaction, {
          embeds: [
            makeEmbed({
              title: result.action === "posted" ? "Leaderboard posted" : "Leaderboard refreshed",
              description: `The main leaderboard message is now synced in <#${result.message.channelId}>.`
            })
          ],
          ephemeral: true
        });
      }
    }
  ];

  const buttons = [
    {
      customId: CHECK_BALANCE_BUTTON_ID,
      async execute(interaction) {
        const balance = getCoinBalance(interaction.guildId || "dm", interaction.user.id);
        return reply(interaction, {
          embeds: [
            makeEmbed({
              title: "Your coin balance",
              description: `You currently have **${coinsDisplay(balance)}**.`
            })
          ],
          ephemeral: true
        });
      }
    },
    {
      customId: REFRESH_BUTTON_ID,
      async execute(interaction, { client }) {
        const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
        if (denied) return denied;

        const result = await syncLeaderboardMessage({
          client,
          guildId: interaction.guildId,
          channelId: interaction.channelId || config.leaderboardChannelId,
          forcePost: false
        });

        return reply(interaction, {
          content: `Leaderboard ${result.action === "posted" ? "posted" : "refreshed"}.`,
          ephemeral: true
        });
      }
    }
  ];

  return {
    dbPath: sharedPath,
    commands,
    buttons,
    async onReady({ client }) {
      for (const guild of client.guilds.cache.values()) {
        const existing = getLeaderboardMessage(guild.id);
        if (!existing) continue;
        try {
          await syncLeaderboardMessage({
            client,
            guildId: guild.id,
            channelId: existing.channel_id,
            forcePost: false
          });
        } catch (error) {
          console.error(`[economy] Failed to sync leaderboard on ready for guild ${guild.id}:`, error.message);
        }
      }
    }
  };
}

module.exports = { createFeature };
