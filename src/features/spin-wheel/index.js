const { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, SlashCommandBuilder } = require("discord.js");
const { config } = require("../../core/config");
const { makeEmbed, reply, safeEmbedUrl, ensureOwnerAccess, memberHasRoleId } = require("../../core/discord-helpers");
const { applyCoinDelta, getCoinBalance } = require("../../core/economy-db");
const { syncLeaderboardMessage } = require("../../core/economy-leaderboard");

const SPIN_WHEEL_BUTTON_ID = "spin_wheel_spin";
const SPIN_COOLDOWN_MS = 24 * 60 * 60 * 1000;

const SPIN_OUTCOMES = [
  { reward: 50, weight: 12, mediaUrl: config.spinWheelResult3MediaUrl },
  { reward: 25, weight: 28, mediaUrl: config.spinWheelResult2MediaUrl },
  { reward: 5, weight: 55, mediaUrl: config.spinWheelResult1MediaUrl },
  { reward: -10, weight: 5, mediaUrl: config.spinWheelResult4MediaUrl }
];

function rewardText(amount) {
  return amount >= 0 ? `+${amount} coins` : `${amount} coins`;
}

function createFeature({ featureSlug, createFeatureDb }) {
  const { db, dbPath } = createFeatureDb(featureSlug, "spinwheel.sqlite");

  db.exec(`
    CREATE TABLE IF NOT EXISTS spins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      reward INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const insertSpinStmt = db.prepare(`
    INSERT INTO spins (guild_id, user_id, reward)
    VALUES (?, ?, ?)
  `);

  const lastSpinStmt = db.prepare(`
    SELECT created_at
    FROM spins
    WHERE guild_id = ? AND user_id = ?
    ORDER BY id DESC
    LIMIT 1
  `);

  function getRandomOutcome() {
    const roll = Math.random() * 100;
    let cumulative = 0;

    for (const outcome of SPIN_OUTCOMES) {
      cumulative += outcome.weight;
      if (roll < cumulative) return outcome;
    }

    return SPIN_OUTCOMES[SPIN_OUTCOMES.length - 1];
  }

  function getRemainingCooldownMs(guildId, userId) {
    const row = lastSpinStmt.get(guildId, userId);
    if (!row?.created_at) return 0;

    const lastSpinAtMs = Date.parse(`${row.created_at}Z`);
    if (Number.isNaN(lastSpinAtMs)) return 0;

    const elapsed = Date.now() - lastSpinAtMs;
    return elapsed >= SPIN_COOLDOWN_MS ? 0 : SPIN_COOLDOWN_MS - elapsed;
  }

  function formatRemainingTime(ms) {
    const totalMinutes = Math.ceil(ms / 60000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours <= 0) return `${minutes}m`;
    if (minutes === 0) return `${hours}h`;
    return `${hours}h ${minutes}m`;
  }

  function buildWheelEmbed() {
    const embed = makeEmbed({
      title: "Spin the Wheel",
      description: "Click **Spin the Wheel** below to spin once every 24 hours and win (or lose) coins."
    });

    const imageUrl = safeEmbedUrl(config.spinWheelStaticImageUrl);
    if (imageUrl) {
      embed.setImage(imageUrl);
    }

    const thumbnailUrl = safeEmbedUrl(config.spinWheelThumbnailUrl);
    if (thumbnailUrl) {
      embed.setThumbnail(thumbnailUrl);
    }

    return embed;
  }

  async function buildResultPayload({ outcome, appliedAmount, balanceAfter, mediaUrl }) {
    const fields = [
      { name: "Wheel landed on", value: `**${rewardText(outcome.reward)}**`, inline: true },
      { name: "Applied", value: `**${rewardText(appliedAmount)}**`, inline: true },
      { name: "New balance", value: `**${balanceAfter}** coins`, inline: true }
    ];

    if (outcome.reward < 0 && appliedAmount !== outcome.reward) {
      fields.push({
        name: "Note",
        value: "You cannot go below 0 coins, so only your available balance was deducted."
      });
    }

    const embed = makeEmbed({
      title: "Spin result",
      description: appliedAmount >= 0 ? "Nice spin!" : "Tough spin — better luck on the next one.",
      fields,
      footer: "You can spin again in 24 hours."
    });

    const payload = {
      embeds: [embed],
      ephemeral: true
    };

    if (!mediaUrl) {
      return payload;
    }

    if (/\.(gif|png|jpe?g|webp)$/i.test(mediaUrl)) {
      embed.setImage(mediaUrl);
      return payload;
    }

    try {
      const response = await fetch(mediaUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      if (!contentType.startsWith("video/")) {
        return payload;
      }

      const extension = contentType.includes("mp4") ? "mp4" : contentType.includes("webm") ? "webm" : "mov";
      const mediaBuffer = Buffer.from(await response.arrayBuffer());
      payload.files = [new AttachmentBuilder(mediaBuffer, { name: `spin-result.${extension}` })];
      return payload;
    } catch {
      return payload;
    }
  }

  return {
    db,
    dbPath,
    commands: [
      {
        data: new SlashCommandBuilder()
          .setName("post-wheel")
          .setDescription("Post the spin wheel embed with a Spin the Wheel button."),
        async execute(interaction, { client }) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const targetChannelId = config.spinWheelChannelId || interaction.channelId;
          const channel = await client.channels.fetch(targetChannelId);
          if (!channel || !channel.isTextBased()) {
            return reply(interaction, {
              content: "I couldn't find a text channel to post the wheel embed.",
              ephemeral: true
            });
          }

          await channel.send({
            embeds: [buildWheelEmbed()],
            components: [
              new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(SPIN_WHEEL_BUTTON_ID).setLabel("Spin the Wheel").setStyle(ButtonStyle.Primary)
              )
            ]
          });

          return reply(interaction, {
            content: `Spin wheel posted in <#${channel.id}>.`,
            ephemeral: true
          });
        }
      }
    ],
    buttons: [
      {
        customId: SPIN_WHEEL_BUTTON_ID,
        async execute(interaction, { client }) {
          const guildId = interaction.guildId || "dm";
          const userId = interaction.user.id;

          const isOwner = memberHasRoleId(interaction, config.ownerRoleId);
          const remainingMs = isOwner ? 0 : getRemainingCooldownMs(guildId, userId);
          if (remainingMs > 0) {
            return reply(interaction, {
              content: `You already spun recently. Try again in **${formatRemainingTime(remainingMs)}**.`,
              ephemeral: true
            });
          }

          const outcome = getRandomOutcome();
          const currentBalance = getCoinBalance(guildId, userId);
          const appliedAmount = outcome.reward < 0 ? -Math.min(Math.abs(outcome.reward), currentBalance) : outcome.reward;

          const result =
            appliedAmount === 0
              ? { balance: currentBalance }
              : applyCoinDelta({
                  guildId,
                  userId,
                  amount: appliedAmount,
                  reason: "Spin wheel reward",
                  createdBy: userId,
                  source: "spin_wheel"
                });

          insertSpinStmt.run(guildId, userId, outcome.reward);

          await syncLeaderboardMessage({
            client,
            guildId: interaction.guildId,
            channelId: config.leaderboardChannelId,
            forcePost: false
          }).catch(() => null);

          return reply(
            interaction,
            await buildResultPayload({
              outcome,
              appliedAmount,
              balanceAfter: result.balance,
              mediaUrl: safeEmbedUrl(outcome.mediaUrl)
            })
          );
        }
      }
    ]
  };
}

module.exports = { createFeature };
