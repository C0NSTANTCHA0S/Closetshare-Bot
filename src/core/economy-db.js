const path = require("path");
const Database = require("better-sqlite3");
const { ensureDir } = require("./paths");
const { config } = require("./config");

const economyDir = ensureDir(path.dirname(config.economyDbPath));
const economyPath = path.join(economyDir, path.basename(config.economyDbPath));

if (!economyPath.endsWith(path.join("economy", "economy.sqlite"))) {
  throw new Error(
    `[economy] Refusing to start: canonical economy DB must end with data/economy/economy.sqlite (resolved: ${economyPath}).`
  );
}

console.log(`[economy] Canonical DB path: ${economyPath}`);

let db;
try {
  db = new Database(economyPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS economy_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS coin_balances (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
      is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1)),
      hidden_reason TEXT,
      hidden_at TEXT,
      hidden_by TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS coin_transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      balance_after INTEGER NOT NULL CHECK (balance_after >= 0),
      reason TEXT,
      source TEXT NOT NULL DEFAULT 'manual',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS coin_leaderboards (
      guild_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_coin_transactions_guild_user_created
      ON coin_transactions (guild_id, user_id, created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_coin_balances_guild_hidden_balance
      ON coin_balances (guild_id, is_hidden, balance DESC, user_id ASC);
  `);

  console.log("[economy] Schema initialization: OK");
} catch (error) {
  throw new Error(`[economy] Failed to initialize economy database: ${error.message}`);
}

const setEconomySettingStmt = db.prepare(`
  INSERT INTO economy_settings (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);
const getEconomySettingStmt = db.prepare(`SELECT value FROM economy_settings WHERE key = ?`);

const getBalanceStmt = db.prepare(`SELECT balance FROM coin_balances WHERE guild_id = ? AND user_id = ?`);
const getMemberStmt = db.prepare(`
  SELECT guild_id, user_id, balance, is_hidden, hidden_reason, hidden_at, hidden_by, updated_at
  FROM coin_balances
  WHERE guild_id = ? AND user_id = ?
`);
const upsertBalanceStmt = db.prepare(`
  INSERT INTO coin_balances (guild_id, user_id, balance, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    balance = excluded.balance,
    updated_at = datetime('now')
`);
const insertTransactionStmt = db.prepare(`
  INSERT INTO coin_transactions (guild_id, user_id, amount, balance_after, reason, source, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const setHiddenStmt = db.prepare(`
  INSERT INTO coin_balances (
    guild_id, user_id, balance, is_hidden, hidden_reason, hidden_at, hidden_by, updated_at
  ) VALUES (?, ?, 0, 1, ?, datetime('now'), ?, datetime('now'))
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    is_hidden = 1,
    hidden_reason = excluded.hidden_reason,
    hidden_at = datetime('now'),
    hidden_by = excluded.hidden_by,
    updated_at = datetime('now')
`);
const clearHiddenStmt = db.prepare(`
  UPDATE coin_balances
  SET is_hidden = 0,
      hidden_reason = NULL,
      hidden_at = NULL,
      hidden_by = NULL,
      updated_at = datetime('now')
  WHERE guild_id = ? AND user_id = ?
`);
const topBalancesStmt = db.prepare(`
  SELECT user_id, balance, updated_at
  FROM coin_balances
  WHERE guild_id = ? AND is_hidden = 0
  ORDER BY balance DESC, user_id ASC
  LIMIT ?
`);
const setLeaderboardMessageStmt = db.prepare(`
  INSERT INTO coin_leaderboards (guild_id, channel_id, message_id, updated_at)
  VALUES (?, ?, ?, datetime('now'))
  ON CONFLICT(guild_id) DO UPDATE SET
    channel_id = excluded.channel_id,
    message_id = excluded.message_id,
    updated_at = datetime('now')
`);
const getLeaderboardMessageStmt = db.prepare(`
  SELECT guild_id, channel_id, message_id, updated_at
  FROM coin_leaderboards
  WHERE guild_id = ?
`);
const deleteLeaderboardMessageStmt = db.prepare(`DELETE FROM coin_leaderboards WHERE guild_id = ?`);

function setEconomySetting(key, value) {
  setEconomySettingStmt.run(key, String(value));
}

function getEconomySetting(key, fallback = null) {
  const row = getEconomySettingStmt.get(key);
  return row ? row.value : fallback;
}

function getCoinBalance(guildId, userId) {
  const row = getBalanceStmt.get(guildId, userId);
  return row ? row.balance : 0;
}

function getCoinMember(guildId, userId) {
  return getMemberStmt.get(guildId, userId) || null;
}

const applyCoinDeltaTxn = db.transaction(({ guildId, userId, amount, reason, createdBy, source = "manual" }) => {
  const parsedAmount = Number(amount);
  if (!Number.isInteger(parsedAmount) || parsedAmount === 0) {
    throw new Error("Coin delta amount must be a non-zero integer.");
  }

  const current = getCoinBalance(guildId, userId);
  const next = current + parsedAmount;
  if (next < 0) {
    const error = new Error("Insufficient balance for deduction.");
    error.code = "INSUFFICIENT_BALANCE";
    error.currentBalance = current;
    throw error;
  }

  upsertBalanceStmt.run(guildId, userId, next);
  insertTransactionStmt.run(guildId, userId, parsedAmount, next, reason || null, source, createdBy);
  return {
    previousBalance: current,
    balance: next,
    amount: parsedAmount
  };
});

function applyCoinDelta(input) {
  return applyCoinDeltaTxn(input);
}

function setMemberHidden(guildId, userId, hidden, reason, actorUserId) {
  if (hidden) {
    setHiddenStmt.run(guildId, userId, reason || null, actorUserId || "system");
  } else {
    clearHiddenStmt.run(guildId, userId);
  }
  return getCoinMember(guildId, userId);
}

function getTopCoinBalances(guildId, limit = 20) {
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 20));
  return topBalancesStmt.all(guildId, safeLimit);
}

function setLeaderboardMessage(guildId, channelId, messageId) {
  setLeaderboardMessageStmt.run(guildId, channelId, messageId);
}

function getLeaderboardMessage(guildId) {
  return getLeaderboardMessageStmt.get(guildId) || null;
}

function clearLeaderboardMessage(guildId) {
  deleteLeaderboardMessageStmt.run(guildId);
}

module.exports = {
  economyDb: db,
  economyPath,
  setEconomySetting,
  getEconomySetting,
  getCoinBalance,
  getCoinMember,
  applyCoinDelta,
  setMemberHidden,
  getTopCoinBalances,
  setLeaderboardMessage,
  getLeaderboardMessage,
  clearLeaderboardMessage
};
