/** Served at /static/app.css. No external fonts or assets: the dashboard works offline and leaks nothing. */
export const CSS = `
:root {
  --bg: #f7f7f5; --surface: #ffffff; --border: #e3e3df; --text: #1d1d1b; --muted: #6b6b66;
  --accent: #2f5bd3; --good: #1f7a4d; --warn: #a15c00; --bad: #b42318; --info: #2f5bd3;
  --good-bg: #e6f4ec; --warn-bg: #fdf1dc; --bad-bg: #fde8e6; --info-bg: #e8eefc; --neutral-bg: #efefec;
  --radius: 8px; --gap: 16px;
  font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; color-scheme: light dark;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #141413; --surface: #1d1d1b; --border: #33332f; --text: #ecece8; --muted: #9a9a94;
    --accent: #8aa8ff; --good: #5cc28c; --warn: #f0a640; --bad: #ff7b6e; --info: #8aa8ff;
    --good-bg: #183a28; --warn-bg: #3d2c10; --bad-bg: #44201c; --info-bg: #1e2a4a; --neutral-bg: #2a2a27;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); }
a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
h1 { font-size: 22px; margin: 0; } h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0; }
h3 { font-size: 15px; margin: 0 0 8px; }
code, pre { font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace; }
.top { position: sticky; top: 0; z-index: 2; display: flex; gap: var(--gap); align-items: center; padding: 10px 20px;
  background: var(--surface); border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.brand { font-weight: 700; color: var(--text); }
.top nav { display: flex; gap: 14px; flex-wrap: wrap; } .top nav a { color: var(--muted); } .top nav a:hover { color: var(--text); }
.search { margin-left: auto; } .search input { width: 260px; max-width: 60vw; }
main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 60px; }
.head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 0 0 14px; } .spacer { flex: 1; }
.lead { font-size: 15px; }
.muted, .mod { color: var(--muted); } .mod { font-size: 11px; margin-left: auto; }
.cols { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--gap); }
@media (max-width: 860px) { .cols { grid-template-columns: 1fr; } }
.panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; margin-bottom: var(--gap); }
.panel > header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: var(--gap); margin-bottom: var(--gap); }
.card { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; color: var(--text); }
.card:hover { border-color: var(--accent); text-decoration: none; }
.card dl { display: flex; gap: 18px; flex-wrap: wrap; margin: 0; } .card dt { color: var(--muted); font-size: 12px; } .card dd { margin: 0; font-size: 20px; font-weight: 600; }
.stats { display: flex; gap: var(--gap); flex-wrap: wrap; margin-bottom: var(--gap); }
.stats > div { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 14px; min-width: 120px; }
.stats b { display: block; font-size: 20px; } .stats span { color: var(--muted); font-size: 12px; }
dd.warn, b.warn, .warn { color: var(--warn); } dd.bad, .bad { color: var(--bad); } .good { color: var(--good); }
.badge { display: inline-block; padding: 0 7px; border-radius: 999px; font-size: 11px; line-height: 18px; background: var(--neutral-bg); color: var(--muted); white-space: nowrap; }
.badge.good { background: var(--good-bg); color: var(--good); } .badge.warn { background: var(--warn-bg); color: var(--warn); }
.badge.bad { background: var(--bad-bg); color: var(--bad); } .badge.info { background: var(--info-bg); color: var(--info); }
.due { font-size: 12px; color: var(--muted); white-space: nowrap; } .due.bad { color: var(--bad); font-weight: 600; } .due.warn { color: var(--warn); font-weight: 600; }
ul { padding-left: 18px; } ul.agenda, ul.feed, ul.tasks, ul.results, ul.mini, ol.log, ul.bars { list-style: none; padding: 0; margin: 0; }
ul.agenda li, ul.feed li, ul.results li { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; padding: 6px 0; border-top: 1px solid var(--border); }
ul.agenda li:first-child, ul.feed li:first-child, ul.results li:first-child { border-top: 0; }
ul.results li .muted { flex-basis: 100%; }
ul.mini li { color: var(--muted); font-size: 12px; margin-top: 4px; }
li.task { display: flex; gap: 8px; align-items: center; padding: 5px 0; border-top: 1px solid var(--border); }
li.task .t { flex: 1; } li.task.p1 .t { font-weight: 600; } li.task.p4 .t { color: var(--muted); }
ol.log li { padding: 8px 0; border-top: 1px solid var(--border); }
ul.tree { padding-left: 16px; margin: 2px 0; } .panel > ul.tree { padding-left: 0; list-style: none; }
.board { display: grid; grid-template-columns: repeat(6, minmax(150px, 1fr)); gap: 10px; overflow-x: auto; margin-bottom: var(--gap); }
.col { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; min-height: 120px; }
.col h3 { font-size: 12px; text-transform: uppercase; color: var(--muted); }
.job { display: flex; flex-direction: column; gap: 2px; padding: 8px; margin-bottom: 8px; border: 1px solid var(--border); border-radius: 6px; color: var(--text); background: var(--bg); }
.job.p1 { border-left: 3px solid var(--accent); } .job span { font-size: 12px; } .job small { color: var(--muted); }
table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 6px 6px; border-top: 1px solid var(--border); vertical-align: top; }
th { font-size: 12px; color: var(--muted); font-weight: 500; border-top: 0; } .num { text-align: right; font-variant-numeric: tabular-nums; }
ul.bars li { display: grid; grid-template-columns: 110px 1fr 90px; gap: 8px; align-items: center; padding: 3px 0; }
ul.bars b { text-align: right; font-variant-numeric: tabular-nums; } progress { width: 100%; height: 8px; accent-color: var(--accent); }
.spark svg { width: 100%; height: 70px; color: var(--accent); } .spark { margin: 0; }
.warnings { background: var(--warn-bg); color: var(--warn); border-radius: var(--radius); padding: 8px 12px 8px 28px; margin: 0 0 var(--gap); }
details.thesis { border-top: 1px solid var(--border); padding: 8px 0; } details summary { cursor: pointer; }
.md { overflow-wrap: anywhere; } .md pre { background: var(--bg); padding: 10px; border-radius: 6px; overflow-x: auto; }
.md table td, .md table th { border: 1px solid var(--border); } .md blockquote { margin: 0; padding-left: 12px; border-left: 3px solid var(--border); color: var(--muted); }
pre.wrap { white-space: pre-wrap; overflow-wrap: anywhere; }
.crumbs { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
.empty { color: var(--muted); margin: 4px 0; }
input, select, textarea, button { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 6px; padding: 6px 8px; }
textarea { width: 100%; resize: vertical; font: 13px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; }
button, .button { cursor: pointer; background: var(--accent); color: #fff; border-color: transparent; padding: 6px 12px; border-radius: 6px; display: inline-block; }
.button:hover { text-decoration: none; opacity: .9; }
button.ghost, .button.ghost { background: transparent; color: var(--muted); border: 1px solid var(--border); padding: 2px 8px; font-size: 12px; }
button.icon { background: transparent; color: var(--muted); border: 1px solid var(--border); width: 24px; height: 24px; padding: 0; line-height: 1; }
form.inline { display: inline; } .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; } .grow { flex: 1; min-width: 160px; }
.stack { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
.grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px; align-items: end; }
.grid label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--muted); } .grid .wide { grid-column: 1 / -1; }
`;
