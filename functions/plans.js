// functions/plans.js
// Plan definitions, account-status logic, and monitor limits.
export const PLANS = {
  trial: { label: 'Trial', priceId: null, limit: 5 },
  starter: { label: 'Starter', limit: 20, priceLabel: '$19/mo' },
  agency: { label: 'Agency', limit: 100, priceLabel: '$49/mo' },
};

export const TRIAL_DAYS = 14;

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

export function priceIdFor(planKey, env) {
  if (planKey === 'starter') return env.STRIPE_PRICE_STARTER;
  if (planKey === 'agency') return env.STRIPE_PRICE_AGENCY;
  return null;
}

export function planForPriceId(priceId, env) {
  if (priceId && priceId === env.STRIPE_PRICE_STARTER) return 'starter';
  if (priceId && priceId === env.STRIPE_PRICE_AGENCY) return 'agency';
  return null;
}

export function monitorLimit(user) {
  return (PLANS[user.plan] || PLANS.trial).limit;
}

export function isAccountActive(user) {
  if (user.subscriptionStatus === 'active') return true;
  if (user.subscriptionStatus === 'trialing') {
    return !user.trialEndsAt || user.trialEndsAt > nowSec();
  }
  return false;
}

export function trialDaysLeft(user) {
  if (!user.trialEndsAt) return 0;
  return Math.max(0, Math.ceil((user.trialEndsAt - nowSec()) / 86400));
}
