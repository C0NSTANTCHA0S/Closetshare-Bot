const { EmbedBuilder, MessageFlags, PermissionFlagsBits } = require("discord.js");

function makeEmbed({ title, description, color = 0x2b7fff, fields = [], footer } = {}) {
  const embed = new EmbedBuilder().setColor(color);
  if (title) embed.setTitle(title);
  if (description) embed.setDescription(description);
  if (fields.length) embed.addFields(fields);
  if (footer) embed.setFooter({ text: footer });
  return embed;
}

function normalizeInteractionPayload(payload) {
  if (!payload || typeof payload !== "object" || !Object.prototype.hasOwnProperty.call(payload, "ephemeral")) {
    return payload;
  }

  const normalized = { ...payload };
  const shouldBeEphemeral = Boolean(normalized.ephemeral);
  delete normalized.ephemeral;

  if (!shouldBeEphemeral) {
    return normalized;
  }

  const existingFlags = normalized.flags ?? 0;
  normalized.flags = existingFlags | MessageFlags.Ephemeral;
  return normalized;
}

async function reply(interaction, payload) {
  const normalizedPayload = normalizeInteractionPayload(payload);
  if (interaction.deferred || interaction.replied) {
    return interaction.followUp(normalizedPayload);
  }
  return interaction.reply(normalizedPayload);
}

function hasAdminPermission(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) || false;
}

function isCustomIdMatch(customId, matcher) {
  if (typeof matcher === "string") return customId === matcher;
  if (matcher instanceof RegExp) return matcher.test(customId);
  return false;
}

function safeEmbedUrl(value) {
  if (!value || typeof value !== "string") return null;

  const raw = value.trim();
  if (!raw || raw.includes("...")) return null;

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (!url.hostname || url.hostname === "..." || !url.hostname.includes(".")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function memberHasRoleId(interaction, roleId) {
  if (!interaction?.inGuild?.() || !roleId) return false;

  const member = interaction.member;
  const cachedHasRole = member?.roles?.cache?.has?.(roleId);
  if (typeof cachedHasRole === "boolean") return cachedHasRole;

  if (Array.isArray(member?.roles)) {
    return member.roles.includes(roleId);
  }

  return false;
}

function ensureOwnerAccess(interaction, ownerRoleId) {
  if (memberHasRoleId(interaction, ownerRoleId)) return null;

  return reply(interaction, {
    content: "Only the bot owner can use that command.",
    ephemeral: true
  });
}

function serializeEmbedsForLog(embeds = []) {
  return embeds.map((embed) => {
    if (typeof embed?.toJSON === "function") {
      return embed.toJSON();
    }
    return embed;
  });
}

function logDiscordPayloadError(scope, error, payload) {
  const details = {
    message: error?.message,
    code: error?.code,
    status: error?.status,
    rawError: error?.rawError,
    payload: {
      content: payload?.content,
      embeds: serializeEmbedsForLog(payload?.embeds || []),
      components: payload?.components
    }
  };

  console.error(`[discord] ${scope}:`, JSON.stringify(details, null, 2));
}

module.exports = {
  ensureOwnerAccess,
  hasAdminPermission,
  isCustomIdMatch,
  logDiscordPayloadError,
  makeEmbed,
  memberHasRoleId,
  reply,
  safeEmbedUrl
};
