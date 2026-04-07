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
const {
  ensureOwnerAccess,
  hasAdminPermission,
  makeEmbed,
  memberHasRoleId,
  reply,
  safeEmbedUrl
} = require("../../core/discord-helpers");

const TASK_ACCEPT_PREFIX = "cs-task:accept:";
const TASK_COMPLETE_PREFIX = "cs-task:complete:";
const TASK_CANCEL_PREFIX = "cs-task:cancel:";
const TASK_EDIT_PREFIX = "cs-task:edit:";
const TASK_APPROVE_PREFIX = "cs-task:approve:";
const TASK_DENY_PREFIX = "cs-task:deny:";
const TASK_CLOSE_PREFIX = "cs-task:close:";
const TASK_EDIT_MODAL_PREFIX = "cs-task:edit-modal:";
const EMBED_COLOR = 0x2b7fff;

const TASK_STATUSES = {
  OPEN: "open",
  CLOSED: "closed",
  CANCELLED: "cancelled",
  ARCHIVED: "archived"
};

const CLAIM_STATUSES = {
  ACCEPTED: "accepted",
  SUBMITTED: "submitted",
  APPROVING: "approving",
  APPROVED: "approved",
  DENIED: "denied",
  CANCELLED: "cancelled"
};

const TERMINAL_TASK_STATUSES = new Set([TASK_STATUSES.CLOSED, TASK_STATUSES.CANCELLED, TASK_STATUSES.ARCHIVED]);
const TERMINAL_CLAIM_STATUSES = new Set([CLAIM_STATUSES.APPROVED, CLAIM_STATUSES.DENIED, CLAIM_STATUSES.CANCELLED]);
const TASK_EVENT_LIMIT = 15;
const CLAIM_PAYOUT_STATES = {
  NONE: "none",
  IN_PROGRESS: "in_progress",
  SUCCEEDED: "succeeded",
  FINALIZED: "finalized",
  NEEDS_RECONCILIATION: "needs_reconciliation"
};

function coinsDisplay(value) {
  return `${Number(value || 0).toLocaleString()} coin${Math.abs(Number(value || 0)) === 1 ? "" : "s"}`;
}

function taskTypeLabel(type) {
  return type === "single" ? "Single" : "Multiple";
}

function humanizeStatus(value) {
  return String(value || "unknown")
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function parseIdFromPrefix(customId, prefix) {
  if (!customId.startsWith(prefix)) return null;
  const value = Number(customId.slice(prefix.length));
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

function isOwnerOrAdmin(interaction) {
  return hasAdminPermission(interaction) || memberHasRoleId(interaction, config.ownerRoleId);
}

function canManageTask(interaction, task) {
  if (interaction.user.id === task.created_by) return true;
  if (!interaction.inGuild()) return false;
  return isOwnerOrAdmin(interaction);
}

function ensureOwnerOrAdminAccess(interaction) {
  if (isOwnerOrAdmin(interaction)) return null;
  return reply(interaction, { content: "Only admins/owners can use this command.", ephemeral: true });
}

function formatDiscordDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  if (!Number.isFinite(ms)) return value;
  return `<t:${Math.floor(ms / 1000)}:f>`;
}

function truncate(value, max = 140) {
  const input = String(value || "").trim();
  if (!input) return "Untitled task";
  if (input.length <= max) return input;
  return `${input.slice(0, max - 1)}…`;
}

function formatEventTimestamp(value) {
  const ms = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  if (!Number.isFinite(ms)) return value;
  return `<t:${Math.floor(ms / 1000)}:f>`;
}

function formatRelativeDate(value) {
  if (!value) return "—";
  const ms = Date.parse(value.endsWith("Z") ? value : `${value}Z`);
  if (!Number.isFinite(ms)) return value;
  return `<t:${Math.floor(ms / 1000)}:R>`;
}

function payoutHealthLabel(row) {
  const payoutState = row?.claim_payout_state || row?.payout_state || CLAIM_PAYOUT_STATES.NONE;
  const needsRecon = Number(row?.claim_reconciliation_needed ?? row?.reconciliation_needed ?? 0) === 1;
  const reconFlag = needsRecon ? " ⚠️ Reconcile Needed" : "";
  return `${humanizeStatus(payoutState)}${reconFlag}`;
}

function chunk(items, size) {
  const output = [];
  for (let i = 0; i < items.length; i += size) output.push(items.slice(i, i + size));
  return output;
}

function deriveTaskActivityStatus(task, latestClaim) {
  if (task.is_archived) return "archived";
  if (task.status !== TASK_STATUSES.OPEN) return task.status;
  if (!latestClaim) return "active";
  if (latestClaim.status === CLAIM_STATUSES.ACCEPTED) return "accepted";
  if (latestClaim.status === CLAIM_STATUSES.SUBMITTED || latestClaim.status === CLAIM_STATUSES.APPROVING) {
    return "pending_approval";
  }
  if (latestClaim.status === CLAIM_STATUSES.APPROVED) return "approved";
  if (latestClaim.status === CLAIM_STATUSES.DENIED) return "denied";
  return "active";
}

function buildTaskEmbed(task, stats, latestClaim) {
  const status = deriveTaskActivityStatus(task, latestClaim);
  const completionState = latestClaim
    ? latestClaim.status === CLAIM_STATUSES.SUBMITTED || latestClaim.status === CLAIM_STATUSES.APPROVING
      ? "Submitted"
      : humanizeStatus(latestClaim.status)
    : "Not submitted";
  const approvalState = latestClaim
    ? latestClaim.status === CLAIM_STATUSES.APPROVED
      ? `Approved by <@${latestClaim.approved_by || task.approved_by || "unknown"}>`
      : latestClaim.status === CLAIM_STATUSES.DENIED
        ? `Denied by <@${latestClaim.denied_by || task.denied_by || "unknown"}>`
        : latestClaim.status === CLAIM_STATUSES.SUBMITTED || latestClaim.status === CLAIM_STATUSES.APPROVING
          ? "Pending creator/admin review"
          : "Not reviewed"
    : "Not reviewed";

  const embed = makeEmbed({
    title: task.title || "Closet Share Task",
    color: EMBED_COLOR,
    description: task.details,
    fields: [
      { name: "Task ID", value: `#${task.id}`, inline: true },
      { name: "Type", value: taskTypeLabel(task.task_type), inline: true },
      { name: "Reward", value: coinsDisplay(task.coin_reward), inline: true },
      { name: "Status", value: humanizeStatus(status), inline: true },
      { name: "Creator", value: `<@${task.created_by}>`, inline: true },
      {
        name: "Assignee",
        value: latestClaim?.user_id ? `<@${latestClaim.user_id}>` : task.assignee_id ? `<@${task.assignee_id}>` : "Unassigned",
        inline: true
      },
      { name: "Completion", value: completionState, inline: true },
      { name: "Approval", value: approvalState, inline: true },
      { name: "Created", value: formatDiscordDate(task.created_at), inline: true }
    ],
    footer: `Task #${task.id}`
  });

  if (task.completed_at) {
    embed.addFields({ name: "Completed", value: formatDiscordDate(task.completed_at), inline: true });
  }

  if (task.dm_complete_failed) {
    embed.setFooter({ text: `Task #${task.id} • DM approval failed; use /task-approve or /task-deny.` });
  }

  const thumbnailUrl = safeEmbedUrl(config.leaderboardThumbnailUrl);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  const imageUrl = safeEmbedUrl(config.csTaskEmbedImageUrl);
  if (imageUrl) embed.setImage(imageUrl);

  if (stats.approved_count > 0 || stats.accepted_count > 0) {
    embed.addFields(
      { name: "Accepted Count", value: String(stats.accepted_count), inline: true },
      { name: "Approved Count", value: String(stats.approved_count), inline: true }
    );
  }

  return embed;
}

function buildTaskComponents(task, latestClaim) {
  const taskStatus = task?.status ?? null;
  const taskType = task?.task_type ?? null;
  const latestClaimStatus = latestClaim?.status ?? null;
  const isArchived = Boolean(task?.is_archived);

  const terminal = Boolean(TERMINAL_TASK_STATUSES.has(taskStatus) || isArchived);
  const claimedBySomeone = Boolean(
    taskType === "single" &&
      latestClaim &&
      !TERMINAL_CLAIM_STATUSES.has(latestClaimStatus)
  );
  const pendingApproval = Boolean(
    latestClaim &&
      [CLAIM_STATUSES.SUBMITTED, CLAIM_STATUSES.APPROVING].includes(latestClaimStatus)
  );

  const acceptDisabled = Boolean(
    terminal ||
      taskStatus !== TASK_STATUSES.OPEN ||
      claimedBySomeone ||
      pendingApproval
  );
  const completeDisabled = Boolean(
    terminal || !latestClaim || latestClaimStatus !== CLAIM_STATUSES.ACCEPTED
  );
  const cancelDisabled = Boolean(
    terminal || !latestClaim || latestClaimStatus !== CLAIM_STATUSES.ACCEPTED
  );
  const editDisabled = Boolean(terminal || pendingApproval);
  const closeDisabled = Boolean(terminal);

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
        .setLabel("Cancel Claim")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(cancelDisabled),
      new ButtonBuilder()
        .setCustomId(`${TASK_EDIT_PREFIX}${task.id}`)
        .setLabel("Edit")
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(editDisabled),
      new ButtonBuilder()
        .setCustomId(`${TASK_CLOSE_PREFIX}${task.id}`)
        .setLabel("Close")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(closeDisabled)
    )
  ];
}

