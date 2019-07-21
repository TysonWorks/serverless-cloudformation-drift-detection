require = require("esm")(module /* , options*/);

const { detectDriftsHandler } = require("./handlers/driftDetection");

module.exports = {
  detectDriftsHandler
};
