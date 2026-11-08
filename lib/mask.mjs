// One place that knows what a secret looks like inside free text. Used before anything is stored or served.
import { maskSecrets } from '../scan/refs.mjs';

const M = '‹secret›';

const PARAMS = [
  'token', 'key', 'access_token', 'api_key', 'apikey', 'secret', 'password', 'sig', 'signature',
  'refresh_token', 'client_secret', 'id_token', 'code', 'state',
  '[\\w.-]*signature', '[\\w.-]*security-token', '[\\w.-]*-token',
].join('|');
const JSON_KEYS = 'token|api_key|apikey|secret|password|refresh_token|client_secret|access_token';
const TOKENISH = '[A-Za-z0-9._~+/=-]{8,}';

const SHAPES = [
  [/:\/\/[^/\s?#]*@/g, `://${M}@`], // URL userinfo, greedy to the last @ of the authority
  [new RegExp(`(^|[\\s:"'(=\\[])(bearer|basic)\\s+${TOKENISH}`, 'gi'), `$1$2 ${M}`],
  [new RegExp(`(^|[?&])((?:${PARAMS}))=[^&\\s]+`, 'gi'), `$1$2=${M}`],
  [new RegExp(`("(?:${JSON_KEYS})"\\s*:\\s*)"[^"]+"`, 'gi'), `$1"${M}"`],
  [/\b(x-api-key|api-key|x-auth-token|cookie|set-cookie)\s*:\s*\S+/gi, `$1: ${M}`],
  [/ya29\.[\w.-]+/g, M],
  [/(^|\D)1\/\/[\w-]{10,}/g, `$1${M}`],
  [/sntry[su]_\w+/g, M],
  [/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, M],
];

export function maskText(text, secretValues = []) {
  let s = String(text ?? '');
  for (const [re, rep] of SHAPES) s = s.replace(re, rep);
  s = maskSecrets(s);
  for (const v of secretValues) {
    if (typeof v !== 'string' || v.length < 6) continue;
    s = s.split(v).join(M);
    // truncated echoes: first 12 chars, judged on the part after a scheme, and only if it looks random
    const base = v.includes('://') ? v.slice(v.indexOf('://') + 3) : v;
    const prefix = base.slice(0, 12);
    if (base.length >= 12 && /[a-z]/i.test(prefix) && /\d/.test(prefix)) s = s.split(prefix).join(M);
  }
  return s;
}
