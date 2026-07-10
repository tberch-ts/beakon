// src/plans.js
// Plan definitions, account-status logic, and monitor limits.
import { now } from './db.js';

export const PLANS = {
  trial: {
    label: 'Trial',
    priceId: null,
    limit: parseInt(process.env.LIMIT_TRIAL || '5', 10),
  },
  starter: {
    label: 'Starter',
    priceId: process.env.STRIPE_PRICE_STARTER || null,
    limit: parseInt(process.env.LIMIT_STARTER || '20', 10),
    priceLabel: '$19/mo',
  },
  agency: {
    label: 'Agency',
    priceId: process.env.STRIPE_PRICE_AGENCY || null,
    limit: parseInt(process.env.LIMIT_AGENCY || '100', 10),
    priceLabel: '$49/mo',
  },
};

export function planForPriceId(priceId) {
  for (const [key, p] of Object.entries(PLANS)) {
    if (p.priceId && p.priceId === priceId) return key;
  }
  return null;
}

export function monitorLimit(user) {
  const plan = PLANS[user.plan] || PLANS.trial;
  return plan.limit;
}

/**
 * An account can run checks if it is a paying subscriber in good standing,
 * or still inside its trial window.
 */
export function isAccountActive(user) {
  if (user.subscription_status === 'active') return true;
  if (user.subscription_status === 'trialing') {
    return !user.trial_ends_at || user.trial_ends_at > now();
  }
  return false;
}

export function trialDaysLeft(user) {
  if (!user.trial_ends_at) return 0;
  return Math.max(0, Math.ceil((user.trial_ends_at - now()) / 86400));
}
