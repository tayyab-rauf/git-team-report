/**
 * render.mjs — turns config + collected metrics into a self-contained HTML page.
 * GitHub-style theme, theme-aware (light/dark), no external assets. Everything is
 * driven by data: N authors, dynamic month columns, config-defined matrix/blockers.
 */

export const STYLE = `<style>
:root{
  --bg:#FFFFFF; --surface:#F6F8FA; --surface-2:#EAEEF2; --border:#D0D7DE;
  --text:#1F2328; --muted:#656D76; --accent:#0969DA;
  --a:#1A7F37; --b:#0969DA; --c:#9A6700; --d:#CF222E;
  --crit:#CF222E; --high:#BC4C00; --warn:#9A6700; --info:#0969DA; --ok:#1A7F37;
  --heat:9,105,218; --nav-w:230px; --radius:8px;
  --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#0D1117; --surface:#161B22; --surface-2:#21262D; --border:#30363D;
  --text:#C9D1D9; --muted:#8B949E; --accent:#58A6FF;
  --a:#3FB950; --b:#58A6FF; --c:#D29922; --d:#F85149;
  --crit:#FF7B72; --high:#FF9B72; --warn:#E3B341; --info:#79C0FF; --ok:#3FB950; --heat:88,166,255;
}}
:root[data-theme="light"]{
  --bg:#FFFFFF; --surface:#F6F8FA; --surface-2:#EAEEF2; --border:#D0D7DE;
  --text:#1F2328; --muted:#656D76; --accent:#0969DA;
  --a:#1A7F37; --b:#0969DA; --c:#9A6700; --d:#CF222E;
  --crit:#CF222E; --high:#BC4C00; --warn:#9A6700; --info:#0969DA; --ok:#1A7F37; --heat:9,105,218;
}
:root[data-theme="dark"]{
  --bg:#0D1117; --surface:#161B22; --surface-2:#21262D; --border:#30363D;
  --text:#C9D1D9; --muted:#8B949E; --accent:#58A6FF;
  --a:#3FB950; --b:#58A6FF; --c:#D29922; --d:#F85149;
  --crit:#FF7B72; --high:#FF9B72; --warn:#E3B341; --info:#79C0FF; --ok:#3FB950; --heat:88,166,255;
}
*{box-sizing:border-box}
body{margin:0;font-family:var(--sans);background:var(--bg);color:var(--text);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none} a:hover{text-decoration:underline}
code,.mono{font-family:var(--mono);font-size:.86em}
.wrap{display:flex;min-height:100vh}
.sidebar{width:var(--nav-w);flex:0 0 var(--nav-w);position:sticky;top:0;height:100vh;overflow-y:auto;background:var(--surface);border-right:1px solid var(--border);padding:22px 16px}
.sidebar h1{font-size:14px;margin:0 0 2px;letter-spacing:-.01em}
.sidebar .repo{font-family:var(--mono);font-size:12px;color:var(--muted);margin-bottom:18px;word-break:break-all}
.sidebar nav a{display:block;padding:6px 10px;border-radius:6px;color:var(--text);font-size:13px;margin-bottom:2px}
.sidebar nav a:hover{background:var(--surface-2);text-decoration:none}
.sidebar nav .navlbl{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:16px 0 6px;padding-left:10px}
main{flex:1;min-width:0;padding:32px 40px 80px;max-width:1100px}
@media(max-width:820px){.wrap{flex-direction:column}.sidebar{width:auto;height:auto;position:static;border-right:none;border-bottom:1px solid var(--border)}.sidebar nav{display:flex;flex-wrap:wrap;gap:4px}.sidebar nav .navlbl{display:none}main{padding:24px 18px 60px}}
.page-head{border-bottom:1px solid var(--border);padding-bottom:20px;margin-bottom:28px}
.page-head h2{font-size:26px;margin:0 0 8px;letter-spacing:-.02em}
.page-head .meta{color:var(--muted);font-size:13px;display:flex;flex-wrap:wrap;gap:6px 18px}
.page-head .meta b{color:var(--text);font-weight:600}
.callout{margin-top:16px;padding:12px 14px;border-radius:var(--radius);background:color-mix(in srgb,var(--info) 12%,transparent);border:1px solid color-mix(in srgb,var(--info) 35%,transparent);font-size:13px}
section{margin-bottom:44px;scroll-margin-top:20px}
section>h3{font-size:19px;margin:0 0 4px;letter-spacing:-.01em}
section>.sub{color:var(--muted);font-size:13px;margin:0 0 18px}
.panel{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px}
.divider{height:1px;background:var(--border);border:0;margin:0 0 44px}
.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.mcard{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;display:flex;flex-direction:column;gap:12px}
.mcard .top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
.mcard .name{font-weight:600;font-size:15px}
.mcard .email{font-family:var(--mono);font-size:11px;color:var(--muted)}
.grades{display:flex;gap:6px;flex-shrink:0}
.pill{font-size:11px;font-weight:700;padding:3px 8px;border-radius:999px;white-space:nowrap;border:1px solid transparent;letter-spacing:.02em}
.pill .k{font-weight:500;opacity:.75;margin-right:3px}
.g-a{color:var(--a);background:color-mix(in srgb,var(--a) 14%,transparent);border-color:color-mix(in srgb,var(--a) 40%,transparent)}
.g-b{color:var(--b);background:color-mix(in srgb,var(--b) 14%,transparent);border-color:color-mix(in srgb,var(--b) 40%,transparent)}
.g-c{color:var(--c);background:color-mix(in srgb,var(--c) 14%,transparent);border-color:color-mix(in srgb,var(--c) 40%,transparent)}
.g-d{color:var(--d);background:color-mix(in srgb,var(--d) 16%,transparent);border-color:color-mix(in srgb,var(--d) 45%,transparent)}
.g-x{color:var(--muted);background:var(--surface-2);border-color:var(--border)}
.mcard .statline{display:flex;gap:16px;font-size:12px;color:var(--muted);flex-wrap:wrap}
.mcard .statline b{color:var(--text);font-weight:600;font-variant-numeric:tabular-nums}
.mcard .domain{font-size:12px;color:var(--muted);border-top:1px dashed var(--border);padding-top:9px}
.tick{color:var(--ok);font-weight:700} .up{color:var(--a);font-weight:700}
.bars{display:flex;flex-direction:column;gap:9px}
.bar-row{display:grid;grid-template-columns:110px 1fr 56px;align-items:center;gap:10px}
.bar-row .who{font-size:13px;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar-track{background:var(--surface-2);border-radius:5px;height:20px;overflow:hidden}
.bar-fill{height:100%;border-radius:5px;background:linear-gradient(90deg,color-mix(in srgb,var(--accent) 78%,transparent),var(--accent));min-width:3px;transition:width .6s cubic-bezier(.2,.7,.2,1)}
.bar-val{font-size:12px;font-variant-numeric:tabular-nums;color:var(--muted);text-align:right}
.matrix{overflow-x:auto}
.heat-table{border-collapse:separate;border-spacing:4px;font-size:12px}
.heat-table th{font-weight:500;color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.05em;padding:0 4px}
.heat-table td.who{text-align:right;padding-right:6px;font-size:13px}
.heat-cell{width:56px;height:30px;text-align:center;border-radius:5px;font-variant-numeric:tabular-nums;border:1px solid var(--border);font-weight:600}
.heat-cell.zero{color:var(--muted);font-weight:400;background:var(--surface)!important}
.legend{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--muted);margin-top:12px}
.legend .sw{width:22px;height:12px;border-radius:3px;border:1px solid var(--border)}
table.matrix-t{border-collapse:collapse;width:100%;font-size:13px;min-width:560px}
table.matrix-t th,table.matrix-t td{padding:8px 10px;text-align:center;border-bottom:1px solid var(--border)}
table.matrix-t th{color:var(--muted);font-weight:600;font-size:12px}
table.matrix-t td.rlbl{text-align:left;white-space:nowrap}
.mcell{display:inline-block;min-width:30px;padding:3px 8px;border-radius:6px;font-variant-numeric:tabular-nums;font-weight:600}
.mcell.z{color:var(--ok);background:color-mix(in srgb,var(--ok) 12%,transparent)}
.sevlist{display:flex;flex-direction:column;gap:10px}
.sev{display:grid;grid-template-columns:52px 1fr;border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:var(--surface)}
.sev .tag{display:flex;align-items:center;justify-content:center;font-weight:800;font-size:13px;color:#fff;padding:10px}
.sev.crit .tag{background:var(--crit)} .sev.high .tag{background:var(--high)} .sev.med .tag{background:var(--warn)}
.sev .body{padding:11px 14px}
.sev .body .path{font-family:var(--mono);font-size:12px;color:var(--accent);margin-bottom:3px;word-break:break-all}
.sev .body .desc{font-size:13px}
.sev .body .who{font-size:11px;color:var(--muted);margin-top:4px;text-transform:uppercase;letter-spacing:.04em}
.member{border:1px solid var(--border);border-radius:var(--radius);padding:20px 22px;margin-bottom:18px;background:var(--surface)}
.member .mhead{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;border-bottom:1px solid var(--border);padding-bottom:12px;margin-bottom:14px}
.member .mhead .name{font-size:17px;font-weight:600}
.member .mhead .line{font-family:var(--mono);font-size:12px;color:var(--muted);margin-top:3px}
.member h4{font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);margin:16px 0 8px}
.member ul{margin:0;padding-left:18px} .member li{margin-bottom:6px}
.acts{display:flex;flex-direction:column;gap:22px}
.tier h4{margin:0 0 10px;font-size:14px;display:flex;align-items:center;gap:8px}
.tier h4 .dot{width:9px;height:9px;border-radius:50%}
.tier.t1 .dot{background:var(--crit)} .tier.t2 .dot{background:var(--warn)} .tier.t3 .dot{background:var(--info)} .tier.t0 .dot{background:var(--muted)}
table.acts-t{border-collapse:collapse;width:100%;font-size:13px}
table.acts-t td,table.acts-t th{padding:9px 12px;text-align:left;border-bottom:1px solid var(--border);vertical-align:top}
table.acts-t td:first-child{width:34px;color:var(--muted);font-variant-numeric:tabular-nums}
.owner{font-size:11px;color:var(--muted);white-space:nowrap}
footer{border-top:1px solid var(--border);margin-top:40px;padding-top:18px;color:var(--muted);font-size:12px}
@media (prefers-reduced-motion:reduce){*{transition:none!important}}
:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
</style>`;

