const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { ensureDir } = require("./paths");
const { config } = require("./config");

const ECONOMY_SCHEMA_VERSION = "1";
const economyDir = ensureDir(path.dirname(config.economyDbPath));
const economyPath = path.join(economyDir, path.basename(config.economyDbPath));

if (!economyPath.endsWith(path.join("economy", "economy.sqlite"))) {
  throw new Error(
    `[economy] Refusing to start: canonical economy DB must end with data/economy/economy.sqlite (resolved: ${economyPath}).`
  );
}

console.log(`[economy] Canonical DB path: ${economyPath}`);

const db = new Database(economyPath);

db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS bot_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS economy_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS coin_balances (
    guild_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    balance INTEGER NOT NULL DEFAULT 0,
    is_hidden INTEGER NOT NULL DEFAULT 0,
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
    balance_after INTEGER NOT NULL,
    reason TEXT,
    source TEXT NOT NULL DEFAULT 'manual',
    created_by TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    legacy_source_db TEXT,
    legacy_source_table TEXT,
    legacy_row_id TEXT
  );

  CREATE TABLE IF NOT EXISTS coin_leaderboards (
    guild_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_coin_transactions_legacy_source
    ON coin_transactions (legacy_source_db, legacy_source_table, legacy_row_id)
    WHERE legacy_source_db IS NOT NULL
      AND legacy_source_table IS NOT NULL
      AND legacy_row_id IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_coin_transactions_guild_user_created
    ON coin_transactions (guild_id, user_id, created_at DESC);

  CREATE INDEX IF NOT EXISTS idx_coin_balances_guild_hidden_balance
    ON coin_balances (guild_id, is_hidden, balance DESC, user_id ASC);
`);

const setMetaStmt = db.prepare(`
  INSERT INTO bot_meta (key, value, updated_at)
  VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
`);
const getMetaStmt = db.prepare(`SELECT value FROM bot_meta WHERE key = ?`);

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
const upsertBalanceFromLegacyStmt = db.prepare(`
  INSERT INTO coin_balances (
    guild_id, user_id, balance, is_hidden, hidden_reason, hidden_at, hidden_by, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))
  ON CONFLICT(guild_id, user_id) DO UPDATE SET
    balance = CASE
      WHEN excluded.balance > coin_balances.balance THEN excluded.balance
      ELSE coin_balances.balance
    END,
    is_hidden = CASE
      WHEN excluded.is_hidden = 1 OR coin_balances.is_hidden = 1 THEN 1
      ELSE 0
    END,
    hidden_reason = CASE
      WHEN excluded.is_hidden = 1 AND excluded.hidden_reason IS NOT NULL THEN excluded.hidden_reason
      ELSE coin_balances.hidden_reason
    END,
    hidden_at = CASE
      WHEN excluded.is_hidden = 1 AND excluded.hidden_at IS NOT NULL THEN excluded.hidden_at
      ELSE coin_balances.hidden_at
    END,
    hidden_by = CASE
      WHEN excluded.is_hidden = 1 AND excluded.hidden_by IS NOT NULL THEN excluded.hidden_by
      ELSE coin_balances.hidden_by
    END,
    updated_at = CASE
      WHEN excluded.updated_at > coin_balances.updated_at THEN excluded.updated_at
      ELSE coin_balances.updated_at
    END
