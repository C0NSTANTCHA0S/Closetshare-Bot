const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  SlashCommandBuilder
} = require("discord.js");
const { config } = require("../../core/config");
const { applyCoinDelta } = require("../../core/economy-db");
const { syncLeaderboardMessage } = require("../../core/economy-leaderboard");
const { ensureOwnerAccess, makeEmbed, reply, safeEmbedUrl } = require("../../core/discord-helpers");

const DAILY_SIGNIN_PREFIX = "daily_signin:";
const DAILY_UNAVAILABLE_PREFIX = "daily_unavailable:";
const DAILY_CANCEL_PREFIX = "daily_cancel:";
const DAILY_APPROVE_PREFIX = "daily_approve:";
const DAILY_REJECT_PREFIX = "daily_reject:";

const SHIFT_REWARD_COINS = Math.max(1, Number(config.shiftPayoutCoins) || 15);
const AUTOPOST_LEAD_MINUTES = Math.max(0, Number(config.shiftAutopostLeadMinutes) || 15);
const SCHEDULER_INTERVAL_MS = 60_000;
const STATUS_COLORS = {
  scheduled: 0x2b7fff,
  approved: 0x2ecc71,
  rejected: 0xf1c40f,
  cancelled: 0xe74c3c
};

function parseClockMinutes(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function parseShiftWindows(raw) {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((window, index) => {
        const key = String(window?.key || `shift-${index + 1}`)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9_-]/g, "-");
        const label = String(window?.label || window?.key || `Shift ${index + 1}`).trim();
        const startMinutes = parseClockMinutes(window?.start);
        const endMinutes = parseClockMinutes(window?.end);
        if (!key || startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
          return null;
        }
        return {
          key,
          label: label.slice(0, 100),
          startMinutes,
          endMinutes
        };
      })
      .filter(Boolean)
      .slice(0, 25)
      .sort((a, b) => a.startMinutes - b.startMinutes);
  } catch {
    return [];
  }
}

const SHIFT_WINDOWS = parseShiftWindows(config.shiftWindowsJson);

function getLocalParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour: Number(map.hour),
    minute: Number(map.minute)
  };
}

function getDateKey(date, timeZone) {
  const parts = getLocalParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
}

function getMonthKey(date, timeZone) {
  const parts = getLocalParts(date, timeZone);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}`;
}

function getMinutesIntoDay(date, timeZone) {
  const parts = getLocalParts(date, timeZone);
  return parts.hour * 60 + parts.minute;
}

function formatClock(minutes) {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${suffix}`;
}

function formatShiftRange(shift) {
  return `${formatClock(shift.start_minutes)} - ${formatClock(shift.end_minutes)}`;
}

