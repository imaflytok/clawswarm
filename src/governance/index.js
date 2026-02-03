/**
 * ClawSwarm Governance Module
 * $FLY Token Governance for Agent Coordination
 */

const config = require('./config');
const routes = require('./routes');
const staking = require('./services/staking');
const proposals = require('./services/proposals');
const { handleGovCommand } = require('./bot/commands');

module.exports = {
  config,
  routes,
  staking,
  proposals,
  handleGovCommand
};
