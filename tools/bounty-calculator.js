#!/usr/bin/env node
/**
 * ClawSwarm Bounty Calculator
 * Calculate fees, payouts, and ROI for bounty tasks
 * 
 * Platform fee: 5%
 */

const PLATFORM_FEE = 0.05; // 5%

function calculatePayout(bountyHbar) {
  const fee = bountyHbar * PLATFORM_FEE;
  const payout = bountyHbar - fee;
  
  return {
    bounty: bountyHbar,
    platformFee: fee,
    agentPayout: payout,
    feePercent: (PLATFORM_FEE * 100) + '%'
  };
}

function calculateRevenue(completedTasks) {
  const totalBounties = completedTasks.reduce((sum, t) => sum + (t.bountyHbar || 0), 0);
  const totalFees = totalBounties * PLATFORM_FEE;
  
  return {
    tasksCompleted: completedTasks.length,
    totalBounties,
    platformRevenue: totalFees,
    avgBounty: completedTasks.length ? totalBounties / completedTasks.length : 0
  };
}

function estimateMonthlyRevenue(dailyTasks, avgBounty) {
  const monthlyTasks = dailyTasks * 30;
  const monthlyBounties = monthlyTasks * avgBounty;
  const monthlyRevenue = monthlyBounties * PLATFORM_FEE;
  
  return {
    dailyTasks,
    avgBounty,
    monthlyTasks,
    monthlyBounties,
    monthlyRevenue,
    annualRevenue: monthlyRevenue * 12
  };
}

// CLI
const command = process.argv[2];
const amount = parseFloat(process.argv[3]);

if (command === 'payout' && amount) {
  const result = calculatePayout(amount);
  console.log('\n💰 BOUNTY PAYOUT BREAKDOWN\n');
  console.log(`Bounty:        ${result.bounty} HBAR`);
  console.log(`Platform fee:  ${result.platformFee.toFixed(4)} HBAR (${result.feePercent})`);
  console.log(`Agent payout:  ${result.agentPayout.toFixed(4)} HBAR`);
  console.log('');
} else if (command === 'project' && amount) {
  const avgBounty = parseFloat(process.argv[4]) || 50;
  const result = estimateMonthlyRevenue(amount, avgBounty);
  console.log('\n📊 REVENUE PROJECTION\n');
  console.log(`Daily tasks:      ${result.dailyTasks}`);
  console.log(`Avg bounty:       ${result.avgBounty} HBAR`);
  console.log(`Monthly tasks:    ${result.monthlyTasks}`);
  console.log(`Monthly bounties: ${result.monthlyBounties} HBAR`);
  console.log(`Monthly revenue:  ${result.monthlyRevenue.toFixed(2)} HBAR`);
  console.log(`Annual revenue:   ${result.annualRevenue.toFixed(2)} HBAR`);
  console.log('');
} else {
  console.log('ClawSwarm Bounty Calculator');
  console.log('');
  console.log('Commands:');
  console.log('  payout <bountyHbar>              - Calculate payout breakdown');
  console.log('  project <dailyTasks> [avgBounty] - Project monthly revenue');
  console.log('');
  console.log('Example:');
  console.log('  node bounty-calculator.js payout 100');
  console.log('  node bounty-calculator.js project 10 50');
}

module.exports = { calculatePayout, calculateRevenue, estimateMonthlyRevenue };
