const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  SlashCommandBuilder,
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
  "• Owner clicks **Item Name** to set the correct answer for this round.",
  "• The embed shows only the **last 10 guesses**.",
  "• First member to guess correctly wins **50 coins** automatically.",
  "• Owner can use **Reset Round** or **Cancel Round** anytime."
].join("\n");

const TAKE_GUESS_PREFIX = "zoom-find:guess:";
const ITEM_NAME_PREFIX = "zoom-find:item:";
const RESET_ROUND_PREFIX = "zoom-find:reset:";
const CANCEL_ROUND_PREFIX = "zoom-find:cancel:";
const GUESS_MODAL_PREFIX = "zoom-find:guess-modal:";
const ITEM_NAME_MODAL_PREFIX = "zoom-find:item-modal:";

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

function sanitizeHint(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

function normalizeGuess(value) {
  return sanitizeGuess(value).toLowerCase();
}

function statusColor(status) {
  if (status === "completed") return 0x37be73;
  if (status === "cancelled") return 0xd64545;
  return 0x8f5bff;
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
    color: statusColor(round.status),
    description:
      round.description ||
      [
        "Post a zoomed-in image and let members guess what it is.",
        "• **Take a Guess**: submit your guess privately.",
        "• **Item Name**: owner sets the correct answer.",
        "• First correct guess wins 50 coins automatically.",
        "• **Reset Round** or **Cancel Round** are owner-only controls."
      ].join("\n")
  });

  const imageUrl = safeEmbedUrl(round.image_url);
  if (imageUrl) embed.setImage(imageUrl);

  const thumbnailUrl = safeEmbedUrl(round.thumbnail_url);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);

  embed.addFields({ name: `Recent guesses (last ${ZOOM_FIND_GUESS_LIMIT})`, value: formatRecentGuesses(guesses) });

  const statusLabel =
    round.status === "completed" ? "✅ Completed" : round.status === "cancelled" ? "⛔ Cancelled" : "🟣 Active";
  embed.addFields({ name: "Status", value: statusLabel, inline: true });
  embed.addFields({ name: "Answer Set", value: round.item_name ? "Yes" : "No", inline: true });

  if (round.hint_text) {
    embed.addFields({ name: "Hint", value: round.hint_text });
  }

  if (round.winner_user_id) {
    embed.addFields({
      name: "Winner",
      value: `<@${round.winner_user_id}> won **${ZOOM_FIND_REWARD} coins** for this round.`
    });
  }

  if (round.status === "completed" && round.item_name) {
    embed.addFields({ name: "Item Name", value: round.item_name });
  }

  if (round.status === "cancelled") {
    embed.addFields({ name: "Round State", value: "This round was cancelled by the owner." });
  }

  embed.setFooter({ text: `Round #${round.id}` });
  return embed;
}

