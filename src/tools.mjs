/**
 * tools.mjs — detect and (with consent) install the optional scanners
 * (gitleaks, semgrep). Installing software is a real, outward action, so:
 *   - default is NO (the prompt defaults to no),
 *   - we never auto-install in a non-interactive/CI run unless --install-tools,
 *   - we always print the exact command we'd run,
 *   - any failure falls back to the built-in scan (never fatal).
 */
import { execSync } from 'node:child_process';
import { createInterface } from 'node:readline';

const WIN = process.platform === 'win32';

export function hasTool(name) {
  try { execSync(WIN ? `where ${name}` : `command -v ${name}`, { stdio: 'ignore' }); return true; }
  catch { return false; }
}

/** Choose an install command from the package managers actually present. */
function installPlan(tool) {
  const plans = {
    gitleaks: [
      ['brew', 'brew install gitleaks'],
      ['go', 'go install github.com/gitleaks/gitleaks/v8@latest'],
      ['winget', 'winget install gitleaks'],
      ['choco', 'choco install gitleaks'],
      ['scoop', 'scoop install gitleaks'],
    ],
    semgrep: [
      ['pipx', 'pipx install semgrep'],
      ['brew', 'brew install semgrep'],
      ['pip3', 'pip3 install --user semgrep'],
      ['pip', 'pip install --user semgrep'],
      ['python', 'python -m pip install --user semgrep'],
      ['py', 'py -m pip install --user semgrep'],
      ['winget', 'winget install Semgrep.Semgrep'],
      ['choco', 'choco install semgrep'],
    ],
  }[tool] || [];
  for (const [mgr, cmd] of plans) if (hasTool(mgr)) return { mgr, cmd };
  return null;
}

function askYesNo(question) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => { rl.close(); res(/^y(es)?$/i.test(a.trim())); });
  });
}

/**
 * Ensure `tool` is available. Returns true if present (or successfully installed).
 * @param {object} o { autoYes, prompt }  autoYes = --install-tools; prompt=false = --no-prompt
 */
export async function ensureTool(tool, { autoYes = false, prompt = true } = {}) {
  if (hasTool(tool)) return true;
  const plan = installPlan(tool);
  const interactive = !!(process.stdin.isTTY || process.stdout.isTTY || process.env.TERM);

  if (!plan) {
    console.log(`  ${tool} isn't installed and no supported installer (brew/pipx/pip/go/winget/choco/scoop) was found — install it manually for a stronger scan.`);
    return false;
  }
  if (!autoYes) {
    if (!interactive || !prompt) {
      console.log(`  ${tool} isn't installed. For a stronger scan run:  ${plan.cmd}   (or re-run with --install-tools)`);
      return false;
    }
    const yes = await askYesNo(`  ${tool} isn't installed — install it now for a stronger scan?\n    ${plan.cmd}\n  [y/N] `);
    if (!yes) { console.log(`  Skipping ${tool}; using the built-in scan.`); return false; }
  }
  try {
    console.log(`  Installing ${tool} via ${plan.mgr} …`);
    execSync(plan.cmd, { stdio: 'inherit' });
  } catch {
    console.log(`  ${tool} install failed — continuing with the built-in scan.`);
    return false;
  }
  const ok = hasTool(tool);
  console.log(ok ? `  ${tool} installed.` : `  ${tool} still not on PATH — continuing with the built-in scan.`);
  return ok;
}
