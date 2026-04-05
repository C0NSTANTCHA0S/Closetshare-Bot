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
const { ensureOwnerAccess, makeEmbed, reply, safeEmbedUrl } = require("../../core/discord-helpers");
const { applyCoinDelta } = require("../../core/economy-db");
const { syncLeaderboardMessage } = require("../../core/economy-leaderboard");

const TASK_ACCEPT_PREFIX = "cs-task:accept:";
const TASK_COMPLETE_PREFIX = "cs-task:complete:";
const TASK_CANCEL_PREFIX = "cs-task:cancel:";
const TASK_EDIT_PREFIX = "cs-task:edit:";
const TASK_APPROVE_PREFIX = "cs-task:approve:";
const TASK_DENY_PREFIX = "cs-task:deny:";
const TASK_EDIT_MODAL_PREFIX = "cs-task:edit-modal:";
const EMBED_COLOR = 0x2b7fff;

function coinsDisplay(value) {
  return `${Number(value || 0).toLocaleString()} coin${Math.abs(Number(value || 0)) === 1 ? "" : "s"}`;
}

function taskTypeLabel(type) {
  return type === "single" ? "Single" : "Multiple";
}

function parseIdFromPrefix(customId, prefix) {
  if (!customId.startsWith(prefix)) return null;
  const value = Number(customId.slice(prefix.length));
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function buildTaskEmbed(task, stats) {
  const embed = makeEmbed({
    title: "Closet Share Task",
    color: EMBED_COLOR,
    description: task.details,
    fields: [
      { name: "Task Type", value: taskTypeLabel(task.task_type), inline: true },
      { name: "Coins", value: coinsDisplay(task.coin_reward), inline: true },
      { name: "Status", value: task.status === "open" ? "Open" : "Closed", inline: true },
      { name: "Accepted", value: String(stats.accepted_count), inline: true },
      { name: "Completed", value: String(stats.approved_count), inline: true },
      { name: "Created By", value: `<@${task.created_by}>`, inline: true }
    ],
    footer: `Task #${task.id}`
  });

  const thumbnailUrl = safeEmbedUrl(config.leaderboardThumbnailUrl);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);

  return embed;
}

