const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { getFeaturesRoot, getFeatureDbPath, ensureDir } = require("./paths");
const { config } = require("./config");

function slugifyFeatureName(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function createFeatureDb(featureSlug, fileName = "feature.sqlite") {
  const dbPath = getFeatureDbPath(featureSlug, fileName);
  ensureDir(path.dirname(dbPath));
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return { db, dbPath };
}

function loadFeatures() {
  ensureDir(config.dataDir);
  const featuresRoot = getFeaturesRoot();
  const entries = fs
    .readdirSync(featuresRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  const features = [];

  for (const entry of entries) {
    const featureDir = path.join(featuresRoot, entry.name);
    const featureIndex = path.join(featureDir, "index.js");
    if (!fs.existsSync(featureIndex)) continue;

    const slug = slugifyFeatureName(entry.name);
    const featureModule = require(featureIndex);
    const feature = featureModule.createFeature({
      featureName: entry.name,
      featureSlug: slug,
      createFeatureDb
    });

    features.push({
      name: entry.name,
      slug,
      commands: [],
      buttons: [],
      selectMenus: [],
      modals: [],
      ...feature
    });
  }

  return features;
}

module.exports = {
  createFeatureDb,
  loadFeatures,
  slugifyFeatureName
};
