const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle
} = require("discord.js");
const { config } = require("../../core/config");
const { applyCoinDelta } = require("../../core/economy-db");
const { syncLeaderboardMessage } = require("../../core/economy-leaderboard");
const { ensureOwnerAccess, logDiscordPayloadError, makeEmbed, reply, safeEmbedUrl } = require("../../core/discord-helpers");

const ZOOM_FIND_REWARD = 50;
const ZOOM_FIND_GUESS_LIMIT = 10;
const ZOOM_FIND_TITLE = "🔎 Zoom-Find — Can You Guess What It Is?";
const ZOOM_FIND_DESCRIPTION = [
  "Owner posts a zoomed-in image that is hard to identify.",
  "",
  "**How it works:**",
  "• Click **Take a Guess** to submit your answer privately.",
  "• The embed shows only the **last 10 guesses**.",
  "• Owner clicks **Choose Winner** and awards **50 coins**.",
  "• Owner clicks **Clear Guesses** to reset the round."
].join("\n");

const TAKE_GUESS_PREFIX = "zoom-find:guess:";
const CHOOSE_WINNER_PREFIX = "zoom-find:choose:";
const CLEAR_GUESSES_PREFIX = "zoom-find:clear:";
const GUESS_MODAL_PREFIX = "zoom-find:guess-modal:";
const WINNER_SELECT_PREFIX = "zoom-find:winner:";

