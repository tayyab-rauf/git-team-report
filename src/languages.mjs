/**
 * languages.mjs — per-language rule packs. Each pack supplies the file globs and
 * the code-quality + security rules appropriate to that stack, so the scanners
 * (which are pack-agnostic) produce meaningful results on TS, Java, or Flutter.
 *
 * On auto-detection every language present in the repo contributes its pack (plus
 * `generic`, which carries the config/secret globs), merged via `mergePacks` with
 * each pack's rules scoped to its own files. Config `language` / CLI `--lang`
 * forces a single pack instead.
 */
import { DEFAULT_RULES as TS_CODE_RULES, DEFAULT_GLOBS as TS_CODE_GLOBS } from './scan.mjs';
import { SECURITY_RULES as TS_SEC_RULES, SECURITY_GLOBS as TS_SEC_GLOBS, SECRET_RULES, CONFIG_GLOBS } from './security.mjs';
import { createPathMatcher } from './ignore.mjs';

// ── Java ──────────────────────────────────────────────────────────────────
const JAVA_CODE = [
  { key: 'sysout',     label: '<code>System.out/err</code>', re: /System\.(out|err)\.print/ },
  { key: 'stacktrace', label: '<code>printStackTrace()</code>', re: /\.printStackTrace\s*\(/ },
  { key: 'emptycatch', label: 'Empty catch block', re: /catch\s*\([^)]*\)\s*\{\s*\}/ },
  { key: 'streq',      label: '<code>==</code> on strings', re: /"\s*==|==\s*"/ },
  { key: 'todo',       label: 'TODO / FIXME', re: /\b(TODO|FIXME)\b/ },
];
const JAVA_SEC = [
  ...SECRET_RULES,
  { id: 'java-weak-hash', vector: 'Secrets', severity: 'High', review: true,
    re: /<password-encoder\s+[^>]*hash=["'](md5|sha|plaintext|none)["']|<password-encoder\s+[^>]*base64=["']true["']|\b(NoOpPasswordEncoder|Md5PasswordEncoder|ShaPasswordEncoder)\b|MessageDigest\.getInstance\s*\(\s*["'](MD5|SHA-1|SHA1)["']\s*\)/i,
    fix: 'Migrate to modern salted hashing (e.g. BCryptPasswordEncoder, Argon2PasswordEncoder) instead of legacy unsalted MD5/SHA.' },
  { id: 'java-sqli',  vector: 'Injection/XSS', severity: 'High', review: true,
    re: /(createQuery|createNativeQuery|prepareStatement|executeQuery|executeUpdate)\s*\([^)]*\+/,
    fix: 'Use parameterized queries / bound parameters instead of string concatenation.' },
  { id: 'java-cmd',   vector: 'Injection/XSS', severity: 'High', review: true,
    re: /Runtime\.getRuntime\(\)\.exec\s*\(|new\s+ProcessBuilder\s*\(/,
    fix: 'Avoid shell/exec with untrusted input; validate and pass an argument array, not a concatenated string.' },
  { id: 'java-deser', vector: 'Injection/XSS', severity: 'High', review: true,
    re: /new\s+ObjectInputStream\s*\(/,
    fix: 'Untrusted Java deserialization is dangerous — avoid it, or use an allowlist / a safe format (JSON).' },
  { id: 'java-upload', vector: 'LPDoS', severity: 'Low', review: true,
    re: /\bMultipartFile\b/,
    fix: 'Enforce a max upload size (e.g. spring.servlet.multipart.max-file-size) and validate before processing.' },
];

// ── Flutter / Dart ────────────────────────────────────────────────────────
const DART_CODE = [
  { key: 'print',      label: '<code>print()</code>', re: /(^|[^.\w])print\s*\(/ },
  { key: 'nullassert', label: 'Null assertion <code>!</code>', re: /\w!(\.|;|,|\)|\s*$)/ },
  { key: 'ignore',     label: '<code>// ignore:</code> lint', re: /\/\/\s*ignore:/ },
  { key: 'todo',       label: 'TODO / FIXME', re: /\b(TODO|FIXME)\b/ },
];
const DART_SEC = [
  ...SECRET_RULES,
  { id: 'dart-innerhtml', vector: 'Injection/XSS', severity: 'High', review: true,
    re: /\.innerHtml\s*=|setInnerHtml\s*\(/,
    fix: 'Avoid dart:html innerHtml with untrusted input; sanitize or use safe widgets.' },
  { id: 'dart-clipboard', vector: 'Clipboard', severity: 'Low', review: true,
    re: /Clipboard\.(setData|getData)\s*\(/,
    fix: 'Treat pasted content as untrusted; strip zero-width/control chars before rendering.' },
  { id: 'dart-mutation', vector: 'Replay', severity: 'Low', review: true,
    re: /\b(http|dio|client|_client)\.(post|put|patch|delete)\s*\(/i, pathInclude: /(checkout|payment|charge|billing|transfer|payout|refund)/i,
    fix: 'Add an idempotency key / nonce to sensitive mutations and disable the trigger while in flight.' },
];

// ── Generic fallback (unknown stack) ──────────────────────────────────────
const GENERIC_CODE = [{ key: 'todo', label: 'TODO / FIXME', re: /\b(TODO|FIXME)\b/ }];
const GENERIC_CODE_GLOBS = ['*.py', '*.rb', '*.go', '*.rs', '*.php', '*.cs', '*.kt', '*.swift', '*.scala', '*.c', '*.cc', '*.cpp', '*.h'];
const GENERIC_SEC_GLOBS = [...GENERIC_CODE_GLOBS, ...CONFIG_GLOBS];

export const LANGUAGES = {
  typescript: { id: 'typescript', label: 'TypeScript', detect: ['*.ts', '*.tsx'],
    codeGlobs: TS_CODE_GLOBS, codeRules: TS_CODE_RULES, secGlobs: TS_SEC_GLOBS, secRules: TS_SEC_RULES },
  java: { id: 'java', label: 'Java', detect: ['*.java'],
    codeGlobs: ['*.java'], codeRules: JAVA_CODE, secGlobs: ['*.java', ...CONFIG_GLOBS], secRules: JAVA_SEC },
  flutter: { id: 'flutter', label: 'Flutter / Dart', detect: ['*.dart'],
    codeGlobs: ['*.dart'], codeRules: DART_CODE, secGlobs: ['*.dart', ...CONFIG_GLOBS], secRules: DART_SEC },
  generic: { id: 'generic', label: 'Generic', detect: [],
    codeGlobs: GENERIC_CODE_GLOBS, codeRules: GENERIC_CODE, secGlobs: GENERIC_SEC_GLOBS, secRules: SECRET_RULES },
};

const EXT_LANG = { ts: 'typescript', tsx: 'typescript', js: 'typescript', jsx: 'typescript', mjs: 'typescript', cjs: 'typescript', java: 'java', dart: 'flutter' };

/** Count tracked files per known language and return the dominant one. */
export function detectLanguage(git) {
  const counts = { typescript: 0, java: 0, flutter: 0 };
  for (const f of git('ls-files').split('\n')) {
    if (!f || /node_modules|\.d\.ts$/.test(f)) continue;
    const ext = f.split('.').pop();
    const lang = EXT_LANG[ext];
    if (lang) counts[lang]++;
  }
  const [top, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return { id: n > 0 ? top : 'generic', counts };
}

/**
 * Restrict a pack's rules to that pack's own files, so merged packs don't
 * cross-contaminate (Java's `== on strings` must not fire inside .ts).
 * `pathInclude` is only ever consumed as `.test(file)`, so a matcher object does.
 */
function scopeRules(rules, globs) {
  const inPack = createPathMatcher(globs);
  return rules.map((r) => ({
    ...r,
    pathInclude: r.pathInclude ? { test: (f) => inPack(f) && r.pathInclude.test(f) } : { test: inPack },
  }));
}

/** Merge same-key rules by OR-ing their scopes, so one row per smell, not one per pack. */
function mergeRules(rules, key) {
  const out = new Map();
  for (const r of rules) {
    const prev = out.get(r[key]);
    if (!prev) { out.set(r[key], r); continue; }
    const [a, b] = [prev.pathInclude, r.pathInclude];
    out.set(r[key], { ...prev, pathInclude: { test: (f) => a.test(f) || b.test(f) } });
  }
  return [...out.values()];
}

/**
 * Union several packs into one. Every language present in the repo gets scanned
 * instead of only the dominant one — a polyglot repo used to leave everything but
 * the top language completely unmonitored.
 */
export function mergePacks(packs) {
  if (packs.length === 1) return packs[0];
  const uniq = (xs) => [...new Set(xs)];
  const named = packs.filter((p) => p.id !== 'generic').map((p) => p.label);
  return {
    id: packs.map((p) => p.id).join('+'),
    label: named.length ? named.join(' + ') : 'Generic',
    codeGlobs: uniq(packs.flatMap((p) => p.codeGlobs)),
    codeRules: mergeRules(packs.flatMap((p) => scopeRules(p.codeRules, p.codeGlobs)), 'key'),
    secGlobs: uniq(packs.flatMap((p) => p.secGlobs)),
    secRules: mergeRules(packs.flatMap((p) => scopeRules(p.secRules, p.secGlobs)), 'id'),
  };
}

/** Resolve a pack from an explicit id (cli/config) or auto-detection. */
export function resolvePack(git, explicit) {
  if (explicit && LANGUAGES[explicit]) return { pack: LANGUAGES[explicit], detected: null, source: 'explicit' };
  const { counts } = detectLanguage(git);
  // every detected language + generic (which carries the config/secret globs and
  // covers py/go/rb/… files no dedicated pack claims)
  const present = Object.keys(counts).filter((k) => counts[k] > 0).map((k) => LANGUAGES[k]);
  return { pack: mergePacks([...present, LANGUAGES.generic]), detected: counts, source: 'auto' };
}
