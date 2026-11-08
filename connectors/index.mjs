import health from './health.mjs';
import lemonsqueezy from './lemonsqueezy.mjs';
import gsc from './gsc.mjs';
import ga4 from './ga4.mjs';
import sentry from './sentry.mjs';
import vercel from './vercel.mjs';

export const CONNECTORS = [health, lemonsqueezy, gsc, ga4, sentry, vercel];
export const byId = (id) => CONNECTORS.find((c) => c.id === id);
