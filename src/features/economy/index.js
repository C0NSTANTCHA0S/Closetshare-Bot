const { SlashCommandBuilder } = require("discord.js");
const { config } = require("../../core/config");
const { ensureOwnerAccess, makeEmbed, reply } = require("../../core/discord-helpers");
const { economyPath, getCoinBalance, applyCoinDelta, setMemberHidden, getLeaderboardMessage, getTopCoinBalances } =
  require("../../core/economy-db");
const {
  CHECK_BALANCE_BUTTON_ID,
  REFRESH_BUTTON_ID,
  LEADERBOARD_LIMIT,
  buildLeaderboardEmbed,
  syncLeaderboardMessage
} = require("../../core/economy-leaderboard");

function coinsDisplay(value) {
  return `${Number(value || 0).toLocaleString()} coin${Math.abs(Number(value || 0)) === 1 ? "" : "s"}`;
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
    dbPath: economyPath,
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