function makeTaskMessagePayload(task, stats, latestClaim) {
  return {
    embeds: [buildTaskEmbed(task, stats, latestClaim)],
    components: buildTaskComponents(task, latestClaim)
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
      title TEXT NOT NULL DEFAULT '',
      details TEXT NOT NULL,
      coin_reward INTEGER NOT NULL CHECK (coin_reward > 0),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled', 'archived')),
      created_by TEXT NOT NULL,
      assignee_id TEXT,
      approved_by TEXT,
      denied_by TEXT,
      cancelled_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      accepted_at TEXT,
      completed_at TEXT,
      approved_at TEXT,
      denied_at TEXT,
      cancelled_at TEXT,
      last_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      dm_accept_sent INTEGER NOT NULL DEFAULT 0 CHECK (dm_accept_sent IN (0, 1)),
      dm_complete_sent INTEGER NOT NULL DEFAULT 0 CHECK (dm_complete_sent IN (0, 1)),
      dm_complete_failed INTEGER NOT NULL DEFAULT 0 CHECK (dm_complete_failed IN (0, 1)),
      completion_note TEXT,
      proof_text TEXT,
      proof_url TEXT,
      is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
      archived_at TEXT,
      archived_by TEXT
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
      completion_note TEXT,
      proof_text TEXT,
      proof_url TEXT,
      completed_at TEXT,
      payout_state TEXT NOT NULL DEFAULT 'none' CHECK (payout_state IN ('none', 'in_progress', 'succeeded', 'finalized', 'needs_reconciliation')),
      payout_started_at TEXT,
      payout_succeeded_at TEXT,
      finalization_completed_at TEXT,
      reconciliation_needed INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_needed IN (0, 1)),
      reconciliation_reason TEXT,
      reconciliation_needed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES cs_tasks(id) ON DELETE CASCADE,
      UNIQUE(task_id, user_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cs_task_claims_task_status
      ON cs_task_claims (task_id, status);

    CREATE INDEX IF NOT EXISTS idx_cs_task_claims_user
      ON cs_task_claims (guild_id, user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_cs_tasks_guild_created
      ON cs_tasks (guild_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS cs_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id INTEGER NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT,
      message_id TEXT,
      actor_user_id TEXT,
      target_user_id TEXT,
      event_type TEXT NOT NULL,
      prev_status TEXT,
      next_status TEXT,
      metadata_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (task_id) REFERENCES cs_tasks(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_cs_task_events_task_created
      ON cs_task_events (task_id, created_at DESC, id DESC);
  `);

  const ensureColumnStmt = db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?");
  function ensureColumn(table, column, definition) {
    const row = ensureColumnStmt.get(table, column);
    if (row) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  ensureColumn("cs_tasks", "title", "TEXT NOT NULL DEFAULT ''");
  ensureColumn("cs_tasks", "assignee_id", "TEXT");
  ensureColumn("cs_tasks", "approved_by", "TEXT");
  ensureColumn("cs_tasks", "denied_by", "TEXT");
  ensureColumn("cs_tasks", "cancelled_by", "TEXT");
  ensureColumn("cs_tasks", "accepted_at", "TEXT");
  ensureColumn("cs_tasks", "completed_at", "TEXT");
  ensureColumn("cs_tasks", "approved_at", "TEXT");
  ensureColumn("cs_tasks", "denied_at", "TEXT");
  ensureColumn("cs_tasks", "cancelled_at", "TEXT");
  ensureColumn("cs_tasks", "last_updated_at", "TEXT NOT NULL DEFAULT (datetime('now'))");
  ensureColumn("cs_tasks", "dm_accept_sent", "INTEGER NOT NULL DEFAULT 0 CHECK (dm_accept_sent IN (0, 1))");
  ensureColumn("cs_tasks", "dm_complete_sent", "INTEGER NOT NULL DEFAULT 0 CHECK (dm_complete_sent IN (0, 1))");
  ensureColumn("cs_tasks", "dm_complete_failed", "INTEGER NOT NULL DEFAULT 0 CHECK (dm_complete_failed IN (0, 1))");
  ensureColumn("cs_tasks", "completion_note", "TEXT");
  ensureColumn("cs_tasks", "proof_text", "TEXT");
  ensureColumn("cs_tasks", "proof_url", "TEXT");
  ensureColumn("cs_tasks", "is_archived", "INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1))");
  ensureColumn("cs_tasks", "archived_at", "TEXT");
  ensureColumn("cs_tasks", "archived_by", "TEXT");

  ensureColumn("cs_task_claims", "completion_note", "TEXT");
  ensureColumn("cs_task_claims", "proof_text", "TEXT");
  ensureColumn("cs_task_claims", "proof_url", "TEXT");
  ensureColumn("cs_task_claims", "completed_at", "TEXT");
  ensureColumn(
    "cs_task_claims",
    "payout_state",
    "TEXT NOT NULL DEFAULT 'none' CHECK (payout_state IN ('none', 'in_progress', 'succeeded', 'finalized', 'needs_reconciliation'))"
  );
  ensureColumn("cs_task_claims", "payout_started_at", "TEXT");
  ensureColumn("cs_task_claims", "payout_succeeded_at", "TEXT");
  ensureColumn("cs_task_claims", "finalization_completed_at", "TEXT");
  ensureColumn("cs_task_claims", "reconciliation_needed", "INTEGER NOT NULL DEFAULT 0 CHECK (reconciliation_needed IN (0, 1))");
  ensureColumn("cs_task_claims", "reconciliation_reason", "TEXT");
  ensureColumn("cs_task_claims", "reconciliation_needed_at", "TEXT");
  ensureColumn("cs_task_events", "metadata_json", "TEXT");

  db.exec("UPDATE cs_tasks SET title = COALESCE(NULLIF(title, ''), substr(details, 1, 120)) WHERE title IS NULL OR title = ''");
  db.exec("UPDATE cs_tasks SET last_updated_at = COALESCE(last_updated_at, created_at, datetime('now'))");

  const insertTaskStmt = db.prepare(`
    INSERT INTO cs_tasks (guild_id, channel_id, task_type, title, details, coin_reward, status, created_by, last_updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, datetime('now'))
  `);

  const setTaskMessageStmt = db.prepare(`
    UPDATE cs_tasks
    SET message_id = ?, last_updated_at = datetime('now')
    WHERE id = ?
  `);

  const updateTaskBasicStmt = db.prepare(`
    UPDATE cs_tasks
    SET title = ?, details = ?, coin_reward = ?, last_updated_at = datetime('now')
    WHERE id = ?
  `);

  const getTaskByIdStmt = db.prepare(`
    SELECT *
    FROM cs_tasks
    WHERE id = ?
  `);

  const getLatestClaimStmt = db.prepare(`
    SELECT *
    FROM cs_task_claims
    WHERE task_id = ?
    ORDER BY updated_at DESC, id DESC
    LIMIT 1
  `);

  const getClaimByTaskAndUserStmt = db.prepare(`
    SELECT *
    FROM cs_task_claims
    WHERE task_id = ? AND user_id = ?
  `);

  const listTasksStmt = db.prepare(`
    SELECT t.*,
      c.id AS claim_id,
      c.user_id AS claim_user_id,
      c.status AS claim_status,
      c.updated_at AS claim_updated_at,
      c.payout_state AS claim_payout_state,
      c.reconciliation_needed AS claim_reconciliation_needed,
      c.reconciliation_reason AS claim_reconciliation_reason,
      c.reconciliation_needed_at AS claim_reconciliation_needed_at
    FROM cs_tasks t
    LEFT JOIN cs_task_claims c ON c.id = (
      SELECT id
      FROM cs_task_claims c2
      WHERE c2.task_id = t.id
      ORDER BY c2.updated_at DESC, c2.id DESC
      LIMIT 1
    )
    WHERE t.guild_id = ?
    ORDER BY t.id DESC
    LIMIT ?
  `);

  const getTaskStatsStmt = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted_count,
      COALESCE(SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END), 0) AS approved_count,
      COALESCE(SUM(CASE WHEN status IN ('accepted', 'submitted', 'approving') THEN 1 ELSE 0 END), 0) AS active_count
    FROM cs_task_claims
    WHERE task_id = ?
  `);

  const createClaimStmt = db.prepare(`
    INSERT INTO cs_task_claims (task_id, guild_id, user_id, status, updated_at)
    VALUES (?, ?, ?, 'accepted', datetime('now'))
  `);

  const setClaimStatusStmt = db.prepare(`
    UPDATE cs_task_claims
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const setTaskAcceptedMetadataStmt = db.prepare(`
    UPDATE cs_tasks
    SET assignee_id = ?, accepted_at = datetime('now'), last_updated_at = datetime('now')
    WHERE id = ?
  `);

  const setTaskCompletedMetadataStmt = db.prepare(`
    UPDATE cs_tasks
    SET completed_at = datetime('now'), completion_note = ?, dm_complete_sent = ?, dm_complete_failed = ?, last_updated_at = datetime('now')
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
    WHERE id = ? AND status IN ('submitted', 'approving')
  `);

  const getClaimWithTaskStmt = db.prepare(`
    SELECT
      c.id AS claim_id,
      c.status AS claim_status,
      c.user_id AS claimer_id,
      c.guild_id,
      c.completion_note,
      c.payout_state,
      c.reconciliation_needed,
      c.reconciliation_reason,
      c.reconciliation_needed_at,
      t.id AS task_id,
      t.task_type,
      t.details,
      t.coin_reward,
      t.status AS task_status,
      t.is_archived,
      t.created_by,
      t.channel_id,
      t.message_id
    FROM cs_task_claims c
    JOIN cs_tasks t ON t.id = c.task_id
    WHERE c.id = ?
  `);

  const getTaskWithLatestClaimStmt = db.prepare(`
    SELECT
      t.*,
      c.id AS claim_id,
      c.user_id AS claim_user_id,
      c.status AS claim_status,
      c.payout_state AS claim_payout_state,
      c.reconciliation_needed AS claim_reconciliation_needed,
      c.reconciliation_needed_at AS claim_reconciliation_needed_at
    FROM cs_tasks t
    LEFT JOIN cs_task_claims c ON c.id = (
      SELECT id FROM cs_task_claims c2 WHERE c2.task_id = t.id ORDER BY c2.updated_at DESC, c2.id DESC LIMIT 1
    )
    WHERE t.id = ?
  `);

  const setTaskClosedStmt = db.prepare(`
    UPDATE cs_tasks
    SET status = ?, cancelled_by = ?, cancelled_at = datetime('now'), last_updated_at = datetime('now')
    WHERE id = ? AND status = 'open' AND is_archived = 0
  `);

  const archiveTaskStmt = db.prepare(`
    UPDATE cs_tasks
    SET is_archived = 1,
        status = 'archived',
        archived_at = datetime('now'),
        archived_by = ?,
        last_updated_at = datetime('now')
    WHERE id = ? AND is_archived = 0
  `);

  const setTaskApprovalMetadataStmt = db.prepare(`
    UPDATE cs_tasks
    SET approved_by = ?, approved_at = datetime('now'), last_updated_at = datetime('now')
    WHERE id = ?
  `);

  const setTaskDenialMetadataStmt = db.prepare(`
    UPDATE cs_tasks
    SET denied_by = ?, denied_at = datetime('now'), last_updated_at = datetime('now')
    WHERE id = ?
  `);

  const setTaskReassignStmt = db.prepare(`
    UPDATE cs_tasks
    SET assignee_id = ?, accepted_at = CASE WHEN ? IS NULL THEN NULL ELSE datetime('now') END, last_updated_at = datetime('now')
    WHERE id = ?
  `);

  const getOpenClaimByTaskAndUserStmt = db.prepare(`
    SELECT * FROM cs_task_claims WHERE task_id = ? AND user_id = ? AND status = 'accepted'
  `);

  const insertTaskEventStmt = db.prepare(`
    INSERT INTO cs_task_events (
      task_id, guild_id, channel_id, message_id, actor_user_id, target_user_id,
      event_type, prev_status, next_status, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
  `);

  const listTaskEventsStmt = db.prepare(`
    SELECT id, task_id, actor_user_id, target_user_id, event_type, prev_status, next_status, metadata_json, created_at
    FROM cs_task_events
    WHERE task_id = ?
    ORDER BY id DESC
    LIMIT ?
  `);

  const setClaimStatusExactStmt = db.prepare(`
    UPDATE cs_task_claims
    SET status = ?, updated_at = datetime('now')
    WHERE id = ?
  `);

  const markClaimPayoutStartedStmt = db.prepare(`
    UPDATE cs_task_claims
    SET payout_state = 'in_progress',
        payout_started_at = datetime('now'),
        reconciliation_needed = 0,
        reconciliation_reason = NULL,
        reconciliation_needed_at = NULL,
        updated_at = datetime('now')
    WHERE id = ? AND payout_state = 'none'
  `);

  const markClaimPayoutSucceededStmt = db.prepare(`
    UPDATE cs_task_claims
    SET payout_state = 'succeeded',
        payout_succeeded_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ? AND payout_state = 'in_progress'
  `);

  const markClaimNeedsReconciliationStmt = db.prepare(`
    UPDATE cs_task_claims
    SET payout_state = 'needs_reconciliation',
        reconciliation_needed = 1,
        reconciliation_reason = ?,
        reconciliation_needed_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const markClaimPayoutFinalizedStmt = db.prepare(`
    UPDATE cs_task_claims
    SET payout_state = 'finalized',
        reconciliation_needed = 0,
        reconciliation_reason = NULL,
        reconciliation_needed_at = NULL,
        finalization_completed_at = datetime('now'),
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const resetClaimPayoutStateStmt = db.prepare(`
    UPDATE cs_task_claims
    SET payout_state = 'none',
        payout_started_at = NULL,
        payout_succeeded_at = NULL,
        reconciliation_needed = 0,
        reconciliation_reason = NULL,
        reconciliation_needed_at = NULL,
        updated_at = datetime('now')
    WHERE id = ?
  `);

  const listClaimsNeedingReconcileStmt = db.prepare(`
    SELECT
      t.id AS task_id,
      t.title,
      t.coin_reward,
      t.created_by,
      t.assignee_id,
      c.id AS claim_id,
      c.user_id AS claim_user_id,
      c.payout_state,
      c.reconciliation_reason,
      c.reconciliation_needed_at
    FROM cs_task_claims c
    JOIN cs_tasks t ON t.id = c.task_id
    WHERE t.guild_id = ?
      AND t.is_archived = 0
      AND c.reconciliation_needed = 1
      AND c.payout_state = 'needs_reconciliation'
    ORDER BY c.reconciliation_needed_at ASC, c.id ASC
    LIMIT ?
  `);

  const getReconClaimByTaskStmt = db.prepare(`
    SELECT
      c.id AS claim_id,
      c.status AS claim_status,
      c.user_id AS claimer_id,
      c.guild_id,
      c.payout_state,
      c.reconciliation_needed,
      c.reconciliation_reason,
      c.reconciliation_needed_at,
      t.id AS task_id,
      t.task_type,
      t.coin_reward,
      t.created_by
    FROM cs_task_claims c
    JOIN cs_tasks t ON t.id = c.task_id
    WHERE c.task_id = ?
    ORDER BY c.updated_at DESC, c.id DESC
    LIMIT 1
  `);

  function getTaskStats(taskId) {
    const row = getTaskStatsStmt.get(taskId) || {};
    return {
      accepted_count: Number(row.accepted_count || 0),
      approved_count: Number(row.approved_count || 0),
      active_count: Number(row.active_count || 0)
    };
  }

  function logTaskEvent({
    taskId,
    task = null,
    guildId = null,
    channelId = null,
    messageId = null,
    actorUserId = null,
    targetUserId = null,
    eventType,
    prevStatus = null,
    nextStatus = null,
    metadata = null
  }) {
    if (!taskId || !eventType) return;
    const resolvedTask = task || getTaskByIdStmt.get(taskId);
    const safeMeta =
      metadata && typeof metadata === "object"
        ? JSON.stringify(metadata, (key, value) => {
            if (value instanceof Error) return { message: value.message };
            return value;
          })
        : metadata
          ? String(metadata)
          : null;

    insertTaskEventStmt.run(
      taskId,
      guildId || resolvedTask?.guild_id || "unknown",
      channelId || resolvedTask?.channel_id || null,
      messageId || resolvedTask?.message_id || null,
      actorUserId,
      targetUserId,
      eventType,
      prevStatus,
      nextStatus,
      safeMeta
    );
  }

  async function sendDmSafe(client, userId, payload, { context = "cs-task" } = {}) {
    try {
      const user = await client.users.fetch(userId);
      if (!user) return false;
      await user.send(payload);
      return true;
    } catch (error) {
      console.warn(`[${context}] DM failed for user ${userId}: ${error?.message || "unknown error"}`);
      return false;
    }
  }

  async function syncTaskMessage(client, taskId) {
    const task = getTaskByIdStmt.get(taskId);
    if (!task || !task.message_id || !task.guild_id || !task.channel_id) return;

    const guild = client.guilds.cache.get(task.guild_id) || (await client.guilds.fetch(task.guild_id).catch(() => null));
    if (!guild) {
      logTaskEvent({
        taskId,
        task,
        eventType: "task_message_refresh_failed",
        metadata: { reason: "guild_missing", guildId: task.guild_id }
      });
      return;
    }

    const channel = guild.channels.cache.get(task.channel_id) || (await guild.channels.fetch(task.channel_id).catch(() => null));
    if (!channel || typeof channel.messages?.fetch !== "function") {
      logTaskEvent({
        taskId,
        task,
        eventType: "task_message_refresh_failed",
        metadata: { reason: "channel_missing_or_invalid", channelId: task.channel_id }
      });
      return;
    }

    const message = await channel.messages.fetch(task.message_id).catch(() => null);
    if (!message) {
      console.warn(`[cs-task] Task #${taskId} message ${task.message_id} no longer exists in channel ${task.channel_id}.`);
      logTaskEvent({
        taskId,
        task,
        eventType: "task_message_missing",
        metadata: { channelId: task.channel_id, messageId: task.message_id }
      });
      return;
    }

    const latestClaim = getLatestClaimStmt.get(task.id) || null;
    const stats = getTaskStats(task.id);
    await message.edit(makeTaskMessagePayload(task, stats, latestClaim)).catch((error) => {
      console.warn(`[cs-task] Failed to edit task message #${taskId}: ${error?.message || "unknown error"}`);
      logTaskEvent({
        taskId,
        task,
        eventType: "task_message_refresh_failed",
        metadata: { message: error?.message || "unknown error" }
      });
    });
  }

  function validateTaskOpen(task) {
    if (!task) return "Task not found.";
    if (task.is_archived) return "This task has been archived.";
    if (task.status === TASK_STATUSES.CANCELLED) return "This task has been cancelled.";
    if (task.status === TASK_STATUSES.CLOSED) return "This task has been closed.";
    if (task.status !== TASK_STATUSES.OPEN) return "This task is not open.";
    return null;
  }

  const acceptTaskTxn = db.transaction(({ taskId, guildId, userId }) => {
    const task = getTaskByIdStmt.get(taskId);
    const validationError = validateTaskOpen(task);
    if (validationError) return { ok: false, reason: validationError };
    if (task.created_by === userId) return { ok: false, reason: "You cannot accept your own task." };

    const existing = getClaimByTaskAndUserStmt.get(taskId, userId);
    if (existing) {
      return { ok: false, reason: "You have already interacted with this task. Each member can only accept once." };
    }

    const latestClaim = getLatestClaimStmt.get(taskId);
    if (task.task_type === "single" && latestClaim && !TERMINAL_CLAIM_STATUSES.has(latestClaim.status)) {
      return { ok: false, reason: "This single task has already been claimed." };
    }

    const result = createClaimStmt.run(taskId, guildId, userId);
    setTaskAcceptedMetadataStmt.run(userId, taskId);

    return {
      ok: true,
      task,
      claimId: Number(result.lastInsertRowid)
    };
  });

  async function handleAccept(interaction, { client }) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_ACCEPT_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid task action.", ephemeral: true });

    const accepted = acceptTaskTxn({ taskId, guildId: interaction.guildId || "dm", userId: interaction.user.id });
    if (!accepted.ok) {
      return reply(interaction, { content: accepted.reason, ephemeral: true });
    }

    logTaskEvent({
      taskId,
      task: accepted.task,
      actorUserId: interaction.user.id,
      targetUserId: interaction.user.id,
      eventType: "task_accepted",
      prevStatus: null,
      nextStatus: CLAIM_STATUSES.ACCEPTED,
      metadata: { via: "button" }
    });

    await syncTaskMessage(client, taskId);

    const dmSent = await sendDmSafe(
      client,
      accepted.task.created_by,
      {
        embeds: [
          makeEmbed({
            title: "Task accepted",
            description: `<@${interaction.user.id}> accepted Task #${accepted.task.id}.`,
            fields: [
              { name: "Type", value: taskTypeLabel(accepted.task.task_type), inline: true },
              { name: "Coins", value: coinsDisplay(accepted.task.coin_reward), inline: true },
              { name: "Details", value: accepted.task.details }
            ]
          })
        ]
      },
      { context: "cs-task-accept" }
    );

    db.prepare("UPDATE cs_tasks SET dm_accept_sent = ?, last_updated_at = datetime('now') WHERE id = ?").run(dmSent ? 1 : 0, taskId);
    logTaskEvent({
      taskId,
      task: accepted.task,
      actorUserId: interaction.user.id,
      targetUserId: accepted.task.created_by,
      eventType: dmSent ? "task_accept_dm_sent" : "task_accept_dm_failed",
      metadata: { via: "button" }
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
    const validationError = validateTaskOpen(task);
    if (validationError) {
      return reply(interaction, { content: validationError, ephemeral: true });
    }

    const claim = getOpenClaimByTaskAndUserStmt.get(taskId, interaction.user.id);
    if (!claim) {
      return reply(interaction, {
        content: "You can only complete a task currently accepted by you.",
        ephemeral: true
      });
    }

    setClaimStatusStmt.run(CLAIM_STATUSES.SUBMITTED, claim.id);
    logTaskEvent({
      taskId,
      task,
      actorUserId: interaction.user.id,
      targetUserId: interaction.user.id,
      eventType: "task_completed",
      prevStatus: CLAIM_STATUSES.ACCEPTED,
      nextStatus: CLAIM_STATUSES.SUBMITTED,
      metadata: { via: "button" }
    });

    const dmSent = await sendDmSafe(
      client,
      task.created_by,
      {
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
      },
      { context: "cs-task-complete" }
    );

    setTaskCompletedMetadataStmt.run(null, dmSent ? 1 : 0, dmSent ? 0 : 1, taskId);
    logTaskEvent({
      taskId,
      task,
      actorUserId: interaction.user.id,
      targetUserId: task.created_by,
      eventType: dmSent ? "task_complete_dm_sent" : "task_complete_dm_failed",
      metadata: { via: "button", claimId: claim.id }
    });
    await syncTaskMessage(client, taskId);

    return reply(interaction, {
      content: dmSent
        ? "Completion submitted. The task creator has been asked to verify via DM."
        : "Completion submitted. The creator could not be reached via DM, so the task is pending admin/creator review via /task-approve or /task-deny.",
      ephemeral: true
    });
  }

  async function handleCancel(interaction, { client }) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_CANCEL_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid task action.", ephemeral: true });

    const task = getTaskByIdStmt.get(taskId);
    if (!task || task.is_archived) {
      return reply(interaction, { content: "Task not found.", ephemeral: true });
    }

    const claim = getClaimByTaskAndUserStmt.get(taskId, interaction.user.id);
    const canOverride = canManageTask(interaction, task);
    if (!claim || claim.status !== CLAIM_STATUSES.ACCEPTED) {
      return reply(interaction, {
        content: "You can only cancel a task you currently have accepted.",
        ephemeral: true
      });
    }

    if (claim.user_id !== interaction.user.id && !canOverride) {
      return reply(interaction, {
        content: "Only the assignee can cancel this claim.",
        ephemeral: true
      });
    }

    setClaimStatusStmt.run(CLAIM_STATUSES.CANCELLED, claim.id);
    logTaskEvent({
      taskId,
      task,
      actorUserId: interaction.user.id,
      targetUserId: claim.user_id,
      eventType: "task_claim_cancelled",
      prevStatus: CLAIM_STATUSES.ACCEPTED,
      nextStatus: CLAIM_STATUSES.CANCELLED,
      metadata: { via: "button" }
    });
    if (task.assignee_id === claim.user_id) {
      setTaskReassignStmt.run(null, null, taskId);
    }
    await syncTaskMessage(client, taskId);

    return reply(interaction, {
      content: "The claim has been cancelled.",
      ephemeral: true
    });
  }

  async function handleEdit(interaction) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_EDIT_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid task action.", ephemeral: true });

    const task = getTaskByIdStmt.get(taskId);
    if (!task) {
      return reply(interaction, { content: "Task not found.", ephemeral: true });
    }

    if (!canManageTask(interaction, task)) {
      return reply(interaction, { content: "Only the task creator or an admin can edit this task.", ephemeral: true });
    }

    const latestClaim = getLatestClaimStmt.get(task.id);
    const isOwnerAdmin = isOwnerOrAdmin(interaction);
    if (
      latestClaim &&
      [CLAIM_STATUSES.SUBMITTED, CLAIM_STATUSES.APPROVING, CLAIM_STATUSES.APPROVED].includes(latestClaim.status) &&
      !isOwnerAdmin
    ) {
      return reply(interaction, { content: "This task can no longer be edited at this stage.", ephemeral: true });
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

  async function handleApproveClaim({ interaction, client, claimId, source = "cs_task_approve", trigger = "unknown" }) {
    const row = getClaimWithTaskStmt.get(claimId);
    if (!row) return reply(interaction, { content: "Task submission not found.", ephemeral: true });

    const task = getTaskByIdStmt.get(row.task_id);
    if (!task || task.is_archived) {
      return reply(interaction, { content: "Task not found.", ephemeral: true });
    }

    if (!canManageTask(interaction, task)) {
      return reply(interaction, { content: "Only the task creator or an admin can approve this submission.", ephemeral: true });
    }

    if (row.claim_status === CLAIM_STATUSES.APPROVED || row.payout_state === CLAIM_PAYOUT_STATES.FINALIZED) {
      logTaskEvent({
        taskId: row.task_id,
        task,
        actorUserId: interaction.user.id,
        targetUserId: row.claimer_id,
        eventType: "duplicate_approval_blocked",
        metadata: { trigger, claimId, reason: "already_finalized" }
      });
      return reply(interaction, { content: "This submission has already been approved.", ephemeral: true });
    }

    if (row.claim_status === CLAIM_STATUSES.DENIED) {
      return reply(interaction, {
        content: "This submission is already denied. Reopen flow is required before approving.",
        ephemeral: true
      });
    }

    if (![CLAIM_STATUSES.SUBMITTED, CLAIM_STATUSES.APPROVING].includes(row.claim_status)) {
      return reply(interaction, { content: "This submission is no longer pending approval.", ephemeral: true });
    }

    if (
      [CLAIM_PAYOUT_STATES.IN_PROGRESS, CLAIM_PAYOUT_STATES.SUCCEEDED, CLAIM_PAYOUT_STATES.NEEDS_RECONCILIATION].includes(
        row.payout_state
      )
    ) {
      logTaskEvent({
        taskId: row.task_id,
        task,
        actorUserId: interaction.user.id,
        targetUserId: row.claimer_id,
        eventType: "payout_already_recorded",
        metadata: { trigger, claimId, payoutState: row.payout_state }
      });
      return reply(interaction, {
        content:
          row.payout_state === CLAIM_PAYOUT_STATES.NEEDS_RECONCILIATION
            ? "Payout was already recorded and this task needs reconciliation. Use /task-reconcile."
            : "Payout state is already recorded for this submission. No additional payout will be attempted.",
        ephemeral: true
      });
    }

    const preApprovalStatus = row.claim_status;

    if (row.claim_status === CLAIM_STATUSES.SUBMITTED) {
      const markResult = tryMarkApprovingStmt.run(claimId);
      if (markResult.changes === 0) {
        return reply(interaction, { content: "This submission is no longer pending.", ephemeral: true });
      }
    }

    logTaskEvent({
      taskId: row.task_id,
      task,
      actorUserId: interaction.user.id,
      targetUserId: row.claimer_id,
      eventType: "task_approval_started",
      prevStatus: preApprovalStatus,
      nextStatus: CLAIM_STATUSES.APPROVING,
      metadata: { trigger, claimId }
    });

    let award;
    try {
      const payoutStartResult = markClaimPayoutStartedStmt.run(claimId);
      if (payoutStartResult.changes === 0) {
        logTaskEvent({
          taskId: row.task_id,
          task,
          actorUserId: interaction.user.id,
          targetUserId: row.claimer_id,
          eventType: "duplicate_approval_blocked",
          metadata: { trigger, claimId, reason: "payout_state_not_none" }
        });
        return reply(interaction, {
          content: "This submission is already processing payout or has a payout record. No duplicate payout was performed.",
          ephemeral: true
        });
      }

      logTaskEvent({
        taskId: row.task_id,
        task,
        actorUserId: interaction.user.id,
        targetUserId: row.claimer_id,
        eventType: "payout_started",
        metadata: { trigger, source, claimId, amount: row.coin_reward }
      });

      award = applyCoinDelta({
        guildId: row.guild_id,
        userId: row.claimer_id,
        amount: row.coin_reward,
        reason: `Approved CS task #${row.task_id}`,
        createdBy: interaction.user.id,
        source
      });
      markClaimPayoutSucceededStmt.run(claimId);

    } catch (error) {
      setClaimStatusExactStmt.run(preApprovalStatus, claimId);
      resetClaimPayoutStateStmt.run(claimId);
      logTaskEvent({
        taskId: row.task_id,
        task,
        actorUserId: interaction.user.id,
        targetUserId: row.claimer_id,
        eventType: "payout_failed",
        prevStatus: CLAIM_STATUSES.APPROVING,
        nextStatus: preApprovalStatus,
        metadata: { trigger, source, claimId, message: error?.message || "unknown error", rollback: true }
      });

      return reply(interaction, {
        content: "Approval could not be completed because payout failed. The submission was rolled back to its previous state.",
        ephemeral: true
      });
    }

    logTaskEvent({
      taskId: row.task_id,
      task,
      actorUserId: interaction.user.id,
      targetUserId: row.claimer_id,
      eventType: "task_finalization_started",
      prevStatus: CLAIM_STATUSES.APPROVING,
      nextStatus: CLAIM_STATUSES.APPROVED,
      metadata: { trigger, claimId }
    });

    try {
      const finalizeResult = finalizeApprovedClaimStmt.run(interaction.user.id, row.coin_reward, claimId);
      if (finalizeResult.changes === 0) {
        throw new Error("Could not finalize task approval state.");
      }

      setTaskApprovalMetadataStmt.run(interaction.user.id, row.task_id);
      markClaimPayoutFinalizedStmt.run(claimId);
    } catch (error) {
      markClaimNeedsReconciliationStmt.run(error?.message || "finalization_failed", claimId);
      logTaskEvent({
        taskId: row.task_id,
        task,
        actorUserId: interaction.user.id,
        targetUserId: row.claimer_id,
        eventType: "task_finalization_failed",
        metadata: { trigger, claimId, message: error?.message || "unknown error" }
      });
      logTaskEvent({
        taskId: row.task_id,
        task,
        actorUserId: interaction.user.id,
        targetUserId: row.claimer_id,
        eventType: "reconciliation_needed",
        metadata: { trigger, claimId, reason: "post_payout_finalization_failed" }
      });

      return reply(interaction, {
        content: "Payout succeeded but task finalization failed. Reconciliation is required with /task-reconcile.",
        ephemeral: true
      });
    }

    logTaskEvent({
      taskId: row.task_id,
      task,
      actorUserId: interaction.user.id,
      targetUserId: row.claimer_id,
      eventType: "payout_succeeded",
      metadata: { trigger, source, claimId, amount: row.coin_reward, balanceAfter: award.balance }
    });
    logTaskEvent({
      taskId: row.task_id,
      task,
      actorUserId: interaction.user.id,
      targetUserId: row.claimer_id,
      eventType: "task_approved",
      prevStatus: CLAIM_STATUSES.APPROVING,
      nextStatus: CLAIM_STATUSES.APPROVED,
      metadata: { trigger, claimId }
    });
    logTaskEvent({
      taskId: row.task_id,
      task,
      actorUserId: interaction.user.id,
      targetUserId: row.claimer_id,
      eventType: "task_finalization_succeeded",
      metadata: { trigger, claimId }
    });
    if (row.task_type === "single") {
      setTaskClosedStmt.run(TASK_STATUSES.CLOSED, interaction.user.id, row.task_id);
    }

    await syncTaskMessage(client, row.task_id);

    await syncLeaderboardMessage({
      client,
      guildId: row.guild_id,
      channelId: config.leaderboardChannelId,
      forcePost: false
    }).catch((error) => {
      logTaskEvent({
        taskId: row.task_id,
        task,
        actorUserId: interaction.user.id,
        eventType: "leaderboard_sync_failed",
        metadata: { message: error?.message || "unknown error", trigger }
      });
      return null;
    });

    await sendDmSafe(
      client,
      row.claimer_id,
      {
        embeds: [
          makeEmbed({
            title: "Task approved",
            description: `Your completion for Task #${row.task_id} was approved. You earned **${coinsDisplay(row.coin_reward)}**.`,
            fields: [{ name: "New Balance", value: coinsDisplay(award.balance), inline: true }]
          })
        ]
      },
      { context: "cs-task-approved" }
    );

    return reply(interaction, { content: "Task approved and coins were awarded.", ephemeral: true });
  }

  async function handleApprove(interaction, { client }) {
    const claimId = parseIdFromPrefix(interaction.customId, TASK_APPROVE_PREFIX);
    if (!claimId) return reply(interaction, { content: "Invalid approval action.", ephemeral: true });
    return handleApproveClaim({ interaction, client, claimId, source: "cs_task_approve", trigger: "dm_button" });
  }

  async function handleDenyClaim({ interaction, client, claimId, trigger = "unknown" }) {
    const row = getClaimWithTaskStmt.get(claimId);
    if (!row) return reply(interaction, { content: "Task submission not found.", ephemeral: true });

    const task = getTaskByIdStmt.get(row.task_id);
    if (!task || task.is_archived) return reply(interaction, { content: "Task not found.", ephemeral: true });

    if (!canManageTask(interaction, task)) {
      return reply(interaction, { content: "Only the task creator or an admin can deny this submission.", ephemeral: true });
    }

    if (row.claim_status === CLAIM_STATUSES.APPROVED) {
      return reply(interaction, { content: "Cannot deny a submission that is already approved.", ephemeral: true });
    }

    if (row.claim_status === CLAIM_STATUSES.DENIED) {
      return reply(interaction, { content: "This submission is already denied.", ephemeral: true });
    }

    const denyResult = markDeniedClaimStmt.run(interaction.user.id, claimId);
    if (denyResult.changes === 0) {
      return reply(interaction, { content: "This submission is no longer pending.", ephemeral: true });
    }

    setTaskDenialMetadataStmt.run(interaction.user.id, row.task_id);
    logTaskEvent({
      taskId: row.task_id,
      task,
      actorUserId: interaction.user.id,
      targetUserId: row.claimer_id,
      eventType: "task_denied",
      prevStatus: row.claim_status,
      nextStatus: CLAIM_STATUSES.DENIED,
      metadata: { trigger, claimId }
    });
    await syncTaskMessage(client, row.task_id);

    await sendDmSafe(
      client,
      row.claimer_id,
      {
        content: `Your submission for Task #${row.task_id} was denied. Please review the task and try again.`
      },
      { context: "cs-task-denied" }
    );

    return reply(interaction, { content: "Submission denied and user notified.", ephemeral: true });
  }

  async function handleDeny(interaction, { client }) {
    const claimId = parseIdFromPrefix(interaction.customId, TASK_DENY_PREFIX);
    if (!claimId) return reply(interaction, { content: "Invalid deny action.", ephemeral: true });
    return handleDenyClaim({ interaction, client, claimId, trigger: "dm_button" });
  }

  async function handleClose(interaction, { client }) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_CLOSE_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid close action.", ephemeral: true });

    const task = getTaskByIdStmt.get(taskId);
    if (!task) return reply(interaction, { content: "Task not found.", ephemeral: true });

    if (!canManageTask(interaction, task)) {
      return reply(interaction, { content: "Only the creator or an admin can close this task.", ephemeral: true });
    }

    const result = setTaskClosedStmt.run(TASK_STATUSES.CANCELLED, interaction.user.id, task.id);
    if (result.changes === 0) {
      return reply(interaction, { content: "This task is already closed.", ephemeral: true });
    }

    logTaskEvent({
      taskId: task.id,
      task,
      actorUserId: interaction.user.id,
      eventType: "task_closed",
      prevStatus: TASK_STATUSES.OPEN,
      nextStatus: TASK_STATUSES.CANCELLED,
      metadata: { via: "button" }
    });
    await syncTaskMessage(client, task.id);
    return reply(interaction, { content: `Task #${task.id} has been closed.`, ephemeral: true });
  }

  async function handleEditModal(interaction, { client }) {
    const taskId = parseIdFromPrefix(interaction.customId, TASK_EDIT_MODAL_PREFIX);
    if (!taskId) return reply(interaction, { content: "Invalid edit request.", ephemeral: true });

    const task = getTaskByIdStmt.get(taskId);
    if (!task) {
      return reply(interaction, { content: "Task not found.", ephemeral: true });
    }

    if (!canManageTask(interaction, task)) {
      return reply(interaction, { content: "Only the task creator or an admin can edit this task.", ephemeral: true });
    }

    const latestClaim = getLatestClaimStmt.get(task.id);
    if (
      latestClaim &&
      [CLAIM_STATUSES.SUBMITTED, CLAIM_STATUSES.APPROVING, CLAIM_STATUSES.APPROVED].includes(latestClaim.status) &&
      !isOwnerOrAdmin(interaction)
    ) {
      return reply(interaction, { content: "This task can no longer be edited at this stage.", ephemeral: true });
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

    updateTaskBasicStmt.run(truncate(details, 90), details, coinReward, taskId);
    logTaskEvent({
      taskId,
      task,
      actorUserId: interaction.user.id,
      eventType: "task_edited",
      metadata: { via: "modal", coinReward }
    });
    await syncTaskMessage(client, taskId);

    return reply(interaction, { content: "Task updated.", ephemeral: true });
  }

  async function closeTaskByCommand(interaction, { client }) {
    const taskId = interaction.options.getInteger("task_id", true);
    const task = getTaskByIdStmt.get(taskId);
    if (!task) return reply(interaction, { content: "Task not found.", ephemeral: true });

    if (!canManageTask(interaction, task)) {
      return reply(interaction, { content: "Only the task creator or an admin can close tasks.", ephemeral: true });
    }

    const result = setTaskClosedStmt.run(TASK_STATUSES.CANCELLED, interaction.user.id, taskId);
    if (result.changes === 0) {
      return reply(interaction, { content: "Task is already closed or archived.", ephemeral: true });
    }

    logTaskEvent({
      taskId,
      task,
      actorUserId: interaction.user.id,
      eventType: "task_closed",
      prevStatus: TASK_STATUSES.OPEN,
      nextStatus: TASK_STATUSES.CANCELLED,
      metadata: { via: "command" }
    });
    await syncTaskMessage(client, taskId);
    return reply(interaction, { content: `Task #${taskId} closed successfully.`, ephemeral: true });
  }

  async function removeTaskByCommand(interaction, { client }) {
    const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
    if (denied) return denied;

    const taskId = interaction.options.getInteger("task_id", true);
    const task = getTaskByIdStmt.get(taskId);
    if (!task) return reply(interaction, { content: "Task not found.", ephemeral: true });

    const result = archiveTaskStmt.run(interaction.user.id, taskId);
    if (result.changes === 0) {
      return reply(interaction, { content: "Task is already archived.", ephemeral: true });
    }

    logTaskEvent({
      taskId,
      task,
      actorUserId: interaction.user.id,
      eventType: "task_archived",
      prevStatus: task.status,
      nextStatus: TASK_STATUSES.ARCHIVED,
      metadata: { via: "command" }
    });
    await syncTaskMessage(client, taskId);
    return reply(interaction, { content: `Task #${taskId} archived.`, ephemeral: true });
  }

  async function listTasks(interaction) {
    const denied = ensureOwnerOrAdminAccess(interaction);
    if (denied) return denied;

    const statusFilter = interaction.options.getString("status") || "all";
    const user = interaction.options.getUser("user");
    const mine = interaction.options.getBoolean("mine") || false;
    const limit = Math.max(1, Math.min(50, interaction.options.getInteger("limit") || 10));
    const viewMode = interaction.options.getString("view") || "compact";
    const actorId = interaction.user.id;

    const rows = listTasksStmt.all(interaction.guildId || "dm", Math.max(30, limit * 4));
    const filtered = rows.filter((row) => {
      const derived = deriveTaskActivityStatus(row, row.claim_id ? { status: row.claim_status } : null);
      if (statusFilter !== "all" && derived !== statusFilter) return false;
      if (mine && row.created_by !== actorId && row.claim_user_id !== actorId) return false;
      if (user && row.created_by !== user.id && row.claim_user_id !== user.id) return false;
      return true;
    });

    if (!filtered.length) {
      return reply(interaction, { content: "No tasks found for that filter.", ephemeral: true });
    }

    const lines = filtered.slice(0, limit).map((row) => {
      const derived = deriveTaskActivityStatus(row, row.claim_id ? { status: row.claim_status } : null);
      const assignee = row.claim_user_id ? `<@${row.claim_user_id}>` : row.assignee_id ? `<@${row.assignee_id}>` : "—";
      const archived = row.is_archived ? " • Archived" : "";
      const health = payoutHealthLabel(row);
      if (viewMode === "detailed") {
        return `**#${row.id}** • ${truncate(row.title || row.details, 50)}\nStatus: **${humanizeStatus(derived)}${archived}** • Reward: **${coinsDisplay(
          row.coin_reward
        )}**\nPayout Health: **${health}**\nCreator: <@${row.created_by}> • Assignee: ${assignee}\nCreated: ${formatDiscordDate(
          row.created_at
        )} • Updated: ${formatDiscordDate(row.last_updated_at)}`;
      }
      return `**#${row.id}** ${truncate(row.title || row.details, 35)} • ${coinsDisplay(row.coin_reward)}\n${humanizeStatus(
        derived
      )}${archived} • ${health} • <@${row.created_by}> → ${assignee}\nCreated ${formatRelativeDate(
        row.created_at
      )} • Updated ${formatRelativeDate(row.last_updated_at)}`;
    });

    const pages = chunk(lines, viewMode === "detailed" ? 6 : 8);
    const embeds = pages.map((page, idx) =>
      makeEmbed({
        title: `Task list (${viewMode})`,
        description: page.join("\n\n"),
        footer: `Page ${idx + 1}/${pages.length}`
      })
    );

    return reply(interaction, {
      embeds,
      ephemeral: true
    });
  }

  async function reassignTask(interaction, { client }) {
    const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
    if (denied) return denied;

    const taskId = interaction.options.getInteger("task_id", true);
    const member = interaction.options.getUser("member");
    const resetOpen = interaction.options.getBoolean("reset_open") || false;

    const task = getTaskWithLatestClaimStmt.get(taskId);
    if (!task) return reply(interaction, { content: "Task not found.", ephemeral: true });

    if (task.status !== TASK_STATUSES.OPEN || task.is_archived) {
      return reply(interaction, { content: "Only open, non-archived tasks can be reassigned.", ephemeral: true });
    }

    if (resetOpen || !member) {
      const previousAssignee = task.claim_user_id || task.assignee_id || null;
      if (task.claim_id && !TERMINAL_CLAIM_STATUSES.has(task.claim_status)) {
        setClaimStatusStmt.run(CLAIM_STATUSES.CANCELLED, task.claim_id);
      }
      setTaskReassignStmt.run(null, null, taskId);
      logTaskEvent({
        taskId,
        task,
        actorUserId: interaction.user.id,
        targetUserId: previousAssignee,
        eventType: "task_reassigned",
        prevStatus: task.claim_status || null,
        nextStatus: null,
        metadata: { mode: "reset_open" }
      });
      await syncTaskMessage(client, taskId);
      return reply(interaction, { content: `Task #${taskId} is now open with no assignee.`, ephemeral: true });
    }

    if (task.claim_id && !TERMINAL_CLAIM_STATUSES.has(task.claim_status)) {
      setClaimStatusStmt.run(CLAIM_STATUSES.CANCELLED, task.claim_id);
    }

    const existing = getClaimByTaskAndUserStmt.get(taskId, member.id);
    if (existing) {
      setClaimStatusStmt.run(CLAIM_STATUSES.ACCEPTED, existing.id);
    } else {
      createClaimStmt.run(taskId, task.guild_id, member.id);
    }

    setTaskReassignStmt.run(member.id, member.id, taskId);
    logTaskEvent({
      taskId,
      task,
      actorUserId: interaction.user.id,
      targetUserId: member.id,
      eventType: "task_reassigned",
      prevStatus: task.claim_status || null,
      nextStatus: CLAIM_STATUSES.ACCEPTED,
      metadata: { mode: "assign" }
    });
    await syncTaskMessage(client, taskId);
    return reply(interaction, { content: `Task #${taskId} has been reassigned to ${member}.`, ephemeral: true });
  }

  async function reconcileTaskCommand(interaction, { client }) {
    const denied = ensureOwnerOrAdminAccess(interaction);
    if (denied) return denied;

    const taskId = interaction.options.getInteger("task_id", true);
    const dryRun = interaction.options.getBoolean("dry_run") || false;
    const row = getReconClaimByTaskStmt.get(taskId);
    if (!row) {
      return reply(interaction, { content: "Task not found or no claim exists for reconciliation.", ephemeral: true });
    }

    const task = getTaskByIdStmt.get(taskId);
    if (!task) return reply(interaction, { content: "Task not found.", ephemeral: true });

    if (row.payout_state === CLAIM_PAYOUT_STATES.FINALIZED || row.claim_status === CLAIM_STATUSES.APPROVED) {
      return reply(interaction, { content: "Task is already fully finalized. No reconciliation needed.", ephemeral: true });
    }

    if (![CLAIM_PAYOUT_STATES.SUCCEEDED, CLAIM_PAYOUT_STATES.NEEDS_RECONCILIATION].includes(row.payout_state)) {
      return reply(
        interaction,
        { content: `Task is not eligible for reconciliation (payout state: ${row.payout_state || "none"}).`, ephemeral: true }
      );
    }

    if (dryRun) {
      return reply(interaction, {
        embeds: [
          makeEmbed({
            title: `Task #${taskId} reconcile dry-run`,
            description: [
              "No data was mutated.",
              `Claim #${row.claim_id} is eligible for reconciliation.`,
              `Current claim status: **${humanizeStatus(row.claim_status)}**`,
              `Current payout state: **${humanizeStatus(row.payout_state)}**`,
              "Would perform: finalize claim -> set payout finalized -> update task approval metadata -> sync task/leaderboard."
            ].join("\n")
          })
        ],
        ephemeral: true
      });
    }

    logTaskEvent({
      taskId,
      task,
      actorUserId: interaction.user.id,
      targetUserId: row.claimer_id,
      eventType: "reconciliation_started",
      metadata: { claimId: row.claim_id, payoutState: row.payout_state }
    });

    try {
      let workingStatus = row.claim_status;
      if (row.claim_status === CLAIM_STATUSES.SUBMITTED) {
        const moved = tryMarkApprovingStmt.run(row.claim_id);
        if (moved.changes === 0) {
          throw new Error("Could not move submitted claim into approving for reconciliation.");
        }
        workingStatus = CLAIM_STATUSES.APPROVING;
      }

      if (![CLAIM_STATUSES.APPROVING, CLAIM_STATUSES.APPROVED].includes(workingStatus)) {
        throw new Error(`Claim status ${workingStatus} cannot be reconciled safely.`);
      }

      if (workingStatus !== CLAIM_STATUSES.APPROVED) {
        const finalizeResult = finalizeApprovedClaimStmt.run(interaction.user.id, task.coin_reward, row.claim_id);
        if (finalizeResult.changes === 0) {
          throw new Error("Could not finalize reconciled claim state.");
        }
      }

      setTaskApprovalMetadataStmt.run(interaction.user.id, taskId);
      if (task.task_type === "single") {
        setTaskClosedStmt.run(TASK_STATUSES.CLOSED, interaction.user.id, taskId);
      }
      markClaimPayoutFinalizedStmt.run(row.claim_id);

      logTaskEvent({
        taskId,
        task,
        actorUserId: interaction.user.id,
        targetUserId: row.claimer_id,
        eventType: "reconciliation_succeeded",
        metadata: { claimId: row.claim_id }
      });

      await syncTaskMessage(client, taskId);
      await syncLeaderboardMessage({
        client,
        guildId: row.guild_id,
        channelId: config.leaderboardChannelId,
        forcePost: false
      }).catch((error) => {
        logTaskEvent({
          taskId,
          task,
          actorUserId: interaction.user.id,
          eventType: "leaderboard_sync_failed",
          metadata: { message: error?.message || "unknown error", trigger: "reconcile" }
        });
        return null;
      });

      return reply(interaction, { content: `Task #${taskId} was reconciled and finalized without re-paying.`, ephemeral: true });
    } catch (error) {
      markClaimNeedsReconciliationStmt.run(error?.message || "reconciliation_failed", row.claim_id);
      logTaskEvent({
        taskId,
        task,
        actorUserId: interaction.user.id,
        targetUserId: row.claimer_id,
        eventType: "reconciliation_failed",
        metadata: { claimId: row.claim_id, message: error?.message || "unknown error" }
      });
      return reply(interaction, { content: `Reconciliation failed: ${error?.message || "unknown error"}`, ephemeral: true });
    }
  }

  async function listReconcileTasksCommand(interaction) {
    const denied = ensureOwnerOrAdminAccess(interaction);
    if (denied) return denied;

    const rows = listClaimsNeedingReconcileStmt.all(interaction.guildId || "dm", 20);
    if (!rows.length) {
      return reply(interaction, { content: "No tasks currently need reconciliation.", ephemeral: true });
    }

    const description = rows
      .map((row) => {
        const assignee = row.claim_user_id || row.assignee_id || "unknown";
        return `**#${row.task_id}** ${truncate(row.title, 40)} • ${coinsDisplay(row.coin_reward)}\nAssignee: <@${assignee}> • Payout: **${humanizeStatus(
          row.payout_state
        )}**\nFlagged: ${formatDiscordDate(row.reconciliation_needed_at)} (${formatRelativeDate(
          row.reconciliation_needed_at
        )})\nReason: ${truncate(row.reconciliation_reason || "finalization incomplete", 100)}`;
      })
      .join("\n\n");

    return reply(interaction, {
      embeds: [makeEmbed({ title: "Tasks needing reconciliation", description })],
      ephemeral: true
    });
  }

  async function approveTaskCommand(interaction, { client }) {
    const taskId = interaction.options.getInteger("task_id", true);
    const task = getTaskWithLatestClaimStmt.get(taskId);
    if (!task || !task.claim_id) {
      return reply(interaction, { content: "No pending submission found for that task.", ephemeral: true });
    }
    return handleApproveClaim({ interaction, client, claimId: task.claim_id, source: "cs_task_approve", trigger: "command" });
  }

  async function denyTaskCommand(interaction, { client }) {
    const taskId = interaction.options.getInteger("task_id", true);
    const task = getTaskWithLatestClaimStmt.get(taskId);
    if (!task || !task.claim_id) {
      return reply(interaction, { content: "No pending submission found for that task.", ephemeral: true });
    }
    return handleDenyClaim({ interaction, client, claimId: task.claim_id, trigger: "command" });
  }

  async function taskHistoryCommand(interaction) {
    const denied = ensureOwnerOrAdminAccess(interaction);
    if (denied) return denied;

    const taskId = interaction.options.getInteger("task_id", true);
    const task = getTaskByIdStmt.get(taskId);
    if (!task) return reply(interaction, { content: "Task not found.", ephemeral: true });

    const events = listTaskEventsStmt.all(taskId, TASK_EVENT_LIMIT);
    if (!events.length) {
      return reply(interaction, { content: "No history found for that task yet.", ephemeral: true });
    }

    const description = events
      .map((event) => {
        const actor = event.actor_user_id ? `<@${event.actor_user_id}>` : "system";
        const target = event.target_user_id ? ` → <@${event.target_user_id}>` : "";
        const transition =
          event.prev_status || event.next_status
            ? ` (${event.prev_status || "—"} → ${event.next_status || "—"})`
            : "";
        let metaSnippet = "";
        if (event.metadata_json) {
          try {
            const parsed = JSON.parse(event.metadata_json);
            const compact = truncate(
              Object.entries(parsed)
                .slice(0, 3)
                .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : String(v)}`)
                .join(", "),
              120
            );
            metaSnippet = compact ? `\n↳ ${compact}` : "";
          } catch {
            metaSnippet = `\n↳ ${truncate(event.metadata_json, 120)}`;
          }
        }
        return `${formatEventTimestamp(event.created_at)} • **${event.event_type}**${transition}\nActor: ${actor}${target}${metaSnippet}`;
      })
      .join("\n\n");

    return reply(interaction, {
      embeds: [
        makeEmbed({
          title: `Task #${taskId} history`,
          description: `${description}${events.length >= TASK_EVENT_LIMIT ? "\n\n*Showing most recent events (truncated).*" : ""}`
        })
      ],
      ephemeral: true
    });
  }

  async function taskViewCommand(interaction) {
    const denied = ensureOwnerOrAdminAccess(interaction);
    if (denied) return denied;

    const taskId = interaction.options.getInteger("task_id", true);
    const task = getTaskByIdStmt.get(taskId);
    if (!task) return reply(interaction, { content: "Task not found.", ephemeral: true });
    const claim = getLatestClaimStmt.get(taskId);

    const assignee = claim?.user_id || task.assignee_id || null;
    const embed = makeEmbed({
      title: `Task #${task.id} operational view`,
      description: `${truncate(task.title, 90)}\n${task.details}`,
      fields: [
        { name: "Reward", value: coinsDisplay(task.coin_reward), inline: true },
        { name: "Task Status", value: humanizeStatus(task.status), inline: true },
        { name: "Archived", value: task.is_archived ? "Yes" : "No", inline: true },
        { name: "Creator", value: `<@${task.created_by}>`, inline: true },
        { name: "Assignee", value: assignee ? `<@${assignee}>` : "—", inline: true },
        { name: "Claim Status", value: claim ? humanizeStatus(claim.status) : "No claims", inline: true },
        { name: "Payout State", value: claim ? humanizeStatus(claim.payout_state || CLAIM_PAYOUT_STATES.NONE) : "None", inline: true },
        {
          name: "Reconciliation",
          value: claim?.reconciliation_needed ? `Needed (${truncate(claim.reconciliation_reason || "unspecified", 80)})` : "Not needed",
          inline: true
        },
        { name: "DM Accept Sent", value: task.dm_accept_sent ? "Yes" : "No", inline: true },
        { name: "DM Complete Sent", value: task.dm_complete_sent ? "Yes" : "No", inline: true },
        { name: "DM Complete Failed", value: task.dm_complete_failed ? "Yes" : "No", inline: true },
        { name: "Created", value: formatDiscordDate(task.created_at), inline: true },
        { name: "Updated", value: formatDiscordDate(task.last_updated_at), inline: true },
        { name: "Accepted", value: formatDiscordDate(task.accepted_at), inline: true },
        { name: "Completed", value: formatDiscordDate(task.completed_at), inline: true },
        { name: "Approved", value: formatDiscordDate(task.approved_at), inline: true },
        { name: "Denied", value: formatDiscordDate(task.denied_at), inline: true },
        { name: "Cancelled", value: formatDiscordDate(task.cancelled_at), inline: true },
        { name: "Channel ID", value: task.channel_id || "—", inline: true },
        { name: "Message ID", value: task.message_id || "—", inline: true }
      ]
    });

    return reply(interaction, { embeds: [embed], ephemeral: true });
  }

  const commands = [
    {
      data: new SlashCommandBuilder()
        .setName("add-task")
        .setDescription("Create a Closet Share task event. Owner only.")
        .addStringOption((option) =>
          option
            .setName("title")
            .setDescription("Short task title")
            .setRequired(true)
            .setMaxLength(90)
        )
        .addStringOption((option) =>
          option
            .setName("details")
            .setDescription("Task details for members")
            .setRequired(true)
            .setMaxLength(1000)
        )
        .addIntegerOption((option) =>
          option
            .setName("coins")
            .setDescription("Coins earned when approved")
            .setRequired(true)
            .setMinValue(1)
        )
        .addStringOption((option) =>
          option
            .setName("type")
            .setDescription("Task type")
            .setRequired(true)
            .addChoices(
              { name: "Single", value: "single" },
              { name: "Multiple", value: "multiple" }
            )
        ),
      async execute(interaction) {
        const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
        if (denied) return denied;

        if (!interaction.inGuild() || !interaction.channel || typeof interaction.channel.send !== "function") {
          return reply(interaction, { content: "This command can only be used in a server text channel.", ephemeral: true });
        }
        if (config.csTaskChannelId && interaction.channelId !== config.csTaskChannelId) {
          return reply(interaction, {
            content: `Tasks can only be created in <#${config.csTaskChannelId}>.`,
            ephemeral: true
          });
        }

        const title = truncate(interaction.options.getString("title", true).trim(), 90);
        const details = interaction.options.getString("details", true).trim();
        const coinReward = interaction.options.getInteger("coins", true);
        const taskType = interaction.options.getString("type", true);

        const result = insertTaskStmt.run(
          interaction.guildId,
          interaction.channelId,
          taskType,
          title,
          details,
          coinReward,
          interaction.user.id
        );

        const taskId = Number(result.lastInsertRowid);
        const task = getTaskByIdStmt.get(taskId);
        const payload = makeTaskMessagePayload(task, getTaskStats(taskId), null);

        const taskMessage = await interaction.channel.send(payload);
        setTaskMessageStmt.run(taskMessage.id, taskId);
        logTaskEvent({
          taskId,
          actorUserId: interaction.user.id,
          eventType: "task_created",
          nextStatus: TASK_STATUSES.OPEN,
          metadata: { taskType, coinReward, via: "command" }
        });

        return reply(interaction, {
          content: `Task #${taskId} created in <#${interaction.channelId}>.`,
          ephemeral: true
        });
      }
    },
    {
      data: new SlashCommandBuilder()
        .setName("tasks-list")
        .setDescription("List Closet Share tasks with filters.")
        .addStringOption((option) =>
          option
            .setName("status")
            .setDescription("Filter by status")
            .setRequired(false)
            .addChoices(
              { name: "Active", value: "active" },
              { name: "Accepted", value: "accepted" },
              { name: "Pending approval", value: "pending_approval" },
              { name: "Approved", value: "approved" },
              { name: "Denied", value: "denied" },
              { name: "Cancelled", value: "cancelled" },
              { name: "All", value: "all" }
            )
        )
        .addUserOption((option) => option.setName("user").setDescription("Filter by creator/assignee").setRequired(false))
        .addBooleanOption((option) => option.setName("mine").setDescription("Only include tasks involving you").setRequired(false))
        .addStringOption((option) =>
          option
            .setName("view")
            .setDescription("Display density")
            .setRequired(false)
            .addChoices(
              { name: "Compact", value: "compact" },
              { name: "Detailed", value: "detailed" }
            )
        )
        .addIntegerOption((option) => option.setName("limit").setDescription("How many tasks to show").setMinValue(1).setMaxValue(50)),
      execute: listTasks
    },
    {
      data: new SlashCommandBuilder()
        .setName("task-remove")
        .setDescription("Archive a task by ID. Owner only.")
        .addIntegerOption((option) => option.setName("task_id").setDescription("Task ID").setRequired(true).setMinValue(1)),
      execute: removeTaskByCommand
    },
    {
      data: new SlashCommandBuilder()
        .setName("task-close")
        .setDescription("Close a task without deleting it.")
        .addIntegerOption((option) => option.setName("task_id").setDescription("Task ID").setRequired(true).setMinValue(1)),
      execute: closeTaskByCommand
    },
    {
      data: new SlashCommandBuilder()
        .setName("task-reassign")
        .setDescription("Reassign an accepted task or reset it to open. Owner only.")
        .addIntegerOption((option) => option.setName("task_id").setDescription("Task ID").setRequired(true).setMinValue(1))
        .addUserOption((option) => option.setName("member").setDescription("New assignee").setRequired(false))
        .addBooleanOption((option) => option.setName("reset_open").setDescription("Reset task to open with no assignee")),
      execute: reassignTask
    },
    {
      data: new SlashCommandBuilder()
        .setName("task-approve")
        .setDescription("Approve a pending task completion by task ID.")
        .addIntegerOption((option) => option.setName("task_id").setDescription("Task ID").setRequired(true).setMinValue(1)),
      execute: approveTaskCommand
    },
    {
      data: new SlashCommandBuilder()
        .setName("task-deny")
        .setDescription("Deny a pending task completion by task ID.")
        .addIntegerOption((option) => option.setName("task_id").setDescription("Task ID").setRequired(true).setMinValue(1)),
      execute: denyTaskCommand
    },
    {
      data: new SlashCommandBuilder()
        .setName("task-history")
        .setDescription("Show recent immutable history events for a task. Owner only.")
        .addIntegerOption((option) => option.setName("task_id").setDescription("Task ID").setRequired(true).setMinValue(1)),
      execute: taskHistoryCommand
    },
    {
      data: new SlashCommandBuilder()
        .setName("task-view")
        .setDescription("Show full operational state for one task. Owner only.")
        .addIntegerOption((option) => option.setName("task_id").setDescription("Task ID").setRequired(true).setMinValue(1)),
      execute: taskViewCommand
    },
    {
      data: new SlashCommandBuilder()
        .setName("task-reconcile")
        .setDescription("Repair a task with payout-finalization mismatch. Owner only.")
        .addIntegerOption((option) => option.setName("task_id").setDescription("Task ID").setRequired(true).setMinValue(1))
        .addBooleanOption((option) =>
          option.setName("dry_run").setDescription("Preview what would be repaired without making changes")
        ),
      execute: reconcileTaskCommand
    },
    {
      data: new SlashCommandBuilder()
        .setName("tasks-reconcile-list")
        .setDescription("List tasks currently requiring reconciliation. Owner only."),
      execute: listReconcileTasksCommand
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
      customId: /^cs-task:close:\d+$/,
      execute: handleClose
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
    modals,
    async onReady({ client }) {
      const rows = db
        .prepare("SELECT id FROM cs_tasks WHERE message_id IS NOT NULL AND is_archived = 0 ORDER BY id DESC LIMIT 200")
        .all();
      for (const row of rows) {
        await syncTaskMessage(client, row.id);
      }
    }
  };
}

module.exports = { createFeature };
