// Static hosts (Vercel) cannot fill in settings when the page is served, so this runs once at build time: it writes
// dist/config.js from the build's environment and adds a content-security policy to dist/index.html that allows the page
// to talk only to its own origin, the API and the Supabase project. (The container image does the same at start-up with
// docker/40-runtime-config.sh.)
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SAFE = /^[A-Za-z0-9:/._~%@-]+$/;

function checkUrl(name, value, { httpsOnly = false } = {}) {
  if (!SAFE.test(value)) throw new Error(`${name} contains characters that are not allowed`);
  if (!/^https?:\/\//.test(value) || (httpsOnly && !value.startsWith('https://'))) throw new Error(`${name} must start with ${httpsOnly ? 'https://' : 'http:// or https://'}`);
  return value.replace(/\/$/, '');
}
const originOf = (url) => new URL(url).origin;

/** Validates the environment and returns the text of config.js and the origins the page may connect to. */
export function buildRuntimeConfig(env) {
  const apiUrl = env.API_URL ?? env.VITE_API_URL;
  if (!apiUrl) throw new Error('Set API_URL to the public address of the Mudatex API, for example https://api.example.com');
  const api = checkUrl('API_URL', apiUrl);
  const supabaseUrl = env.SUPABASE_URL ?? '';
  const key = env.SUPABASE_PUBLISHABLE_KEY ?? '';
  if ((supabaseUrl && !key) || (!supabaseUrl && key)) throw new Error('Set both SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY, or neither');
  let supabase = '';
  if (supabaseUrl) {
    supabase = checkUrl('SUPABASE_URL', supabaseUrl, { httpsOnly: true });
    if (!SAFE.test(key)) throw new Error('SUPABASE_PUBLISHABLE_KEY contains characters that are not allowed');
    if (/^sb_secret_|service_role/.test(key)) throw new Error('That looks like a secret key. Use the publishable (anon) key only.');
  }
  const origins = [originOf(api), ...(supabase ? [originOf(supabase)] : [])];
  return {
    configJs: `window.__MUDATEX__ = { apiUrl: "${api}", supabaseUrl: "${supabase}", supabaseKey: "${key}" };\n`,
    connectOrigins: origins,
  };
}

export function contentSecurityPolicy(connectOrigins) {
  return `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${connectOrigins.join(' ')}; base-uri 'none'; form-action 'self'`;
}

/** Puts the policy first in <head>, replacing one written by an earlier run. */
export function injectCsp(html, policy) {
  const tag = `<meta http-equiv="Content-Security-Policy" content="${policy}" />`;
  const cleaned = html.replace(/\s*<meta http-equiv="Content-Security-Policy"[^>]*>/g, '');
  if (!/<head[^>]*>/.test(cleaned)) throw new Error('index.html has no <head>');
  return cleaned.replace(/<head[^>]*>/, (m) => `${m}\n    ${tag}`);
}

async function main() {
  const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
  const { configJs, connectOrigins } = buildRuntimeConfig(process.env);
  await writeFile(path.join(dist, 'config.js'), configJs);
  const indexPath = path.join(dist, 'index.html');
  await writeFile(indexPath, injectCsp(await readFile(indexPath, 'utf8'), contentSecurityPolicy(connectOrigins)));
  console.log(`Wrote dist/config.js and a content-security policy allowing: ${connectOrigins.join(', ')}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
