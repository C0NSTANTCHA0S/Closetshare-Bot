const fs = require("fs");
const path = require("path");
const { config } = require("./config");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function getFeaturesRoot() {
  return path.resolve(__dirname, "../features");
}

function getFeatureDataDir(featureSlug) {
  return ensureDir(path.join(config.dataDir, featureSlug));
}

function getFeatureDbPath(featureSlug, fileName = "feature.sqlite") {
  return path.join(getFeatureDataDir(featureSlug), fileName);
}

module.exports = {
  ensureDir,
  getFeatureDataDir,
  getFeatureDbPath,
  getFeaturesRoot
};