function buildRoundButtons(roundId) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`${TAKE_GUESS_PREFIX}${roundId}`).setLabel("Take a Guess").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(`${ITEM_NAME_PREFIX}${roundId}`).setLabel("Item Name").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(`${RESET_ROUND_PREFIX}${roundId}`).setLabel("Reset Round").setStyle(ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId(`${CANCEL_ROUND_PREFIX}${roundId}`).setLabel("Cancel Round").setStyle(ButtonStyle.Danger)
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
      item_name TEXT,
      hint_text TEXT,
      item_set_at TEXT,
      winner_user_id TEXT,
      winner_awarded_at TEXT,
      cancelled_at TEXT,
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

  const roundColumns = new Set(db.prepare(`PRAGMA table_info(zoom_find_rounds)`).all().map((column) => column.name));
  if (!roundColumns.has("item_name")) db.exec(`ALTER TABLE zoom_find_rounds ADD COLUMN item_name TEXT`);
  if (!roundColumns.has("hint_text")) db.exec(`ALTER TABLE zoom_find_rounds ADD COLUMN hint_text TEXT`);
  if (!roundColumns.has("item_set_at")) db.exec(`ALTER TABLE zoom_find_rounds ADD COLUMN item_set_at TEXT`);
  if (!roundColumns.has("cancelled_at")) db.exec(`ALTER TABLE zoom_find_rounds ADD COLUMN cancelled_at TEXT`);

  const insertRoundStmt = db.prepare(`
    INSERT INTO zoom_find_rounds (
      guild_id, channel_id, message_id, owner_user_id, title, description, image_url, thumbnail_url
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const getRoundByIdStmt = db.prepare(`
    SELECT id, guild_id, channel_id, message_id, owner_user_id, title, description, image_url, thumbnail_url,
           status, item_name, hint_text, item_set_at, winner_user_id, winner_awarded_at, cancelled_at, created_at, updated_at
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

  const clearGuessesStmt = db.prepare(`DELETE FROM zoom_find_guesses WHERE round_id = ?`);

  const setWinnerStmt = db.prepare(`
    UPDATE zoom_find_rounds
    SET winner_user_id = ?,
        winner_awarded_at = datetime('now'),
        status = 'completed',
        updated_at = datetime('now')
    WHERE id = ? AND status = 'active' AND winner_user_id IS NULL
  `);

  const setItemNameStmt = db.prepare(`
    UPDATE zoom_find_rounds
    SET item_name = ?,
        hint_text = ?,
        item_set_at = datetime('now'),
        status = 'active',
        cancelled_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const resetRoundStateStmt = db.prepare(`
    UPDATE zoom_find_rounds
    SET item_name = NULL,
        hint_text = NULL,
        item_set_at = NULL,
        winner_user_id = NULL,
        winner_awarded_at = NULL,
        cancelled_at = NULL,
        status = 'active',
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const cancelRoundStateStmt = db.prepare(`
    UPDATE zoom_find_rounds
    SET item_name = NULL,
        hint_text = NULL,
        item_set_at = NULL,
        winner_user_id = NULL,
        winner_awarded_at = NULL,
        cancelled_at = datetime('now'),
        status = 'cancelled',
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
            status: "active",
            item_name: null,
            hint_text: null,
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
        customId: /^zoom-find:item:\d+$/,
        async execute(interaction) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const roundId = parseRoundId(interaction.customId, ITEM_NAME_PREFIX);
          if (!roundId) return;

          const round = getRoundByIdStmt.get(roundId);
          if (!round) {
            return reply(interaction, { content: "Zoom Find round not found.", ephemeral: true });
          }

          const modal = new ModalBuilder().setCustomId(`${ITEM_NAME_MODAL_PREFIX}${roundId}`).setTitle(`Set Item Name #${roundId}`);
          modal.addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("item_name")
                .setLabel("What is the item name?")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
                .setMaxLength(120)
                .setPlaceholder("Example: Purple knitted sweater")
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("hint_text")
                .setLabel("Hint (optional)")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(false)
                .setMaxLength(240)
                .setPlaceholder("Example: You wear this in winter")
            )
          );

          return interaction.showModal(modal);
        }
      },
      {
        customId: /^zoom-find:reset:\d+$/,
        async execute(interaction, { client }) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const roundId = parseRoundId(interaction.customId, RESET_ROUND_PREFIX);
          if (!roundId) return;

          const round = getRoundByIdStmt.get(roundId);
          if (!round) {
            return reply(interaction, { content: "Zoom Find round not found.", ephemeral: true });
          }

          clearGuessesStmt.run(roundId);
          resetRoundStateStmt.run(roundId);
          await updateRoundMessage(client, roundId);

          return reply(interaction, {
            content: `Round #${roundId} has been reset.`,
            ephemeral: true
          });
        }
      },
      {
        customId: /^zoom-find:cancel:\d+$/,
        async execute(interaction, { client }) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const roundId = parseRoundId(interaction.customId, CANCEL_ROUND_PREFIX);
          if (!roundId) return;

          const round = getRoundByIdStmt.get(roundId);
          if (!round) {
            return reply(interaction, { content: "Zoom Find round not found.", ephemeral: true });
          }

          clearGuessesStmt.run(roundId);
          cancelRoundStateStmt.run(roundId);
          await updateRoundMessage(client, roundId);

          return reply(interaction, {
            content: `Round #${roundId} has been cancelled and reset.`,
            ephemeral: true
          });
        }
      }
    ],
    modals: [
      {
        customId: /^zoom-find:item-modal:\d+$/,
        async execute(interaction, { client }) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const roundId = parseRoundId(interaction.customId, ITEM_NAME_MODAL_PREFIX);
          if (!roundId) return;

          const round = getRoundByIdStmt.get(roundId);
          if (!round) {
            return reply(interaction, {
              content: "Zoom Find round not found.",
              ephemeral: true
            });
          }

          const itemName = sanitizeGuess(interaction.fields.getTextInputValue("item_name"));
          if (!itemName) {
            return reply(interaction, {
              content: "Please enter a valid item name.",
              ephemeral: true
            });
          }

          const hintText = sanitizeHint(interaction.fields.getTextInputValue("hint_text"));
          setItemNameStmt.run(itemName, hintText || null, roundId);
          await updateRoundMessage(client, roundId);

          return reply(interaction, {
            content: `Item name set for Round #${roundId}.`,
            ephemeral: true
          });
        }
      },
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
          const latestRound = getRoundByIdStmt.get(roundId);

          if (latestRound?.status === "active" && latestRound?.item_name && !latestRound?.winner_user_id) {
            const isCorrect = normalizeGuess(guessText) === normalizeGuess(latestRound.item_name);
            if (isCorrect) {
              const updateResult = setWinnerStmt.run(interaction.user.id, roundId);
              if (updateResult.changes > 0) {
                applyCoinDelta({
                  guildId: interaction.guildId || "dm",
                  userId: interaction.user.id,
                  amount: ZOOM_FIND_REWARD,
                  reason: `Zoom Find Round #${roundId} winner`,
                  createdBy: latestRound.owner_user_id || interaction.user.id,
                  source: "zoom_find"
                });

                await syncLeaderboardMessage({
                  client,
                  guildId: interaction.guildId,
                  channelId: config.leaderboardChannelId,
                  forcePost: false
                }).catch(() => null);

                await updateRoundMessage(client, roundId);

                return reply(interaction, {
                  content: `Correct! You guessed the item and earned **${ZOOM_FIND_REWARD} coins**.`,
                  ephemeral: true
                });
              }
            }
          }

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
