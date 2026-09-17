#!/usr/bin/env node
/**
 * git-team-report — CLI entry.
 *
 *   git-team-report init            scaffold a config from this repo's git history
 *   git-team-report build           pull live git data, render the HTML, print the delta
 *
 * Flags:
 *   --cwd <path>       run against another repo (default: current directory)
 *   --config <file>    config path (default: ./git-team-report.config.json)
 *   --out <file>       output HTML path (default: ./git-team-report.html)
 *   --full             ignore the saved footprint and recompute from period start
 *   --force            (init) overwrite an existing config
 *   -h, --help         show this help
 */
import { init, build, security } from '../src/commands.mjs';

const argv = process.argv.slice(2);
const cmd = argv[0];
const flag = (name) => { const i = argv.indexOf(name); return i !== -1; };
const val = (name, def) => { const i = argv.indexOf(name); return i !== -1 && argv[i + 1] ? argv[i + 1] : def; };
const allVals = (name) => {
  const res = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === name && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      res.push(...argv[i + 1].split(',').map((s) => s.trim()).filter(Boolean));
    }
  }
  return res;
};

const HELP = `git-team-report — graphical team git & code-quality report

Usage:
  git-team-report init [--cwd <path>] [--force]
  git-team-report build [--cwd <path>] [--config <file>] [--out <file>] [--full] [--no-scan]
  git-team-report security [--cwd <path>] [--out <file>]

Commands:
  init      Discover authors from git history and write git-team-report.config.json
  build     Pull live git metrics, render the HTML report, print what changed
  security  Scan for 6 vulnerability vectors (ReDoS, secrets, injection/XSS,
            LPDoS, clipboard, replay) → structured Markdown report

Flags:
  --cwd <path>         target repo (default: current directory)
  --config <file>      config path (default: ./git-team-report.config.json)
  --out <file>         output HTML (default: ./git-team-report.html)
  --no-scan            skip the code-quality blame scan (git stats only, faster)
  --no-security        skip the security scan section in the HTML report
  --no-grades          omit letter grade badges from the HTML report
  --exclude <pattern>  exclude paths from metrics and scans (e.g. "legacy/**")
  --disable-rule <id>  disable specific smell or security rule (e.g. "lpdos-file")
  --no-gitleaks        force built-in secret patterns even if gitleaks is installed
  --semgrep            also run Semgrep SAST (needs semgrep installed; slower)
  --lang <id>          force a language pack: typescript | java | flutter | generic
                       (default: auto-detected from the repo's dominant language)
  --install-tools      auto-install missing gitleaks/semgrep (no prompt) then scan
  --no-prompt          never prompt to install; just print the install hint
  --full               ignore the saved footprint; recompute from the period start
  --force              (init) overwrite an existing config
  -h, --help           show this help

After building, publish/serve the generated HTML however you like (it is a single
self-contained file). Edit the config's grades & findings; git numbers refresh
themselves on every build.`;

try {
  const cwd = val('--cwd', process.cwd());
  if (!cmd || flag('-h') || flag('--help') || cmd === 'help') {
    console.log(HELP);
    process.exit(0);
  }
  const common = {
    installTools: flag('--install-tools'),
    prompt: !flag('--no-prompt'),
    exclude: allVals('--exclude'),
    disableRule: allVals('--disable-rule'),
  };
  if (cmd === 'init') {
    init({ cwd, force: flag('--force') });
  } else if (cmd === 'build') {
    await build({
      cwd, configPath: val('--config'), outPath: val('--out'),
      full: flag('--full'), scan: !flag('--no-scan'), security: !flag('--no-security'),
      noGrades: flag('--no-grades') || flag('--hide-grades'),
      gitleaks: !flag('--no-gitleaks'), semgrep: flag('--semgrep'), lang: val('--lang'),
      ...common,
    });
  } else if (cmd === 'security') {
    await security({
      cwd, outPath: val('--out'), gitleaks: !flag('--no-gitleaks'),
      semgrep: flag('--semgrep'), lang: val('--lang'), ...common,
    });
  } else {
    console.error(`Unknown command: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
  }
} catch (err) {
  console.error(`\n  Error: ${err.message}\n`);
  process.exit(1);
}