const MONTH_LBL = { '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr', '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug', '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec' };
const CRIT_RGB = '207,34,46';
const esc = (s) => String(s ?? '').replace(/&(?!(amp|lt|gt|#|quot);)/g, '&amp;');
const fmtK = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));
const gradeCls = (g) => { const c = (g || '')[0]; return c === 'A' ? 'g-a' : c === 'B' ? 'g-b' : c === 'C' ? 'g-c' : c === 'D' ? 'g-d' : 'g-x'; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const firstName = (n) => (n.startsWith('M. ') || n.startsWith('S. ') ? n : n.split(' ')[0]);

/**
 * @param {object} config  loaded config (authors, grades, matrix, blockers, members, actions, meta)
 * @param {Map<string,object>} metrics  email -> metrics from collect.metricsFor
 * @param {object} opts  { repoName, throughDate }
 */
export function renderReport(config, metrics, opts) {
  const { repoName, throughDate } = opts;
  const authors = config.authors.map((a) => ({ ...a, m: metrics.get(a.email) || { commits: 0, months: {}, convPct: 0, mi: 0, added: 0, deleted: 0, lastActive: null } }));
  const active = authors.filter((a) => a.m.commits > 0);
  const maxCommits = Math.max(...active.map((a) => a.m.commits), 1);

  const monthSet = new Set();
  for (const a of active) Object.keys(a.m.months).forEach((k) => monthSet.add(k));
  const monthCols = [...monthSet].sort().slice(-6);
  const maxMonth = Math.max(...active.flatMap((a) => monthCols.map((mc) => a.m.months[mc] || 0)), 1);
  const yr = throughDate.slice(0, 4);
  const mlabel = (ym) => MONTH_LBL[ym.slice(5)] + (ym.slice(0, 4) !== yr ? " '" + ym.slice(2, 4) : '');
  const cadence = (m) => monthCols.filter((mc) => m.months[mc]).map((mc) => `${mlabel(mc)} ${m.months[mc]}`).join(' / ');
  const heatBg = (v) => (v ? `background:rgba(var(--heat),${(0.15 + 0.85 * (v / maxMonth)).toFixed(2)})` : '');
  const cellBg = (label) => {
    const n = parseInt(String(label).replace(/[^\d]/g, ''), 10) || 0;
    if (n === 0) return { cls: 'mcell z', style: '' };
    return { cls: 'mcell', style: `background:rgba(${CRIT_RGB},${Math.min(0.06 + (n / 55) * 0.7, 0.7).toFixed(2)})` };
  };
  const lastDot = (d) => {
    if (!d) return '<span style="color:var(--muted)">—</span>';
    const stale = (Date.parse(throughDate) - Date.parse(d)) / 864e5 > 21;
    return `<span style="color:var(--${stale ? 'warn' : 'ok'})">${d} ${stale ? '○' : '●'}</span>`;
  };
  const badge = (a) => {
    if (!a.badge) return '';
    const k = a.badge.kind, cls = k === 'up' ? 'up' : k === 'tick' ? 'tick' : '';
    const style = k === 'warn' ? ' style="color:var(--warn)"' : '';
    const txt = k === 'warn' && /stalled/i.test(a.badge.text) ? `${a.badge.text} ${a.m.lastActive || ''}` : a.badge.text;
    return `<span class="${cls}"${style}>${txt}</span>`;
  };

  const cardAuthors = authors.filter((a) => !a.hideFromCards && a.m.commits > 0);
  const cards = cardAuthors.map((a) => `
      <div class="mcard"${a.highlight ? ' style="border-color:color-mix(in srgb,var(--a) 40%,var(--border))"' : ''}>
        <div class="top"><div><div class="name">${esc(a.name)}</div><div class="email">${esc(a.short || a.email)}</div></div>
          <div class="grades"><span class="pill ${gradeCls(a.gitGrade)}"><span class="k">Git</span>${a.gitGrade || '—'}</span><span class="pill ${gradeCls(a.codeGrade)}"><span class="k">Code</span>${a.codeGrade || '—'}</span></div></div>
        <div class="statline"><span><b>${a.m.commits}</b> commits</span><span><b>+${fmtK(a.m.added)}</b>/<b>−${fmtK(a.m.deleted)}</b></span><span><b>${a.m.convPct}%</b> conv</span><span><b>${a.m.mi}</b> MI</span>${badge(a)}</div>
        ${a.domain ? `<div class="domain">${a.domain}</div>` : ''}
      </div>`).join('');

  const bars = [...active].sort((x, y) => y.m.commits - x.m.commits).map((a) => `
        <div class="bar-row"><span class="who">${esc(firstName(a.name))}</span><div class="bar-track"><div class="bar-fill" style="width:${((a.m.commits / maxCommits) * 100).toFixed(1)}%"></div></div><span class="bar-val">${a.m.commits}</span></div>`).join('');

  const heatRows = active.map((a) => `
          <tr><td class="who">${esc(a.name)}</td>${monthCols.map((mc) => {
            const v = a.m.months[mc] || 0;
            return v ? `<td class="heat-cell" style="${heatBg(v)}">${v}</td>` : `<td class="heat-cell zero">—</td>`;
          }).join('')}<td style="padding-left:12px">${lastDot(a.m.lastActive)}</td></tr>`).join('');

  const im = config.issueMatrix;
  const matrixSection = im && im.rows && im.rows.length ? `
  <hr class="divider">
  <section id="issues">
    <h3>Code issues at a glance</h3>
    <p class="sub">${esc(im.note || 'Blame-attributed counts (editorial). The number is always shown — color only reinforces magnitude.')}</p>
    <div class="panel matrix">
      <table class="matrix-t">
        <thead><tr><th class="rlbl" style="text-align:left">Issue</th>${im.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead>
        <tbody>${im.rows.map((r) => `
          <tr><td class="rlbl">${r.label}</td>${r.values.map((v) => { const c = cellBg(v); return `<td><span class="${c.cls}"${c.style ? ` style="${c.style}"` : ''}>${v}</span></td>`; }).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
    ${im.footnote ? `<p class="sub" style="margin-top:12px">${im.footnote}</p>` : ''}
  </section>` : '';

  const blockersSection = config.shipBlockers && config.shipBlockers.length ? `
  <hr class="divider">
  <section id="blockers">
    <h3>Ship-blockers</h3>
    <p class="sub">Fix before next release.</p>
    <div class="sevlist">${config.shipBlockers.map((b) => `
      <div class="sev ${b.sev}"><div class="tag">${esc(b.id)}</div><div class="body">
        <div class="path">${esc(b.path)}</div><div class="desc">${b.desc}</div>${b.owner ? `<div class="who">Owner · ${esc(b.owner)}</div>` : ''}</div></div>`).join('')}
    </div>
  </section>` : '';

  const memberAuthors = authors.filter((a) => config.members && config.members[a.email]);
  const memberSection = memberAuthors.length ? `
  <hr class="divider">
  <section id="members">
    <h3>Member detail</h3>
${memberAuthors.map((a) => {
    const f = config.members[a.email];
    const line = `${a.m.commits} commits · ${cadence(a.m) || '—'} · ${a.m.convPct}% conventional · ${a.m.mi} MI`;
    const secs = f.sections.map((s) => `      <h4>${esc(s.h4)}</h4>\n      <ul>${s.items.map((i) => `<li>${i}</li>`).join('')}</ul>`).join('\n');
    const note = f.note ? `\n      <p class="sub" style="margin:6px 0 0">${f.note}</p>` : '';
    const hl = a.highlight ? ' style="border-color:color-mix(in srgb,var(--a) 45%,var(--border))"' : '';
    const head = f.headline ? ` <span class="up">${esc(f.headline)}</span>` : '';
    return `
    <div class="member" id="m-${slug(a.name)}"${hl}>
      <div class="mhead"><div><div class="name">${esc(a.name)}${head}</div><div class="line">${line}</div></div>
        <div class="grades"><span class="pill ${gradeCls(a.gitGrade)}"><span class="k">Git</span>${a.gitGrade || '—'}</span><span class="pill ${gradeCls(a.codeGrade)}"><span class="k">Code</span>${a.codeGrade || '—'}</span></div></div>
${secs}${note}
    </div>`;
  }).join('\n')}
  </section>` : '';

  let ai = 0;
  const actionsSection = config.actions && config.actions.length ? `
  <hr class="divider">
  <section id="actions">
    <h3>Action items</h3>
    <div class="acts">${config.actions.map((t) => `
      <div class="tier ${t.tier || 't2'}">
        <h4><span class="dot"></span>${esc(t.title)}</h4>
        <table class="acts-t"><tbody>${t.items.map((it) => `
          <tr><td>${++ai}</td><td>${it.text}</td>${it.owner ? `<td class="owner">${esc(it.owner)}</td>` : '<td></td>'}</tr>`).join('')}
        </tbody></table>
      </div>`).join('')}
    </div>
  </section>` : '';

  const navMembers = memberAuthors.map((a) => `    <a href="#m-${slug(a.name)}">${esc(a.name)}</a>`).join('\n');
  const teamCommits = active.reduce((n, a) => n + a.m.commits, 0);
  const title = esc(config.meta?.title || `Team Git & Code Quality Report — ${repoName}`);

  return `<title>${title}</title>
${STYLE}
<div class="wrap">
<nav class="sidebar">
  <h1>${esc(config.meta?.sidebarTitle || 'Team Quality Report')}</h1>
  <div class="repo">${esc(repoName)} · all branches</div>
  <nav>
    <div class="navlbl">Summary</div>
    <a href="#overview">Team overview</a>
    <a href="#activity">Activity cadence</a>
    ${matrixSection ? '<a href="#issues">Issue matrix</a>' : ''}
    ${blockersSection ? '<a href="#blockers">Ship-blockers</a>' : ''}
    ${navMembers ? '<div class="navlbl">Members</div>\n' + navMembers : ''}
    ${actionsSection ? '<div class="navlbl">Plan</div>\n    <a href="#actions">Action items</a>' : ''}
  </nav>
</nav>
<main>
  <header class="page-head">
    <h2>${esc(config.meta?.heading || 'Team Git & Code Quality Report')}</h2>
    <div class="meta">
      <span><b>Compiled</b> ${throughDate}</span>
      <span><b>Period</b> ${config.period?.start || '?'} → ${throughDate}</span>
      <span><b>Scope</b> all branches · ${teamCommits} commits</span>
    </div>
    ${config.meta?.callout ? `<div class="callout">${config.meta.callout}</div>` : ''}
  </header>

  <section id="overview">
    <h3>Team overview</h3>
    <p class="sub">Grades, pull stats, and ticket hygiene — ranked by commit volume across all branches.</p>
    <div class="cards">${cards}
    </div>
    <div class="panel" style="margin-top:20px">
      <h4 style="margin:0 0 14px;font-size:13px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted)">Commits by author · all branches</h4>
      <div class="bars">${bars}
      </div>
    </div>
  </section>

  <hr class="divider">

  <section id="activity">
    <h3>Activity cadence</h3>
    <p class="sub">Commits per month across the team's active window.</p>
    <div class="panel matrix">
      <table class="heat-table">
        <thead><tr><th></th>${monthCols.map((mc) => `<th>${mlabel(mc)}</th>`).join('')}<th style="padding-left:12px">Last active</th></tr></thead>
        <tbody>${heatRows}
        </tbody>
      </table>
      <div class="legend"><span>fewer</span><span class="sw" style="background:rgba(var(--heat),.19)"></span><span class="sw" style="background:rgba(var(--heat),.5)"></span><span class="sw" style="background:rgba(var(--heat),.8)"></span><span class="sw" style="background:rgba(var(--heat),1)"></span><span>more commits</span></div>
    </div>
  </section>
${matrixSection}${blockersSection}${memberSection}${actionsSection}

  <footer>
    Compiled ${throughDate} · git/pull stats auto-refreshed from live <code>git log --all</code> via <code>git-team-report</code> · grades &amp; findings from the config file.
  </footer>
</main>
</div>
`;
}