function parseDateTimeInput(value) {
  const raw = String(value || "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  if (!year || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  return `${match[1]}-${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

function buildDailyShiftPayload(shift, signInCount = 0) {
  const status = String(shift.status || "scheduled").toLowerCase();
  const isLocked = status !== "scheduled";
  const signInLocked = isLocked || signInCount > 0;
  const statusText = status.charAt(0).toUpperCase() + status.slice(1);

  const embed = makeEmbed({
    title: "Daily Shift Report",
    description:
      "Closet Share Volunteers can sign in for this shift using the button below.\n\n" +
      `**Shift:** ${shift.shift_key}\n` +
      `**Date:** ${shift.shift_date}\n` +
      `**Time:** ${formatShiftRange(shift)} (${config.shiftTimezone})\n` +
      `**Sign-ins:** ${signInCount}\n` +
      `**Status:** ${statusText}`,
    color: STATUS_COLORS[status] || STATUS_COLORS.scheduled,
    fields: [
      {
        name: "Payout Policy",
        value: `After owner verification, approved volunteers receive **${SHIFT_REWARD_COINS} coins**.`
      }
    ]
  });

  const thumbnailUrl = safeEmbedUrl(config.dailyLoginThumbnailUrl);
  const imageUrl = safeEmbedUrl(config.dailyLoginImageUrl);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (imageUrl) embed.setImage(imageUrl);

  const actions = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${DAILY_SIGNIN_PREFIX}${shift.id}`)
      .setLabel("Sign In")
      .setStyle(ButtonStyle.Success)
      .setDisabled(signInLocked),
    new ButtonBuilder()
      .setCustomId(`${DAILY_UNAVAILABLE_PREFIX}${shift.id}`)
      .setLabel("Not Available")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isLocked),
    new ButtonBuilder()
      .setCustomId(`${DAILY_CANCEL_PREFIX}${shift.id}`)
      .setLabel("Cancel Shift")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(isLocked)
  );

  return { embeds: [embed], components: [actions] };
}

function buildEventPayload({ title, description, startAt, endAt }) {
  const embed = makeEmbed({
    title: title || "Closet Share Event",
    description:
      `${description || "Special volunteer event shift."}\n\n` +
      `**Start:** ${startAt} (${config.shiftTimezone})\n` +
      `**Finish:** ${endAt} (${config.shiftTimezone})\n` +
      `**Status:** Scheduled`,
    color: STATUS_COLORS.scheduled
  });

  const thumbnailUrl = safeEmbedUrl(config.dailyLoginThumbnailUrl);
  const imageUrl = safeEmbedUrl(config.dailyLoginImageUrl);
  if (thumbnailUrl) embed.setThumbnail(thumbnailUrl);
  if (imageUrl) embed.setImage(imageUrl);

  return { embeds: [embed] };
}

function createFeature({ featureSlug, createFeatureDb }) {
  const { db, dbPath } = createFeatureDb(featureSlug, "shift-reports.sqlite");

  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS daily_shifts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      shift_date TEXT NOT NULL,
      shift_key TEXT NOT NULL,
      start_minutes INTEGER NOT NULL,
      end_minutes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      post_channel_id TEXT,
      post_message_id TEXT,
      posted_at TEXT,
      review_requested_at TEXT,
      reviewed_at TEXT,
      reviewed_by TEXT,
      review_notes TEXT,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (guild_id, shift_date, shift_key)
    );

    CREATE TABLE IF NOT EXISTS shift_signins (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      signed_in_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (shift_id, user_id),
      FOREIGN KEY (shift_id) REFERENCES daily_shifts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shift_payouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      coins_awarded INTEGER NOT NULL,
      awarded_by TEXT NOT NULL,
      awarded_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (shift_id, user_id),
      FOREIGN KEY (shift_id) REFERENCES daily_shifts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shift_unavailability (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shift_id INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (shift_id) REFERENCES daily_shifts(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS shift_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      start_at TEXT NOT NULL,
      end_at TEXT NOT NULL,
      post_channel_id TEXT,
      post_message_id TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_daily_shifts_guild_date
      ON daily_shifts (guild_id, shift_date, shift_key);

    CREATE INDEX IF NOT EXISTS idx_daily_shifts_status
      ON daily_shifts (guild_id, status, review_requested_at);

    CREATE INDEX IF NOT EXISTS idx_shift_signins_shift
      ON shift_signins (shift_id, signed_in_at);
  `);

  const insertShiftStmt = db.prepare(`
    INSERT INTO daily_shifts (
      guild_id, shift_date, shift_key, start_minutes, end_minutes, status, created_by
    ) VALUES (?, ?, ?, ?, ?, 'scheduled', ?)
    ON CONFLICT(guild_id, shift_date, shift_key) DO UPDATE SET
      start_minutes = excluded.start_minutes,
      end_minutes = excluded.end_minutes
    RETURNING id, guild_id, shift_date, shift_key, start_minutes, end_minutes, status, post_channel_id, post_message_id
  `);

  const getShiftStmt = db.prepare(`
    SELECT id, guild_id, shift_date, shift_key, start_minutes, end_minutes, status, post_channel_id, post_message_id
    FROM daily_shifts
    WHERE id = ?
  `);

  const setShiftPostedStmt = db.prepare(`
    UPDATE daily_shifts
    SET post_channel_id = ?,
        post_message_id = ?,
        posted_at = datetime('now')
    WHERE id = ?
  `);

  const cancelShiftStmt = db.prepare(`
    UPDATE daily_shifts
    SET status = 'cancelled',
        reviewed_at = datetime('now'),
        reviewed_by = ?,
        review_notes = ?
    WHERE id = ? AND status = 'scheduled'
  `);

  const addSignInStmt = db.prepare(`
    INSERT INTO shift_signins (shift_id, user_id)
    VALUES (?, ?)
  `);
  const removeSignInStmt = db.prepare(`
    DELETE FROM shift_signins
    WHERE shift_id = ? AND user_id = ?
  `);
  const addUnavailabilityStmt = db.prepare(`
    INSERT INTO shift_unavailability (shift_id, user_id, reason)
    VALUES (?, ?, ?)
  `);

  const signInCountStmt = db.prepare(`
    SELECT COUNT(*) AS total
    FROM shift_signins
    WHERE shift_id = ?
  `);

  const signInsForShiftStmt = db.prepare(`
    SELECT user_id, signed_in_at
    FROM shift_signins
    WHERE shift_id = ?
    ORDER BY signed_in_at ASC
  `);

  const markReviewRequestedStmt = db.prepare(`
    UPDATE daily_shifts
    SET review_requested_at = datetime('now')
    WHERE id = ? AND review_requested_at IS NULL
  `);

  const pendingReviewsStmt = db.prepare(`
    SELECT id, guild_id, shift_date, shift_key, start_minutes, end_minutes, status
    FROM daily_shifts
    WHERE guild_id = ?
      AND status = 'scheduled'
      AND review_requested_at IS NULL
  `);

  const approveShiftStmt = db.prepare(`
    UPDATE daily_shifts
    SET status = 'approved',
        reviewed_at = datetime('now'),
        reviewed_by = ?,
        review_notes = ?
    WHERE id = ? AND status = 'scheduled'
  `);

  const rejectShiftStmt = db.prepare(`
    UPDATE daily_shifts
    SET status = 'rejected',
        reviewed_at = datetime('now'),
        reviewed_by = ?,
        review_notes = ?
    WHERE id = ? AND status = 'scheduled'
  `);

  const addPayoutStmt = db.prepare(`
    INSERT INTO shift_payouts (shift_id, user_id, coins_awarded, awarded_by)
    VALUES (?, ?, ?, ?)
  `);
  const insertEventStmt = db.prepare(`
    INSERT INTO shift_events (guild_id, title, description, start_at, end_at, post_channel_id, post_message_id, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const topAllTimeStmt = db.prepare(`
    SELECT p.user_id, COUNT(*) AS shifts
    FROM shift_payouts p
    GROUP BY p.user_id
    ORDER BY shifts DESC, p.user_id ASC
    LIMIT 5
  `);

  const topMonthStmt = db.prepare(`
    SELECT p.user_id, COUNT(*) AS shifts
    FROM shift_payouts p
    JOIN daily_shifts s ON s.id = p.shift_id
    WHERE s.shift_date LIKE ? || '%'
    GROUP BY p.user_id
    ORDER BY shifts DESC, p.user_id ASC
    LIMIT 1
  `);
  const weeklyTotalsStmt = db.prepare(`
    SELECT COUNT(DISTINCT p.user_id) AS volunteer_count, COUNT(*) AS verified_shifts
    FROM shift_payouts p
    JOIN daily_shifts s ON s.id = p.shift_id
    WHERE s.shift_date BETWEEN ? AND ?
  `);
  const monthlyTotalsStmt = db.prepare(`
    SELECT COUNT(DISTINCT p.user_id) AS volunteer_count, COUNT(*) AS verified_shifts
    FROM shift_payouts p
    JOIN daily_shifts s ON s.id = p.shift_id
    WHERE s.shift_date LIKE ? || '%'
  `);

  const insertReportStmt = db.prepare(`
    INSERT INTO reports (guild_id, user_id, summary)
    VALUES (?, ?, ?)
  `);

  const latestReportsStmt = db.prepare(`
    SELECT id, user_id, summary, created_at
    FROM reports
    WHERE guild_id = ?
    ORDER BY id DESC
    LIMIT 5
  `);

  function pickShiftForManualPost(nowMinutes, explicitShiftKey) {
    if (!SHIFT_WINDOWS.length) return null;

    if (explicitShiftKey) {
      return SHIFT_WINDOWS.find((shift) => shift.key === explicitShiftKey) || null;
    }

    const current = SHIFT_WINDOWS.find((shift) => nowMinutes <= shift.endMinutes);
    return current || SHIFT_WINDOWS[0];
  }

  async function postDailyShift({ guild, channel, shiftWindow, shiftDate, actorUserId }) {
    const existingShift = insertShiftStmt.get(
      guild.id,
      shiftDate,
      shiftWindow.key,
      shiftWindow.startMinutes,
      shiftWindow.endMinutes,
      actorUserId || "system"
    );

    if (existingShift.status !== "scheduled" || existingShift.post_message_id) {
      return { status: "already_posted", shift: existingShift };
    }

    const payload = buildDailyShiftPayload(existingShift, 0);
    const postedMessage = await channel.send(payload);
    setShiftPostedStmt.run(channel.id, postedMessage.id, existingShift.id);

    return {
      status: "posted",
      shift: getShiftStmt.get(existingShift.id),
      message: postedMessage
    };
  }

  async function createReviewRequest({ client, shift }) {
    if (!config.shiftVerifyChannelId) return;

    const guild = client.guilds.cache.get(shift.guild_id);
    if (!guild) return;

    const channel = await guild.channels.fetch(config.shiftVerifyChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;

    const signIns = signInsForShiftStmt.all(shift.id);
    const attendees = signIns.length ? signIns.map((row) => `<@${row.user_id}>`).join("\n") : "No sign-ins recorded.";

    const embed = makeEmbed({
      title: "Shift Attendance Verification",
      description:
        `Please verify attendance before payout.\n\n` +
        `**Shift:** ${shift.shift_key}\n` +
        `**Date:** ${shift.shift_date}\n` +
        `**Time:** ${formatClock(shift.start_minutes)} - ${formatClock(shift.end_minutes)} (${config.shiftTimezone})\n\n` +
        `**Signed In Volunteers:**\n${attendees}`
    });

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DAILY_APPROVE_PREFIX}${shift.id}`)
        .setLabel("Approve + Pay")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${DAILY_REJECT_PREFIX}${shift.id}`)
        .setLabel("Reject")
        .setStyle(ButtonStyle.Secondary)
    );

    await channel.send({
      content: config.ownerRoleId ? `<@&${config.ownerRoleId}>` : undefined,
      embeds: [embed],
      components: [row]
    });
  }

  async function notifyOwnersUnavailable({ interaction, shift }) {
    const note = `<@${interaction.user.id}> marked themselves unavailable for **${shift.shift_key}** on **${shift.shift_date}**.`;

    if (config.ownerRoleId && interaction.guild) {
      const role = await interaction.guild.roles.fetch(config.ownerRoleId).catch(() => null);
      if (role?.members?.size) {
        for (const member of role.members.values()) {
          if (member.user.bot) continue;
          await member.send(note).catch(() => null);
        }
      }
    }

    if (config.shiftVerifyChannelId && interaction.guild) {
      const verifyChannel = await interaction.guild.channels.fetch(config.shiftVerifyChannelId).catch(() => null);
      if (verifyChannel?.isTextBased()) {
        await verifyChannel
          .send({
            content: config.ownerRoleId ? `<@&${config.ownerRoleId}> ${note}` : note
          })
          .catch(() => null);
      }
    }
  }

  async function runAutoPosting({ client }) {
    if (!config.shiftAutopostEnabled || !SHIFT_WINDOWS.length || !config.dailyLoginChannelId) return;

    for (const guild of client.guilds.cache.values()) {
      const channel = await guild.channels.fetch(config.dailyLoginChannelId).catch(() => null);
      if (!channel || !channel.isTextBased()) continue;

      const now = new Date();
      const minutesIntoDay = getMinutesIntoDay(now, config.shiftTimezone);
      const shiftDate = getDateKey(now, config.shiftTimezone);

      for (const shiftWindow of SHIFT_WINDOWS) {
        const autopostMinute = shiftWindow.startMinutes - AUTOPOST_LEAD_MINUTES;
        if (minutesIntoDay < autopostMinute || minutesIntoDay > shiftWindow.endMinutes) continue;

        await postDailyShift({
          guild,
          channel,
          shiftWindow,
          shiftDate,
          actorUserId: "system"
        });
      }
    }
  }

  async function runReviewPrompts({ client }) {
    for (const guild of client.guilds.cache.values()) {
      const pending = pendingReviewsStmt.all(guild.id);
      if (!pending.length) continue;

      const now = new Date();
      const dateKey = getDateKey(now, config.shiftTimezone);
      const nowMinutes = getMinutesIntoDay(now, config.shiftTimezone);

      for (const shift of pending) {
        const sameDay = shift.shift_date === dateKey;
        const pastEnd = sameDay ? nowMinutes >= shift.end_minutes : shift.shift_date < dateKey;
        if (!pastEnd) continue;

        const updated = markReviewRequestedStmt.run(shift.id);
        if (!updated.changes) continue;

        await createReviewRequest({ client, shift });
      }
    }
  }

  let schedulerHandle = null;

  const postDailyCommand = new SlashCommandBuilder()
    .setName("post-daily")
    .setDescription("Post a Daily Shift Report embed for volunteer sign-ins.")
    .addStringOption((option) => {
      option
        .setName("shift")
        .setDescription("Which shift to post (defaults to current/next shift)")
        .setRequired(false);

      for (const shiftWindow of SHIFT_WINDOWS) {
        option.addChoices({ name: shiftWindow.label.slice(0, 100), value: shiftWindow.key });
      }

      return option;
    });

  return {
    db,
    dbPath,
    commands: [
      {
        data: new SlashCommandBuilder()
          .setName("shift-report")
          .setDescription("Submit a quick shift report.")
          .addStringOption((option) =>
            option.setName("summary").setDescription("What happened on your shift?").setRequired(true)
          ),
        async execute(interaction) {
          const summary = interaction.options.getString("summary", true).trim();
          insertReportStmt.run(interaction.guildId || "dm", interaction.user.id, summary);
          return reply(interaction, {
            embeds: [makeEmbed({ title: "Shift report saved", description: summary })],
            ephemeral: true
          });
        }
      },
      {
        data: new SlashCommandBuilder()
          .setName("shift-report-list")
          .setDescription("List the latest shift reports."),
        async execute(interaction) {
          const rows = latestReportsStmt.all(interaction.guildId || "dm");
          if (!rows.length) {
            return reply(interaction, { content: "No reports yet.", ephemeral: true });
          }
          const description = rows.map((row) => `**#${row.id}** • <@${row.user_id}>\n${row.summary}`).join("\n\n");
          return reply(interaction, {
            embeds: [makeEmbed({ title: "Latest shift reports", description })],
            ephemeral: true
          });
        }
      },
      {
        data: postDailyCommand,
        async execute(interaction) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          if (!interaction.guild) {
            return reply(interaction, { content: "This command can only be used in a server.", ephemeral: true });
          }

          if (!SHIFT_WINDOWS.length) {
            return reply(interaction, {
              content: "No shift windows configured. Set SHIFT_WINDOWS_JSON in your environment.",
              ephemeral: true
            });
          }

          const shiftOption = interaction.options.getString("shift");
          const now = new Date();
          const nowMinutes = getMinutesIntoDay(now, config.shiftTimezone);
          const shiftWindow = pickShiftForManualPost(nowMinutes, shiftOption);
          if (!shiftWindow) {
            return reply(interaction, {
              content: "Unable to resolve a valid shift for today.",
              ephemeral: true
            });
          }

          const channelId = config.dailyLoginChannelId || interaction.channelId;
          const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
          if (!targetChannel || !targetChannel.isTextBased()) {
            return reply(interaction, {
              content: "Configured daily login channel is missing or not text-based.",
              ephemeral: true
            });
          }

          const result = await postDailyShift({
            guild: interaction.guild,
            channel: targetChannel,
            shiftWindow,
            shiftDate: getDateKey(now, config.shiftTimezone),
            actorUserId: interaction.user.id
          });

          if (result.status === "already_posted") {
            return reply(interaction, {
              content: `A daily shift embed has already been posted for **${result.shift.shift_key}** on **${result.shift.shift_date}**.`,
              ephemeral: true
            });
          }

          return reply(interaction, {
            content: `Posted Daily Shift Report in <#${targetChannel.id}> for **${shiftWindow.label}**.`,
            ephemeral: true
          });
        }
      },
      {
        data: new SlashCommandBuilder()
          .setName("post-event")
          .setDescription("Post a custom volunteer event shift embed.")
          .addStringOption((option) =>
            option.setName("title").setDescription("Event title").setRequired(true).setMaxLength(120)
          )
          .addStringOption((option) =>
            option.setName("description").setDescription("Event description").setRequired(true).setMaxLength(2000)
          )
          .addStringOption((option) =>
            option
              .setName("start")
              .setDescription("Start datetime in YYYY-MM-DD HH:MM")
              .setRequired(true)
              .setMaxLength(16)
          )
          .addStringOption((option) =>
            option
              .setName("end")
              .setDescription("End datetime in YYYY-MM-DD HH:MM")
              .setRequired(true)
              .setMaxLength(16)
          ),
        async execute(interaction) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          if (!interaction.guild) {
            return reply(interaction, { content: "This command can only be used in a server.", ephemeral: true });
          }

          const title = interaction.options.getString("title", true).trim();
          const description = interaction.options.getString("description", true).trim();
          const startAt = parseDateTimeInput(interaction.options.getString("start", true));
          const endAt = parseDateTimeInput(interaction.options.getString("end", true));

          if (!startAt || !endAt) {
            return reply(interaction, {
              content: "Start/end must use format `YYYY-MM-DD HH:MM`.",
              ephemeral: true
            });
          }
          if (endAt <= startAt) {
            return reply(interaction, {
              content: "End datetime must be after start datetime.",
              ephemeral: true
            });
          }

          const channelId = config.dailyLoginChannelId || interaction.channelId;
          const targetChannel = await interaction.guild.channels.fetch(channelId).catch(() => null);
          if (!targetChannel || !targetChannel.isTextBased()) {
            return reply(interaction, {
              content: "Configured daily login channel is missing or not text-based.",
              ephemeral: true
            });
          }

          const payload = buildEventPayload({ title, description, startAt, endAt });
          const message = await targetChannel.send(payload);
          insertEventStmt.run(
            interaction.guildId || "dm",
            title,
            description,
            startAt,
            endAt,
            targetChannel.id,
            message.id,
            interaction.user.id
          );

          return reply(interaction, {
            content: `Posted event shift in <#${targetChannel.id}>.`,
            ephemeral: true
          });
        }
      },
      {
        data: new SlashCommandBuilder()
          .setName("post-shift-stats")
          .setDescription("Post volunteer shift stats for attendance and recognition."),
        async execute(interaction) {
          const allTime = topAllTimeStmt.all();
          const now = new Date();
          const monthKey = getMonthKey(now, config.shiftTimezone);
          const topMonth = topMonthStmt.get(monthKey);
          const weekStartDate = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
          const weekStartKey = getDateKey(weekStartDate, config.shiftTimezone);
          const todayKey = getDateKey(now, config.shiftTimezone);
          const weeklyTotals = weeklyTotalsStmt.get(weekStartKey, todayKey) || {
            volunteer_count: 0,
            verified_shifts: 0
          };
          const monthlyTotals = monthlyTotalsStmt.get(monthKey) || {
            volunteer_count: 0,
            verified_shifts: 0
          };

          const allTimeText = allTime.length
            ? allTime.map((row, index) => `${index + 1}. <@${row.user_id}> — **${row.shifts}** shifts`).join("\n")
            : "No verified shift payouts yet.";

          const volunteerOfMonth = topMonth
            ? `<@${topMonth.user_id}> with **${topMonth.shifts}** verified shifts in ${monthKey}.`
            : `No verified shifts yet for ${monthKey}.`;

          const totalsText = `**Weekly (last 7 days):** ${weeklyTotals.volunteer_count || 0} volunteers across **${weeklyTotals.verified_shifts || 0}** verified shifts.\n` +
            `**Monthly (${monthKey}):** ${monthlyTotals.volunteer_count || 0} volunteers across **${monthlyTotals.verified_shifts || 0}** verified shifts.`;

          const statsEmbed = makeEmbed({
            title: "Volunteer Shift Stats",
            fields: [
              { name: "Most Days Volunteered (All-Time)", value: allTimeText },
              { name: "Volunteer of the Month", value: volunteerOfMonth },
              { name: "Volunteer Totals", value: totalsText }
            ]
          });
          const statsThumbnail = safeEmbedUrl(config.dailyLoginThumbnailUrl);
          if (statsThumbnail) statsEmbed.setThumbnail(statsThumbnail);

          return reply(interaction, {
            embeds: [statsEmbed],
            ephemeral: false
          });
        }
      }
    ],
    buttons: [
      {
        customId: /^daily_signin:\d+$/,
        async execute(interaction) {
          const shiftId = Number(interaction.customId.slice(DAILY_SIGNIN_PREFIX.length));
          const shift = getShiftStmt.get(shiftId);
          if (!shift || shift.status !== "scheduled") {
            return reply(interaction, {
              content: "This shift is no longer available for sign-in.",
              ephemeral: true
            });
          }

          try {
            addSignInStmt.run(shiftId, interaction.user.id);
          } catch (error) {
            if (String(error.message).includes("UNIQUE")) {
              return reply(interaction, {
                content: "You are already signed in for this shift.",
                ephemeral: true
              });
            }
            throw error;
          }

          const signInCount = signInCountStmt.get(shiftId)?.total || 0;
          if (interaction.message?.editable) {
            const payload = buildDailyShiftPayload(shift, signInCount);
            await interaction.message.edit(payload).catch(() => null);
          }

          return reply(interaction, {
            content: `Signed in successfully for **${shift.shift_key}** on **${shift.shift_date}**.`,
            ephemeral: true
          });
        }
      },
      {
        customId: /^daily_unavailable:\d+$/,
        async execute(interaction) {
          const shiftId = Number(interaction.customId.slice(DAILY_UNAVAILABLE_PREFIX.length));
          const shift = getShiftStmt.get(shiftId);
          if (!shift || shift.status !== "scheduled") {
            return reply(interaction, {
              content: "This shift is no longer accepting availability updates.",
              ephemeral: true
            });
          }

          const removed = removeSignInStmt.run(shiftId, interaction.user.id);
          addUnavailabilityStmt.run(shiftId, interaction.user.id, "Marked unavailable");

          const signInCount = signInCountStmt.get(shiftId)?.total || 0;
          if (interaction.message?.editable) {
            const payload = buildDailyShiftPayload(shift, signInCount);
            await interaction.message.edit(payload).catch(() => null);
          }

          await notifyOwnersUnavailable({ interaction, shift });

          return reply(interaction, {
            content: removed.changes
              ? `You were signed out and marked unavailable for **${shift.shift_key}** on **${shift.shift_date}**.`
              : `You are marked unavailable for **${shift.shift_key}** on **${shift.shift_date}**.`,
            ephemeral: true
          });
        }
      },
      {
        customId: /^daily_cancel:\d+$/,
        async execute(interaction) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const shiftId = Number(interaction.customId.slice(DAILY_CANCEL_PREFIX.length));
          const cancelled = cancelShiftStmt.run(interaction.user.id, "Cancelled by owner", shiftId);
          if (!cancelled.changes) {
            return reply(interaction, {
              content: "Shift could not be cancelled (it may already be reviewed).",
              ephemeral: true
            });
          }

          if (interaction.message?.editable) {
            const updatedShift = getShiftStmt.get(shiftId);
            const signInCount = signInCountStmt.get(shiftId)?.total || 0;
            await interaction.message.edit(buildDailyShiftPayload(updatedShift, signInCount)).catch(() => null);
          }

          return reply(interaction, {
            content: "Shift cancelled. Payout will not be processed.",
            ephemeral: true
          });
        }
      },
      {
        customId: /^daily_approve:\d+$/,
        async execute(interaction, { client }) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const shiftId = Number(interaction.customId.slice(DAILY_APPROVE_PREFIX.length));
          const shift = getShiftStmt.get(shiftId);
          if (!shift || shift.status !== "scheduled") {
            return reply(interaction, {
              content: "This shift is already reviewed.",
              ephemeral: true
            });
          }

          const signIns = signInsForShiftStmt.all(shiftId);
          const paidUsers = [];
          for (const entry of signIns) {
            try {
              addPayoutStmt.run(shiftId, entry.user_id, SHIFT_REWARD_COINS, interaction.user.id);
              applyCoinDelta({
                guildId: interaction.guildId || "dm",
                userId: entry.user_id,
                amount: SHIFT_REWARD_COINS,
                reason: `Shift payout (${shift.shift_key} ${shift.shift_date})`,
                createdBy: interaction.user.id,
                source: "shift_payout"
              });
              paidUsers.push(entry.user_id);
            } catch (error) {
              if (!String(error.message).includes("UNIQUE")) {
                throw error;
              }
            }
          }

          approveShiftStmt.run(interaction.user.id, `Approved ${paidUsers.length} payouts`, shiftId);

          if (interaction.message?.editable) {
            const updatedShift = getShiftStmt.get(shiftId);
            const signInCount = signInCountStmt.get(shiftId)?.total || 0;
            await interaction.message.edit(buildDailyShiftPayload(updatedShift, signInCount)).catch(() => null);
          }

          if (interaction.guildId) {
            await syncLeaderboardMessage({
              client,
              guildId: interaction.guildId,
              channelId: config.leaderboardChannelId,
              forcePost: false
            }).catch(() => null);
          }

          const payoutText =
            paidUsers.length > 0
              ? paidUsers.map((userId) => `<@${userId}>`).join(", ")
              : "No sign-ins to pay for this shift.";

          return reply(interaction, {
            content: `Shift approved. Awarded **${SHIFT_REWARD_COINS}** coins to: ${payoutText}`,
            ephemeral: true
          });
        }
      },
      {
        customId: /^daily_reject:\d+$/,
        async execute(interaction) {
          const denied = ensureOwnerAccess(interaction, config.ownerRoleId);
          if (denied) return denied;

          const shiftId = Number(interaction.customId.slice(DAILY_REJECT_PREFIX.length));
          const rejected = rejectShiftStmt.run(interaction.user.id, "Rejected by owner", shiftId);
          if (!rejected.changes) {
            return reply(interaction, {
              content: "This shift is already reviewed.",
              ephemeral: true
            });
          }

          if (interaction.message?.editable) {
            const updatedShift = getShiftStmt.get(shiftId);
            const signInCount = signInCountStmt.get(shiftId)?.total || 0;
            await interaction.message.edit(buildDailyShiftPayload(updatedShift, signInCount)).catch(() => null);
          }

          return reply(interaction, {
            content: "Shift marked as rejected. No payout issued.",
            ephemeral: true
          });
        }
      }
    ],
    async onReady({ client }) {
      await runAutoPosting({ client });
      await runReviewPrompts({ client });

      if (!schedulerHandle) {
        schedulerHandle = setInterval(async () => {
          await runAutoPosting({ client }).catch((error) => {
            console.error("[daily-login] autopost failed:", error.message);
          });
          await runReviewPrompts({ client }).catch((error) => {
            console.error("[daily-login] review prompt failed:", error.message);
          });
        }, SCHEDULER_INTERVAL_MS);
      }
    }
  };
}

module.exports = { createFeature };