function parseRoundId(customId, prefix) {
  if (!customId.startsWith(prefix)) return null;
  const value = Number(customId.slice(prefix.length));
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function sanitizeGuess(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

function formatRecentGuesses(guesses) {
  if (!guesses.length) return "No guesses yet.";

  return guesses
    .map((guess, index) => {
      const cleanedGuess = guess.guess_text.replace(/[`\n\r]/g, " ");
      const truncated = cleanedGuess.length > 80 ? `${cleanedGuess.slice(0, 79)}…` : cleanedGuess;
      return `${index + 1}. <@${guess.user_id}> — ${truncated}`;
    })
    .join("\n");
}

function buildZoomFindEmbed(round, guesses) {
  const embed = makeEmbed({
    title: round.title || "Zoom Find",
    description:
      round.description ||
      [
        "Post a zoomed-in image and let members guess what it is.",
        "• **Take a Guess**: submit your guess privately.",
        "• **Choose Winner**: owner picks the correct guesser and awards 50 coins.",
        "• **Clear Guesses**: owner clears all guesses from this round."
      ].join("\n")
  });

  const imageUrl = safeEmbedUrl(round.image_url);
  if (imageUrl) embed.setImage(imageUrl);

  const thumbnailUrl = safeEmbedUrl(round.thumbnail_url);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);

  embed.addFields({ name: `Recent guesses (last ${ZOOM_FIND_GUESS_LIMIT})`, value: formatRecentGuesses(guesses) });

  if (round.winner_user_id) {
    embed.addFields({
      name: "Winner",
      value: `<@${round.winner_user_id}> won **${ZOOM_FIND_REWARD} coins** for this round.`
    });
  }

  embed.setFooter({ text: `Round #${round.id}` });
  return embed;
}

function buildRoundButtons(roundId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${TAKE_GUESS_PREFIX}${roundId}`).setLabel("Take a Guess").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${CHOOSE_WINNER_PREFIX}${roundId}`).setLabel("Choose Winner").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${CLEAR_GUESSES_PREFIX}${roundId}`).setLabel("Clear Guesses").setStyle(ButtonStyle.Secondary)
    )
  ];
}

function createFeature({ featureSlug, createFeatureDb }) {
  const { db, dbPath } = createFeatureDb(featureSlug, "zoomfind.sqlite");

  db.exec(`
    CREATE TABLE IF NOT EXISTS zoom_find_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL UNIQUE,
      owner_user_id TEXT NOT NULL,
      title TEXT,
      description TEXT,
      image_url TEXT NOT NULL,
      thumbnail_url TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      winner_user_id TEXT,
      winner_awarded_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS zoom_find_guesses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      round_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      username TEXT,
      guess_text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (round_id) REFERENCES zoom_find_rounds(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_zoom_find_guesses_round_created
      ON zoom_find_guesses(round_id, created_at DESC, id DESC);
  `);

  const insertRoundStmt = db.prepare(`
    INSERT INTO zoom_find_rounds (
      guild_id, channel_id, message_id, owner_user_id, title, description, image_url, thumbnail_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getRoundByIdStmt = db.prepare(`
    SELECT id, guild_id, channel_id, message_id, owner_user_id, title, description, image_url, thumbnail_url,
           status, winner_user_id, winner_awarded_at, created_at, updated_at
    FROM zoom_find_rounds
    WHERE id = ?
  `);

  const updateRoundMessageStmt = db.prepare(`
    UPDATE zoom_find_rounds
    SET message_id = ?, channel_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const insertGuessStmt = db.prepare(`
    INSERT INTO zoom_find_guesses (round_id, guild_id, user_id, username, guess_text)
    VALUES (?, ?, ?, ?, ?)
  `);

  const getRecentGuessesStmt = db.prepare(`
    SELECT id, round_id, guild_id, user_id, username, guess_text, created_at
    FROM zoom_find_guesses
    WHERE round_id = ?
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  const getWinnerOptionsStmt = db.prepare(`
    SELECT user_id,
           COALESCE(MAX(NULLIF(username, '')), user_id) AS username,
           MAX(created_at) AS latest_guess_at
    FROM zoom_find_guesses
    WHERE round_id = ?
    GROUP BY user_id
    ORDER BY latest_guess_at DESC
    LIMIT 25
  `);

  const clearGuessesStmt = db.prepare(`DELETE FROM zoom_find_guesses WHERE round_id = ?`);

  const setWinnerStmt = db.prepare(`
    UPDATE zoom_find_rounds
    SET winner_user_id = ?,
        winner_awarded_at = datetime('now'),
        status = 'completed',
        updated_at = datetime('now')
    WHERE id = ?
  `);

  function getRecentGuesses(roundId) {
    return getRecentGuessesStmt.all(roundId, ZOOM_FIND_GUESS_LIMIT).reverse();
  }

  async function updateRoundMessage(client, roundId) {
    const round = getRoundByIdStmt.get(roundId);
    if (!round) return;

    const channel = await client.channels.fetch(round.channel_id).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const message = await channel.messages.fetch(round.message_id).catch(() => null);
    if (!message) return;

    const guesses = getRecentGuesses(roundId);
    const payload = {
      embeds: [buildZoomFindEmbed(round, guesses)],
      components: buildRoundButtons(roundId)
    };

    try {
      await message.edit(payload);
    } catch (error) {
      logDiscordPayloadError(`zoom-find:message-edit:round-${roundId}`, error, payload);
      throw error;
    }
  }

  return {
    db,
    dbPath,
    commands: [
      {
        data: new SlashCommandBuilder()
          .setName("post-zoom")
          .setDescription("Post the Zoom Find embed with guessing buttons. Owner only."),
        async execute(interaction, { client }) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const imageUrl = safeEmbedUrl(config.zoomFindImageUrl);
          const thumbnailUrl = safeEmbedUrl(config.zoomFindThumbnailUrl);

          if (!imageUrl || !thumbnailUrl) {
            return reply(interaction, {
              content:
                "Zoom Find image URLs are not configured. Set valid ZOOM_FIND_IMAGE_URL and ZOOM_FIND_THUMBNAIL_URL in .env.",
              ephemeral: true
            });
          }

          const targetChannelId = config.zoomFindChannelId || interaction.channelId;
          const targetChannel = await client.channels.fetch(targetChannelId).catch(() => null);
          if (!targetChannel || !targetChannel.isTextBased()) {
            return reply(interaction, {
              content: "I couldn't find the configured Zoom Find channel to post in.",
              ephemeral: true
            });
          }

          const placeholder = {
            id: 0,
            title: ZOOM_FIND_TITLE,
            description: ZOOM_FIND_DESCRIPTION,
            image_url: imageUrl,
            thumbnail_url: thumbnailUrl,
            winner_user_id: null
          };

          const payload = {
            embeds: [buildZoomFindEmbed(placeholder, [])],
            components: buildRoundButtons(0)
          };

          let message;
          try {
            message = await targetChannel.send(payload);
          } catch (error) {
            logDiscordPayloadError("zoom-find:initial-post", error, payload);
            throw error;
          }

          const result = insertRoundStmt.run(
            interaction.guildId || "dm",
            message.channelId,
            message.id,
            interaction.user.id,
            ZOOM_FIND_TITLE,
            ZOOM_FIND_DESCRIPTION,
            imageUrl,
            thumbnailUrl
          );

          const roundId = Number(result.lastInsertRowid);
          updateRoundMessageStmt.run(message.id, message.channelId, roundId);
          await message.edit({
            embeds: [buildZoomFindEmbed({ ...placeholder, id: roundId }, [])],
            components: buildRoundButtons(roundId)
          });

          return reply(interaction, {
            content: `Zoom Find posted in <#${message.channelId}> as Round #${roundId}.`,
            ephemeral: true
          });
        }
      }
    ],
    buttons: [
      {
        customId: /^zoom-find:guess:\d+$/,
        async execute(interaction) {
          const roundId = parseRoundId(interaction.customId, TAKE_GUESS_PREFIX);
          if (!roundId) return;

          const round = getRoundByIdStmt.get(roundId);
          if (!round || round.status !== "active") {
            return reply(interaction, {
              content: "This Zoom Find round is no longer active.",
              ephemeral: true
            });
          }

          const modal = new ModalBuilder().setCustomId(`${GUESS_MODAL_PREFIX}${roundId}`).setTitle(`Zoom Find #${roundId}`);
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("guess")
                .setLabel("What is your guess?")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(120)
                .setPlaceholder("Type your best guess")
            )
          );

          return interaction.showModal(modal);
        }
      },
      {
        customId: /^zoom-find:choose:\d+$/,
        async execute(interaction) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const roundId = parseRoundId(interaction.customId, CHOOSE_WINNER_PREFIX);
          if (!roundId) return;

          const round = getRoundByIdStmt.get(roundId);
          if (!round) {
            return reply(interaction, { content: "Zoom Find round not found.", ephemeral: true });
          }

          if (round.winner_user_id) {
            return reply(interaction, {
              content: `A winner is already set for this round: <@${round.winner_user_id}>.`,
              ephemeral: true
            });
          }

          const options = getWinnerOptionsStmt.all(roundId);
          if (!options.length) {
            return reply(interaction, {
              content: "No guesses yet. Wait for members to submit guesses first.",
              ephemeral: true
            });
          }

          const menu = new StringSelectMenuBuilder()
            .setCustomId(`${WINNER_SELECT_PREFIX}${roundId}`)
            .setPlaceholder("Select the winning member")
            .addOptions(
              options.map((option) => ({
                label: String(option.username || option.user_id).slice(0, 100),
                value: option.user_id,
                description: `User ID: ${option.user_id}`.slice(0, 100)
              }))
            );

          return reply(interaction, {
            content: "Pick the winner for this Zoom Find round.",
            components: [new ActionRowBuilder().addComponents(menu)],
            ephemeral: true
          });
        }
      },
      {
        customId: /^zoom-find:clear:\d+$/,
        async execute(interaction, { client }) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const roundId = parseRoundId(interaction.customId, CLEAR_GUESSES_PREFIX);
          if (!roundId) return;

          const round = getRoundByIdStmt.get(roundId);
          if (!round) {
            return reply(interaction, { content: "Zoom Find round not found.", ephemeral: true });
          }

          clearGuessesStmt.run(roundId);
          await updateRoundMessage(client, roundId);

          return reply(interaction, {
            content: `Cleared all guesses for Round #${roundId}.`,
            ephemeral: true
          });
        }
      }
    ],
    selectMenus: [
      {
        customId: /^zoom-find:winner:\d+$/,
        async execute(interaction, { client }) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const roundId = parseRoundId(interaction.customId, WINNER_SELECT_PREFIX);
          if (!roundId) return;

          const round = getRoundByIdStmt.get(roundId);
          if (!round) {
            return reply(interaction, { content: "Zoom Find round not found.", ephemeral: true });
          }

          if (round.winner_user_id) {
            return reply(interaction, {
              content: `A winner is already set for this round: <@${round.winner_user_id}>.`,
              ephemeral: true
            });
          }

          const winnerUserId = interaction.values[0];
          if (!winnerUserId) {
            return reply(interaction, {
              content: "No winner selected.",
              ephemeral: true
            });
          }

          applyCoinDelta({
            guildId: interaction.guildId || "dm",
            userId: winnerUserId,
            amount: ZOOM_FIND_REWARD,
            reason: `Zoom Find Round #${roundId} winner`,
            createdBy: interaction.user.id,
            source: "zoom_find"
          });

          setWinnerStmt.run(winnerUserId, roundId);
          await updateRoundMessage(client, roundId);

          await syncLeaderboardMessage({
            client,
            guildId: interaction.guildId,
            channelId: config.leaderboardChannelId,
            forcePost: false
          }).catch(() => null);

          return reply(interaction, {
            content: `<@${winnerUserId}> awarded **${ZOOM_FIND_REWARD} coins** for Round #${roundId}.`,
            ephemeral: true
          });
        }
      }
    ],
    modals: [
      {
        customId: /^zoom-find:guess-modal:\d+$/,
        async execute(interaction, { client }) {
          const roundId = parseRoundId(interaction.customId, GUESS_MODAL_PREFIX);
          if (!roundId) return;

          const round = getRoundByIdStmt.get(roundId);
          if (!round || round.status !== "active") {
            return reply(interaction, {
              content: "This Zoom Find round is no longer active.",
              ephemeral: true
            });
          }

          const guessText = sanitizeGuess(interaction.fields.getTextInputValue("guess"));
          if (!guessText) {
            return reply(interaction, {
              content: "Please submit a guess with at least one visible character.",
              ephemeral: true
            });
          }

          insertGuessStmt.run(roundId, interaction.guildId || "dm", interaction.user.id, interaction.user.username, guessText);

          await updateRoundMessage(client, roundId);

          return reply(interaction, {
            content: `Your guess has been submitted for Round #${roundId}.`,
            ephemeral: true
          });
        }
      }
    ]
  };
}

module.exports = { createFeature };