function buildTaskComponents(task, stats) {
  const isSingleTaken = task.task_type === "single" && stats.single_locked;
  const acceptDisabled = task.status !== "open" || isSingleTaken;
  const completeDisabled = task.status !== "open";
  const cancelDisabled = task.status !== "open";

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${TASK_ACCEPT_PREFIX}${task.id}`)
        .setLabel("Accept")
        .setStyle(ButtonStyle.Success)
        .setDisabled(acceptDisabled),
      new ButtonBuilder()
        .setCustomId(`${TASK_COMPLETE_PREFIX}${task.id}`)
        .setLabel("Complete")
        .setStyle(ButtonStyle.Primary)
        .setDisabled(completeDisabled),
      new ButtonBuilder()
        .setCustomId(`${TASK_CANCEL_PREFIX}${task.id}`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(cancelDisabled),
      new ButtonBuilder()
        .setCustomId(`${TASK_EDIT_PREFIX}${task.id}`)
        .setLabel("Edit")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function makeTaskMessagePayload(task, stats) {
  return {
    embeds: [buildTaskEmbed(task, stats)],
    components: buildTaskComponents(task, stats)
  };
}

function createFeature({ featureSlug, createFeatureDb }) {
  const { db, dbPath } = createFeatureDb(featureSlug, "tasks.sqlite");

  db.exec(`
    CREATE TABLE IF NOT EXISTS cs_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT,
      task_type TEXT NOT NULL CHECK (task_type IN ('single', 'multiple')),
      details TEXT NOT NULL,
      coin_reward INTEGER NOT NULL CHECK (coin_reward > 0),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cs_task_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('accepted', 'submitted', 'approving', 'approved', 'denied', 'cancelled')),
      approved_by TEXT,
      denied_by TEXT,
      awarded_amount INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES cs_tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cs_task_claims_task_status
      ON cs_task_claims (task_id, status);

    CREATE INDEX IF NOT EXISTS idx_cs_task_claims_user
      ON cs_task_claims (guild_id, user_id, created_at DESC);
  `);

  const insertTaskStmt = db.prepare(`
    INSERT INTO cs_tasks (guild_id, channel_id, task_type, details, coin_reward, status, created_by, updated_at)
    VALUES (?, ?, ?, ?, ?, 'open', ?, datetime('now'))
  `);

  const setTaskMessageStmt = db.prepare(`
    UPDATE cs_tasks
    SET message_id = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const updateTaskBasicStmt = db.prepare(`
    UPDATE cs_tasks
    SET details = ?, coin_reward = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const getTaskByIdStmt = db.prepare(`
    SELECT id, guild_id, channel_id, message_id, task_type, details, coin_reward, status, created_by, created_at, updated_at
    FROM cs_tasks
    WHERE id = ?
  `);

  const listTasksStmt = db.prepare(`
    SELECT id, task_type, details, coin_reward, status, created_at
    FROM cs_tasks
    WHERE guild_id = ?
    ORDER BY id DESC
    LIMIT 10
  `);

  const getTaskStatsStmt = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted_count,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_count,
      COALESCE(SUM(CASE WHEN status IN ('accepted', 'submitted', 'approving', 'approved') THEN 1 ELSE 0 END), 0) AS single_locked
    FROM cs_task_claims
    WHERE task_id = ?
  `);

  const createClaimStmt = db.prepare(`
    INSERT INTO cs_task_claims (task_id, guild_id, user_id, status, updated_at)
    VALUES (?, ?, ?, 'accepted', datetime('now'))
  `);

  const getClaimByTaskAndUserStmt = db.prepare(`
    SELECT id, task_id, guild_id, user_id, status, approved_by, denied_by, awarded_amount, created_at, updated_at
    FROM cs_task_claims
    WHERE task_id = ? AND user_id = ?
  `);

  const setClaimStatusStmt = db.prepare(`
    UPDATE cs_task_claims
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const tryMarkApprovingStmt = db.prepare(`
    UPDATE cs_task_claims
    SET status = 'approving', updated_at = datetime('now')
    WHERE id = ? AND status = 'submitted'
  `);

  const finalizeApprovedClaimStmt = db.prepare(`
    UPDATE cs_task_claims
    SET status = 'approved', approved_by = ?, awarded_amount = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'approving'
  `);

  const markDeniedClaimStmt = db.prepare(`
    UPDATE cs_task_claims
    SET status = 'denied', denied_by = ?, updated_at = datetime('now')
    WHERE id = ? AND status = 'submitted'
  `);

  const getClaimWithTaskStmt = db.prepare(`
    SELECT
      c.id AS claim_id,
      c.status AS claim_status,
      c.user_id AS claimer_id,
      c.guild_id,
      t.id AS task_id,
      t.task_type,
      t.details,
      t.coin_reward,
      t.status AS task_status,
      t.created_by,
      t.channel_id,
      t.message_id
    FROM cs_task_claims c
    JOIN cs_tasks t ON t.id = c.task_id
    WHERE c.id = ?
  `);

  const closeSingleTaskStmt = db.prepare(`
    UPDATE cs_tasks
    SET status = 'closed', updated_at = datetime('now')
    WHERE id = ? AND task_type = 'single' AND status = 'open'
  `);

  function getTaskStats(taskId) {
    const row = getTaskStatsStmt.get(taskId) || {};
    return {
      accepted_count: Number(row.accepted_count || 0),
      approved_count: Number(row.approved_count || 0),
      single_locked: Number(row.single_locked || 0) > 0
    };
  }

  async function sendDmSafe(client, userId, payload) {
    try {
      const user = await client.users.fetch(userId);
      if (!user) return false;
      await user.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  async function syncTaskMessage(client, taskId) {
    const task = getTaskByIdStmt.get(taskId);
    if (!task || !task.message_id) return;

    const guild = client.guilds.cache.get(task.guild_id) || (await client.guilds.fetch(task.guild_id).catch(() => null));
    if (!guild) return;

    const channel = guild.channels.cache.get(task.channel_id) || (await guild.channels.fetch(task.channel_id).catch(() => null));
    if (!channel || typeof channel.messages?.fetch !== "function") return;

    const message = await channel.messages.fetch(task.message_id).catch(() => null);
    if (!message) return;

    const stats = getTaskStats(task.id);
    await message.edit(makeTaskMessagePayload(task, stats)).catch(() => null);
  }

  async function handleAccept(interaction, { client }) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_ACCEPT_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid task action.", ephemeral: true });

    const task = getTaskByIdStmt.get(taskId);
    if (!task || task.status !== "open") {
      return reply(interaction, { content: "This task is not open anymore.", ephemeral: true });
    }

    if (task.created_by === interaction.user.id) {
      return reply(interaction, { content: "You cannot accept your own task.", ephemeral: true });
    }

    const existing = getClaimByTaskAndUserStmt.get(taskId, interaction.user.id);
    if (existing) {
      return reply(interaction, {
        content: "You have already interacted with this task. Each member can only accept once.",
        ephemeral: true
      });
    }

    if (task.task_type === "single") {
      const stats = getTaskStats(taskId);
      if (stats.single_locked) {
        return reply(interaction, { content: "This single task has already been claimed.", ephemeral: true });
      }
    }

    createClaimStmt.run(taskId, task.guild_id, interaction.user.id);
    await syncTaskMessage(client, taskId);

    const dmSent = await sendDmSafe(client, task.created_by, {
      embeds: [
        makeEmbed({
          title: "Task accepted",
          description: `<@${interaction.user.id}> accepted Task #${task.id}.`,
          fields: [
            { name: "Type", value: taskTypeLabel(task.task_type), inline: true },
            { name: "Coins", value: coinsDisplay(task.coin_reward), inline: true },
            { name: "Details", value: task.details }
          ]
        })
      ]
    });

    return reply(interaction, {
      content: dmSent
        ? "Task accepted. The task creator has been notified via DM."
        : "Task accepted. I could not DM the creator, but your claim was saved.",
      ephemeral: true
    });
  }

  async function handleComplete(interaction, { client }) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_COMPLETE_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid task action.", ephemeral: true });

    const task = getTaskByIdStmt.get(taskId);
    if (!task || task.status !== "open") {
      return reply(interaction, { content: "This task is not open anymore.", ephemeral: true });
    }

    const claim = getClaimByTaskAndUserStmt.get(taskId, interaction.user.id);
    if (!claim || claim.status !== "accepted") {
      return reply(interaction, {
        content: "You need to accept this task before you can complete it.",
        ephemeral: true
      });
    }

    setClaimStatusStmt.run("submitted", claim.id);

    const dmSent = await sendDmSafe(client, task.created_by, {
      embeds: [
        makeEmbed({
          title: "Task completion submitted",
          description: `<@${interaction.user.id}> marked Task #${task.id} as complete. Please verify.`,
          fields: [
            { name: "Type", value: taskTypeLabel(task.task_type), inline: true },
            { name: "Coins", value: coinsDisplay(task.coin_reward), inline: true },
            { name: "Details", value: task.details }
          ]
        })
      ],
      components: [
        new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId(`${TASK_APPROVE_PREFIX}${claim.id}`)
            .setLabel("Approve")
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`${TASK_DENY_PREFIX}${claim.id}`).setLabel("Deny").setStyle(ButtonStyle.Danger)
        )
      ]
    });

    return reply(interaction, {
      content: dmSent
        ? "Completion submitted. The task creator has been asked to verify via DM."
        : "Completion submitted, but I could not DM the creator.",
      ephemeral: true
    });
  }

  async function handleCancel(interaction, { client }) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_CANCEL_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid task action.", ephemeral: true });

    const claim = getClaimByTaskAndUserStmt.get(taskId, interaction.user.id);
    if (!claim || claim.status !== "accepted") {
      return reply(interaction, {
        content: "You can only cancel a task you currently have accepted.",
        ephemeral: true
      });
    }

    setClaimStatusStmt.run("cancelled", claim.id);
    await syncTaskMessage(client, taskId);

    return reply(interaction, {
      content: "Your task acceptance has been cancelled.",
      ephemeral: true
    });
  }

  async function handleEdit(interaction) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_EDIT_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid task action.", ephemeral: true });

    const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
    if (denied) return denied;

    const task = getTaskByIdStmt.get(taskId);
    if (!task) {
      return reply(interaction, { content: "Task not found.", ephemeral: true });
    }

    const detailsInput = new TextInputBuilder()
      .setCustomId("details")
      .setLabel("Task details")
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(1000)
      .setValue(task.details);

    const coinsInput = new TextInputBuilder()
      .setCustomId("coins")
      .setLabel("Coin reward")
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setValue(String(task.coin_reward));

    const modal = new ModalBuilder().setCustomId(`${TASK_EDIT_MODAL_PREFIX}${task.id}`).setTitle(`Edit Task #${task.id}`);

    modal.addComponents(new ActionRowBuilder().addComponents(detailsInput), new ActionRowBuilder().addComponents(coinsInput));

    return interaction.showModal(modal);
  }

  async function handleApprove(interaction, { client }) {
    const claimId = parseIdFromPrefix(interaction.customId, TASK_APPROVE_PREFIX);
    if (!claimId) return reply(interaction, { content: "Invalid approval action.", ephemeral: true });

    const row = getClaimWithTaskStmt.get(claimId);
    if (!row) return reply(interaction, { content: "Task submission not found.", ephemeral: true });

    if (interaction.user.id !== row.created_by) {
      return reply(interaction, { content: "Only the task creator can approve this submission.", ephemeral: true });
    }

    if (row.claim_status !== "submitted") {
      return reply(interaction, { content: "This submission is no longer pending.", ephemeral: true });
    }

    const markResult = tryMarkApprovingStmt.run(claimId);
    if (markResult.changes === 0) {
      return reply(interaction, { content: "This submission is no longer pending.", ephemeral: true });
    }

    try {
      const award = applyCoinDelta({
        guildId: row.guild_id,
        userId: row.claimer_id,
        amount: row.coin_reward,
        reason: `Approved CS task #${row.task_id}`,
        createdBy: interaction.user.id,
        source: "cs_task_approve"
      });

      const finalizeResult = finalizeApprovedClaimStmt.run(interaction.user.id, row.coin_reward, claimId);
      if (finalizeResult.changes === 0) {
        throw new Error("Could not finalize task approval state.");
      }

      if (row.task_type === "single") {
        closeSingleTaskStmt.run(row.task_id);
      }

      await syncTaskMessage(client, row.task_id);

      await syncLeaderboardMessage({
        client,
        guildId: row.guild_id,
        channelId: config.leaderboardChannelId,
        forcePost: false
      }).catch(() => null);

      await sendDmSafe(client, row.claimer_id, {
        embeds: [
          makeEmbed({
            title: "Task approved",
            description: `Your completion for Task #${row.task_id} was approved. You earned **${coinsDisplay(row.coin_reward)}**.`,
            fields: [{ name: "New Balance", value: coinsDisplay(award.balance), inline: true }]
          })
        ]
      });

      return reply(interaction, { content: "Task approved and coins were awarded.", ephemeral: true });
    } catch (error) {
      setClaimStatusStmt.run("submitted", claimId);
      throw error;
    }
  }

  async function handleDeny(interaction, { client }) {
    const claimId = parseIdFromPrefix(interaction.customId, TASK_DENY_PREFIX);
    if (!claimId) return reply(interaction, { content: "Invalid deny action.", ephemeral: true });

    const row = getClaimWithTaskStmt.get(claimId);
    if (!row) return reply(interaction, { content: "Task submission not found.", ephemeral: true });

    if (interaction.user.id !== row.created_by) {
      return reply(interaction, { content: "Only the task creator can deny this submission.", ephemeral: true });
    }

    const denyResult = markDeniedClaimStmt.run(interaction.user.id, claimId);
    if (denyResult.changes === 0) {
      return reply(interaction, { content: "This submission is no longer pending.", ephemeral: true });
    }

    await syncTaskMessage(client, row.task_id);

    await sendDmSafe(client, row.claimer_id, {
      content: "Unfortunately, the task has not been completed yet. Please try again."
    });

    return reply(interaction, { content: "Submission denied and user notified.", ephemeral: true });
  }

  async function handleEditModal(interaction, { client }) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_EDIT_MODAL_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid edit request.", ephemeral: true });

    const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
    if (denied) return denied;

    const task = getTaskByIdStmt.get(taskId);
    if (!task) {
      return reply(interaction, { content: "Task not found.", ephemeral: true });
    }

    const details = (interaction.fields.getTextInputValue("details") || "").trim();
    const rawCoins = (interaction.fields.getTextInputValue("coins") || "").trim();
    const coinReward = Number(rawCoins);

    if (!details) {
      return reply(interaction, { content: "Task details cannot be empty.", ephemeral: true });
    }

    if (!Number.isInteger(coinReward) || coinReward < 1) {
      return reply(interaction, { content: "Coins must be a whole number of at least 1.", ephemeral: true });
    }

    updateTaskBasicStmt.run(details, coinReward, taskId);
    await syncTaskMessage(client, taskId);

    return reply(interaction, { content: "Task updated.", ephemeral: true });
  }

  const commands = [
    {
      data: new SlashCommandBuilder()
        .setName("add-task")
        .setDescription("Create a Closet Share task event. Owner only.")
        .addStringOption((option) =>
          option
            .setName("type")
            .setDescription("Task type")
            .setRequired(true)
            .addChoices(
              { name: "Single", value: "single" },
              { name: "Multiple", value: "multiple" }
            )
        )
        .addStringOption((option) =>
          option
            .setName("details")
            .setDescription("Task details for members")
            .setRequired(true)
            .setMaxLength(1000)
        )
        .addIntegerOption((option) =>
          option.setName("coins").setDescription("Coins earned when approved").setRequired(true).setMinValue(1)
        ),
      async execute(interaction) {
        const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
        if (denied) return denied;

        if (!interaction.inGuild() || !interaction.channel || typeof interaction.channel.send !== "function") {
          return reply(interaction, { content: "This command can only be used in a server text channel.", ephemeral: true });
        }

        const taskType = interaction.options.getString("type", true);
        const details = interaction.options.getString("details", true).trim();
        const coinReward = interaction.options.getInteger("coins", true);

        const result = insertTaskStmt.run(
          interaction.guildId,
          interaction.channelId,
          taskType,
          details,
          coinReward,
          interaction.user.id
        );

        const taskId = Number(result.lastInsertRowid);
        const task = getTaskByIdStmt.get(taskId);
        const payload = makeTaskMessagePayload(task, getTaskStats(taskId));

        const taskMessage = await interaction.channel.send(payload);
        setTaskMessageStmt.run(taskMessage.id, taskId);

        return reply(interaction, {
          content: `Task #${taskId} created in <#${interaction.channelId}>.`,
          ephemeral: true
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName("task-list")
        .setDescription("List the newest Closet Share tasks."),
      async execute(interaction) {
        const rows = listTasksStmt.all(interaction.guildId || "dm");
        if (!rows.length) {
          return reply(interaction, { content: "No tasks yet.", ephemeral: true });
        }

        const description = rows
          .map(
            (row) =>
              `**#${row.id}** • ${taskTypeLabel(row.task_type)} • ${coinsDisplay(row.coin_reward)} • ${row.status}\n${row.details}`
          )
          .join("\n\n");

        return reply(interaction, {
          embeds: [makeEmbed({ title: "Recent tasks", description })],
          ephemeral: true
        });
      }
    }
  ];

  const buttons = [
    {
      customId: /^cs-task:accept:\d+$/,
      execute: handleAccept
    },
    {
      customId: /^cs-task:complete:\d+$/,
      execute: handleComplete
    },
    {
      customId: /^cs-task:cancel:\d+$/,
      execute: handleCancel
    },
    {
      customId: /^cs-task:edit:\d+$/,
      execute: handleEdit
    },
    {
      customId: /^cs-task:approve:\d+$/,
      execute: handleApprove
    },
    {
      customId: /^cs-task:deny:\d+$/,
      execute: handleDeny
    }
  ];

  const modals = [
    {
      customId: /^cs-task:edit-modal:\d+$/,
      execute: handleEditModal
    }
  ];

  return {
    db,
    dbPath,
    commands,
    buttons,
    modals
  };
}

module.exports = { createFeature };