`);
const insertTransactionStmt = db.prepare(`
  INSERT INTO coin_transactions (guild_id, user_id, amount, balance_after, reason, source, created_by)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const insertLegacyTransactionStmt = db.prepare(`
  INSERT INTO coin_transactions (
    guild_id,
    user_id,
    amount,
    balance_after,
    reason,
    source,
    created_by,
    created_at,
    legacy_source_db,
    legacy_source_table,
    legacy_row_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?)
  ON CONFLICT(legacy_source_db, legacy_source_table, legacy_row_id) DO NOTHING
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
const setLeaderboardMessageFromLegacyStmt = db.prepare(`
  INSERT INTO coin_leaderboards (guild_id, channel_id, message_id, updated_at)
  VALUES (?, ?, ?, COALESCE(?, datetime('now')))
  ON CONFLICT(guild_id) DO UPDATE SET
    channel_id = CASE
      WHEN excluded.updated_at >= coin_leaderboards.updated_at THEN excluded.channel_id
      ELSE coin_leaderboards.channel_id
    END,
    message_id = CASE
      WHEN excluded.updated_at >= coin_leaderboards.updated_at THEN excluded.message_id
      ELSE coin_leaderboards.message_id
    END,
    updated_at = CASE
      WHEN excluded.updated_at >= coin_leaderboards.updated_at THEN excluded.updated_at
      ELSE coin_leaderboards.updated_at
    END
`);
const getLeaderboardMessageStmt = db.prepare(`
  SELECT guild_id, channel_id, message_id, updated_at
  FROM coin_leaderboards
  WHERE guild_id = ?
`);
const deleteLeaderboardMessageStmt = db.prepare(`DELETE FROM coin_leaderboards WHERE guild_id = ?`);

function setMeta(key, value) {
  setMetaStmt.run(key, String(value));
}

function getMeta(key, fallback = null) {
  const row = getMetaStmt.get(key);
  return row ? row.value : fallback;
}

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
  const current = getCoinBalance(guildId, userId);
  const next = current + amount;
  if (next < 0) {
    const error = new Error("Insufficient balance for deduction.");
    error.code = "INSUFFICIENT_BALANCE";
    error.currentBalance = current;
    throw error;
  }

  upsertBalanceStmt.run(guildId, userId, next);
  insertTransactionStmt.run(guildId, userId, amount, next, reason || null, source, createdBy);
  return {
    previousBalance: current,
    balance: next,
    amount
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

function hasTable(targetDb, tableName) {
  const row = targetDb
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1")
    .get(tableName);
  return Boolean(row);
}

function getTableColumns(targetDb, tableName) {
  return targetDb.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
}

function buildSelectExpressions(columns, mapping) {
  return Object.entries(mapping)
    .map(([alias, candidates]) => {
      const column = candidates.find((candidate) => columns.includes(candidate));
      return column ? `${column} AS ${alias}` : `NULL AS ${alias}`;
    })
    .join(",\n      ");
}

function readLegacyBalances(legacyDb, tableName) {
  if (!hasTable(legacyDb, tableName)) return [];
  const columns = getTableColumns(legacyDb, tableName);
  if (!columns.includes("guild_id") || !columns.includes("user_id")) return [];

  const selectSql = buildSelectExpressions(columns, {
    guild_id: ["guild_id"],
    user_id: ["user_id"],
    balance: ["balance", "coins", "coin_balance"],
    is_hidden: ["is_hidden", "hidden"],
    hidden_reason: ["hidden_reason"],
    hidden_at: ["hidden_at"],
    hidden_by: ["hidden_by"],
    updated_at: ["updated_at"]
  });

  const rows = legacyDb.prepare(`SELECT ${selectSql} FROM ${tableName}`).all();
  return rows.map((row) => ({
    guild_id: String(row.guild_id),
    user_id: String(row.user_id),
    balance: Number(row.balance || 0),
    is_hidden: row.is_hidden ? 1 : 0,
    hidden_reason: row.hidden_reason || null,
    hidden_at: row.hidden_at || null,
    hidden_by: row.hidden_by || null,
    updated_at: row.updated_at || null
  }));
}

function readLegacyTransactions(legacyDb, tableName) {
  if (!hasTable(legacyDb, tableName)) return [];
  const columns = getTableColumns(legacyDb, tableName);
  if (!columns.includes("guild_id") || !columns.includes("user_id")) return [];

  const selectSql = buildSelectExpressions(columns, {
    id: ["id", "transaction_id"],
    guild_id: ["guild_id"],
    user_id: ["user_id"],
    amount: ["amount", "delta"],
    balance_after: ["balance_after", "new_balance", "balance"],
    reason: ["reason"],
    source: ["source"],
    created_by: ["created_by", "actor_user_id", "actor_id"],
    created_at: ["created_at"]
  });

  const rows = legacyDb.prepare(`SELECT ${selectSql} FROM ${tableName}`).all();
  return rows
    .filter((row) => row.amount !== null && row.balance_after !== null)
    .map((row, idx) => ({
      id: row.id === null ? `row-${idx}` : String(row.id),
      guild_id: String(row.guild_id),
      user_id: String(row.user_id),
      amount: Number(row.amount),
      balance_after: Number(row.balance_after),
      reason: row.reason || null,
      source: row.source || "legacy_import",
      created_by: row.created_by || "legacy-import",
      created_at: row.created_at || null
    }));
}

function readLegacyLeaderboards(legacyDb, tableName) {
  if (!hasTable(legacyDb, tableName)) return [];
  const columns = getTableColumns(legacyDb, tableName);
  if (!columns.includes("guild_id")) return [];

  const selectSql = buildSelectExpressions(columns, {
    guild_id: ["guild_id"],
    channel_id: ["channel_id"],
    message_id: ["message_id"],
    updated_at: ["updated_at"]
  });

  const rows = legacyDb.prepare(`SELECT ${selectSql} FROM ${tableName}`).all();
  return rows
    .filter((row) => row.channel_id && row.message_id)
    .map((row) => ({
      guild_id: String(row.guild_id),
      channel_id: String(row.channel_id),
      message_id: String(row.message_id),
      updated_at: row.updated_at || null
    }));
}

function readLegacySettings(legacyDb, tableName) {
  if (!hasTable(legacyDb, tableName)) return [];
  const columns = getTableColumns(legacyDb, tableName);
  if (!columns.includes("key") || !columns.includes("value")) return [];

  return legacyDb
    .prepare(`SELECT key, value FROM ${tableName}`)
    .all()
    .map((row) => ({ key: String(row.key), value: String(row.value) }));
}

const runLegacyImportTxn = db.transaction((legacySource) => {
  let balancesImported = 0;
  let txImported = 0;
  let leaderboardsImported = 0;
  let settingsImported = 0;

  for (const row of legacySource.balances) {
    upsertBalanceFromLegacyStmt.run(
      row.guild_id,
      row.user_id,
      row.balance,
      row.is_hidden,
      row.hidden_reason,
      row.hidden_at,
      row.hidden_by,
      row.updated_at
    );
    balancesImported += 1;
  }

  for (const row of legacySource.transactions) {
    const result = insertLegacyTransactionStmt.run(
      row.guild_id,
      row.user_id,
      row.amount,
      row.balance_after,
      row.reason,
      row.source,
      row.created_by,
      row.created_at,
      legacySource.sourceKey,
      "coin_transactions",
      row.id
    );
    txImported += result.changes;
  }

  for (const row of legacySource.leaderboards) {
    setLeaderboardMessageFromLegacyStmt.run(row.guild_id, row.channel_id, row.message_id, row.updated_at);
    leaderboardsImported += 1;
  }

  for (const row of legacySource.settings) {
    setEconomySettingStmt.run(row.key, row.value);
    settingsImported += 1;
  }

  return {
    balancesImported,
    txImported,
    leaderboardsImported,
    settingsImported
  };
});

function migrateFromLegacyDatabases() {
  const migrationKey = "economy:migration:v1:done";
  if (getMeta(migrationKey) === "1") {
    console.log("[economy] Migration status: already applied (skipped).");
    return;
  }

  const sharedPath = path.join(config.dataDir, "shared", "shared.sqlite");
  const legacyLeaderboardPath = path.join(config.dataDir, "leaderboard", "leaderboard.sqlite");

  const sources = [
    {
      sourceKey: "shared/shared.sqlite",
      path: sharedPath,
      balanceTables: ["coin_balances"],
      transactionTables: ["coin_transactions"],
      leaderboardTables: ["coin_leaderboards"],
      settingsTables: ["economy_settings", "bot_meta"]
    },
    {
      sourceKey: "leaderboard/leaderboard.sqlite",
      path: legacyLeaderboardPath,
      balanceTables: ["coin_balances"],
      transactionTables: ["coin_transactions"],
      leaderboardTables: ["coin_leaderboards", "leaderboard_messages"],
      settingsTables: ["economy_settings", "bot_meta"]
    }
  ];

  console.log("[economy] Running one-time legacy economy migration check...");

  let migratedAnything = false;
  let scannedLegacySources = 0;
  const totals = {
    balancesImported: 0,
    transactionsImported: 0,
    leaderboardsImported: 0,
    settingsImported: 0
  };

  for (const source of sources) {
    if (!fs.existsSync(source.path)) {
      continue;
    }
    scannedLegacySources += 1;

    let legacyDb;
    try {
      legacyDb = new Database(source.path, { readonly: true, fileMustExist: true });
      const balances = source.balanceTables.flatMap((tableName) => readLegacyBalances(legacyDb, tableName));
      const transactions = source.transactionTables.flatMap((tableName) => readLegacyTransactions(legacyDb, tableName));
      const leaderboards = source.leaderboardTables.flatMap((tableName) => readLegacyLeaderboards(legacyDb, tableName));
      const settings = source.settingsTables.flatMap((tableName) => readLegacySettings(legacyDb, tableName));

      if (!balances.length && !transactions.length && !leaderboards.length && !settings.length) {
        continue;
      }

      const result = runLegacyImportTxn({
        sourceKey: source.sourceKey,
        balances,
        transactions,
        leaderboards,
        settings
      });

      migratedAnything = true;
      totals.balancesImported += result.balancesImported;
      totals.transactionsImported += result.txImported;
      totals.leaderboardsImported += result.leaderboardsImported;
      totals.settingsImported += result.settingsImported;
      console.log(
        `[economy] Imported legacy data from ${source.path} (${result.balancesImported} balances, ${result.txImported} transactions, ${result.leaderboardsImported} leaderboard rows, ${result.settingsImported} settings).`
      );
    } catch (error) {
      throw new Error(`[economy] Legacy migration failed for ${source.path}: ${error.message}`);
    } finally {
      if (legacyDb) legacyDb.close();
    }
  }

  setMeta("economy:schema:version", ECONOMY_SCHEMA_VERSION);
  setMeta(migrationKey, "1");
  const outcome = migratedAnything ? "completed" : "completed (no legacy rows imported)";
  console.log(`[economy] Migration status: ${outcome}.`);
  console.log(
    `[economy] Migration summary: scanned ${scannedLegacySources} legacy source(s); imported ${totals.balancesImported} balances, ${totals.transactionsImported} transactions, ${totals.leaderboardsImported} leaderboard rows, ${totals.settingsImported} settings.`
  );
  console.log("[economy] Legacy database files were left untouched.");
}

migrateFromLegacyDatabases();

module.exports = {
  economyDb: db,
  economyPath,
  setMeta,
  getMeta,
  setEconomySetting,
  getEconomySetting,
  getCoinBalance,
  getCoinMember,
  applyCoinDelta,
  setMemberHidden,
  getTopCoinBalances,
  setLeaderboardMessage,
  getLeaderboardMessage,
  clearLeaderboardMessage,
  migrateFromLegacyDatabases
};
