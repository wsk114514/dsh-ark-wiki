// Build a static, no-build-step demo page from real tool output.
//
//   node tools/build-demo.mjs
//
// Hits prts.wiki (story cast + operator dossiers + the story nav index), so the
// page is a *snapshot*: re-run it when the cast snapshot or the demo cases
// change, then commit docs/index.html.
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runBannerPrediction } from '../lib/banners.js';
import { resolveLookup } from '../lib/sources.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'docs');
const OUT_FILE = join(OUT_DIR, 'index.html');

const SIGNAL_LABELS = {
  story_appearance: '剧情高频出现',
  story_tie_in: '地区吻合',
  story_recent: '近期剧情活跃',
  collab_cameo: '联动出场（+2%）',
  alter_candidate: '长期无新剧情',
  long_tenure: '首次进池已超 4 年（+18%）',
  skin_rerun: '皮肤复刻',
  interval_overdue: '进店间隔超期',
  anniversary_window: '周年/季节窗口',
  merch_or_ep: '周边 / EP',
};

const CONFIDENCE_LABELS = { high: '高', medium: '中', low: '低' };
const KIND_LABELS = { new: '新角色', alter: '异格' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function splitSentences(text, limit = 24) {
  return String(text ?? '')
    .split(/(?<=[。！？])/u)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, limit);
}

function splitSegments(text, limit = 30) {
  return String(text ?? '')
    .split('；')
    .map((s) => s.trim().replace(/。$/, ''))
    .filter(Boolean)
    .slice(0, limit);
}

function signalTag(signal) {
  const label = SIGNAL_LABELS[signal] ?? signal;
  return `<span class="tag">${esc(label)}</span>`;
}

function candidateCard(candidate, index) {
  const confidence = candidate.confidence ?? 'low';
  const kind = candidate.kind === 'alter' ? 'alter' : 'new';
  const signals = Array.isArray(candidate.signals) ? candidate.signals.map(signalTag).join('') : '';
  return `
    <article class="candidate">
      <div class="candidate-head">
        <span class="rank">${String(index + 1).padStart(2, '0')}</span>
        <h3>${esc(candidate.operator)}</h3>
        <span class="kind ${kind}">${esc(KIND_LABELS[kind])}</span>
        <span class="confidence ${esc(confidence)}">置信度 ${esc(CONFIDENCE_LABELS[confidence] ?? confidence)}</span>
      </div>
      <p class="reason">${esc(candidate.reason)}</p>
      <div class="tags">${signals}</div>
    </article>`;
}

function predictionSection({ id, title, hint, result, note }) {
  const candidates = Array.isArray(result.candidates) ? result.candidates : [];
  // The dossier note is rendered again in its own panel below; cut it out of basis.
  const basisRaw = String(result.prediction_basis ?? '');
  const dossierIndex = basisRaw.search(/档案\/密录线索（/u);
  const basis = splitSegments(dossierIndex === -1 ? basisRaw : basisRaw.slice(0, dossierIndex));
  const caveats = splitSentences(result.caveats);
  const clues = Array.isArray(result.dossier_clues) ? result.dossier_clues : [];

  const candidateHtml = candidates.length
    ? candidates.map(candidateCard).join('')
    : '<p class="empty">本次没有候选（工具会给出原因）。</p>';

  const clueHtml = clues.length
    ? `<ul class="clues">${clues.map((clue) => `
        <li>
          <span class="clue-op">${esc(clue.operator)}</span>
          <span class="clue-src">${esc(clue.source)}${clue.title ? `·${esc(clue.title)}` : ''}</span>
          <span class="clue-text">「${esc(clue.text)}」</span>
        </li>`).join('')}
      </ul>`
    : '<p class="empty">本次没有摘到提及该地区的档案 / 密录片段（没有就跳过）。</p>';

  return `
  <section class="block" id="${esc(id)}">
    <div class="block-head">
      <h2>${esc(title)}</h2>
      <span class="hint">hint：${esc(hint)}</span>
    </div>
    <div class="candidates">${candidateHtml}</div>
    <div class="panels">
      <div class="panel">
        <h4>依据（prediction_basis）</h4>
        <ul class="basis">${basis.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      </div>
      <div class="panel">
        <h4>不确定性（caveats）</h4>
        <ul class="basis">${caveats.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>
      </div>
    </div>
    <div class="panel">
      <h4>档案 / 密录线索 <span class="weak">弱信号，不参与排序</span></h4>
      ${clueHtml}
    </div>
    ${note ? `<p class="note">${esc(note)}</p>` : ''}
  </section>`;
}

function lookupSection(envelope) {
  if (!envelope || envelope.status !== 'ok') {
    return `<section class="block"><h2>剧情查询示例</h2><p class="empty">查询未命中（${esc(envelope?.status)}）。</p></section>`;
  }
  const entry = envelope.entry ?? {};
  const counts = entry.counts ?? {};
  const appearances = Array.isArray(entry.appearances) ? entry.appearances : [];
  const rows = appearances.slice(0, 10).map((row) => `
    <tr>
      <td class="mono">${esc(row.date ?? '顺序估算')}</td>
      <td>${esc(row.title)}</td>
      <td class="mono">${esc(row.kind ?? '')}</td>
    </tr>`).join('');
  return `
  <section class="block" id="lookup">
    <div class="block-head">
      <h2>查资料：${esc(entry.operator ?? envelope.query)} 的登场时间线</h2>
      <span class="hint">query：${esc(envelope.query)}</span>
    </div>
    <div class="stats">
      <div class="stat"><span class="num">${esc(entry.total ?? '—')}</span><span class="label">总登场</span></div>
      <div class="stat"><span class="num">${esc(counts.main ?? 0)}</span><span class="label">主线</span></div>
      <div class="stat"><span class="num">${esc(counts.event ?? 0)}</span><span class="label">活动</span></div>
      <div class="stat"><span class="num">${esc(counts.memory ?? 0)}</span><span class="label">密录</span></div>
    </div>
    <p class="reason">最早登场：<strong>${esc(entry.earliest?.title ?? '—')}</strong>
      ${entry.earliest?.date ? `（${esc(entry.earliest.date)}）` : ''}；
      共 ${appearances.length} 条记录，下表只列前 10 条。</p>
    <table>
      <thead><tr><th>日期</th><th>剧情</th><th>类型</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </section>`;
}

function page({ generatedAt, sections, lookup, dataDate }) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>dsh-ark-wiki · 预测演示</title>
<meta name="description" content="dsh-ark-wiki 的真实输出快照：查询 PRTS Wiki，并基于 1495 段剧情卡司统计预测下一个进卡池的角色。">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎲</text></svg>">
<style>
  :root {
    color-scheme: dark;
    --bg: #101319;
    --panel: #171c24;
    --panel-2: #1d232d;
    --line: #2a323f;
    --text: #e7eaf0;
    --muted: #9aa6b8;
    --accent: #d8a13a;
    --high: #5cc98a;
    --medium: #d8a13a;
    --low: #8a94a6;
    --new: #6aa9ff;
    --alter: #c58cff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.7 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  }
  a { color: var(--accent); }
  .wrap { max-width: 980px; margin: 0 auto; padding: 48px 20px 72px; }
  header.hero { border-bottom: 1px solid var(--line); padding-bottom: 28px; margin-bottom: 36px; }
  .eyebrow { color: var(--accent); font-size: 12px; letter-spacing: .18em; text-transform: uppercase; }
  h1 { font-size: 30px; line-height: 1.3; margin: 10px 0 12px; }
  .lede { color: var(--muted); max-width: 720px; margin: 0 0 18px; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 18px; color: var(--muted); font-size: 13px; }
  code, .mono { font-family: ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace; }
  code { background: var(--panel-2); border: 1px solid var(--line); border-radius: 5px; padding: 1px 6px; font-size: 13px; }
  section.block { margin: 0 0 48px; }
  .block-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 12px; margin-bottom: 16px; }
  h2 { font-size: 21px; margin: 0; }
  .hint { color: var(--muted); font-size: 13px; }
  .candidates { display: grid; gap: 12px; }
  .candidate { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
  .candidate-head { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  .rank { color: var(--accent); font-family: ui-monospace, monospace; font-size: 13px; opacity: .8; }
  h3 { font-size: 18px; margin: 0; }
  .kind, .confidence { font-size: 12px; border-radius: 999px; padding: 2px 10px; border: 1px solid currentColor; }
  .kind.new { color: var(--new); }
  .kind.alter { color: var(--alter); }
  .confidence.high { color: var(--high); }
  .confidence.medium { color: var(--medium); }
  .confidence.low { color: var(--low); }
  .reason { margin: 10px 0 0; color: #cfd6e2; }
  .tags { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
  .tag { font-size: 12px; color: var(--muted); background: var(--panel-2); border: 1px solid var(--line); border-radius: 999px; padding: 2px 10px; }
  .panels { display: grid; gap: 12px; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); margin-top: 16px; }
  .panel { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px 18px; }
  .panel h4 { margin: 0 0 10px; font-size: 14px; color: var(--muted); font-weight: 600; }
  .weak { font-weight: 400; color: var(--low); font-size: 12px; }
  ul.basis, ul.clues { margin: 0; padding-left: 18px; }
  ul.basis li { margin: 0 0 6px; color: #cfd6e2; font-size: 13px; }
  ul.clues { list-style: none; padding: 0; }
  ul.clues li { border-top: 1px dashed var(--line); padding: 8px 0; font-size: 13px; color: #cfd6e2; }
  ul.clues li:first-child { border-top: 0; }
  .clue-op { color: var(--accent); }
  .clue-src { color: var(--low); margin: 0 6px; font-size: 12px; }
  .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin: 16px 0; }
  .stat { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px; text-align: center; }
  .stat .num { display: block; font-size: 24px; font-family: ui-monospace, monospace; color: var(--accent); }
  .stat .label { color: var(--muted); font-size: 12px; }
  table { width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
  th, td { text-align: left; padding: 9px 12px; border-bottom: 1px solid var(--line); font-size: 13px; }
  th { color: var(--muted); font-weight: 600; font-size: 12px; }
  tr:last-child td { border-bottom: 0; }
  .note, .empty { color: var(--low); font-size: 13px; }
  footer { border-top: 1px solid var(--line); margin-top: 24px; padding-top: 24px; color: var(--muted); font-size: 13px; }
  footer p { margin: 0 0 8px; }
  @media (max-width: 560px) {
    h1 { font-size: 24px; }
    .stats { grid-template-columns: repeat(2, 1fr); }
    table { display: block; overflow-x: auto; }
  }
</style>
</head>
<body>
<div class="wrap">
  <header class="hero">
    <div class="eyebrow">dsh-ark-wiki · demo</div>
    <h1>在 DSH 里查《明日方舟》，顺手预测下一个进卡池的人</h1>
    <p class="lede">下面不是截图，是插件真实输出的静态快照：查 PRTS Wiki 的干员 / 剧情 / 关卡 / 泰拉大典，并用 2019 年以来 1495 段剧情的卡司统计给出概率性预测。每条结论都带置信度、依据，以及「它可能错在哪」。</p>
    <div class="meta">
      <span>生成于 ${esc(generatedAt)}</span>
      <span>剧情数据快照：${esc(dataDate)}</span>
      <span><a href="https://github.com/wsk114514/dsh-ark-wiki">GitHub</a></span>
      <span><a href="https://www.npmjs.com/package/dsh-ark-wiki">npm</a></span>
      <span><a href="https://prts.wiki">PRTS Wiki</a></span>
    </div>
  </header>

  <section class="block" id="install">
    <div class="block-head"><h2>装上它</h2></div>
    <p><code>dsh plugin --profile web add dsh-ark-wiki</code></p>
    <p class="note">需要 DeepSeek Harness（DSH）。装好后直接问：「下个版本回阿戈尔的话，谁最可能实装？」「克莱门莎最早在哪个剧情出场？」</p>
  </section>

  ${sections.join('\n')}
  ${lookupSection(lookup)}

  <footer>
    <p><strong>这是概率性预测，不是官方排期。</strong>新角色是否上线由官方宣传与开发排期决定；剧情出场只是弱信号，<code>confidence: high</code> 只表示信号共振，不保证命中。</p>
    <p>数据版权归 Hypergryph / 《明日方舟》官方与 PRTS Wiki 所有；本页仅为个人非商业查询演示，与上述各方无隶属关系。预测口径、已知限制与数据来源见 <a href="https://github.com/wsk114514/dsh-ark-wiki#已知限制">README</a>。</p>
    <p>本页由 <code>tools/build-demo.mjs</code> 调用插件自身代码生成，重新运行即可刷新快照。</p>
  </footer>
</div>
</body>
</html>
`;
}

async function main() {
  const cases = [
    {
      id: 'kjerag',
      title: '卡西米尔：下个版本会出哪些新角色？',
      hint: '卡西米尔下个版本会出哪些新角色',
    },
    {
      id: 'columbia',
      title: '哥伦比亚：下一个可能角色',
      hint: '哥伦比亚地区的下一个可能角色',
    },
  ];

  const results = [];
  for (const testCase of cases) {
    process.stdout.write(`predict ${testCase.hint} ... `);
    const started = Date.now();
    const result = await runBannerPrediction({ hint: testCase.hint });
    console.log(`${Date.now() - started}ms, ${result.candidates?.length ?? 0} candidates`);
    results.push({ ...testCase, result });
  }

  process.stdout.write('lookup 克莱门莎 出场 ... ');
  const lookup = await resolveLookup('克莱门莎 出场', 'story');
  console.log(`${lookup.status}`);

  const generatedAt = new Date().toISOString().slice(0, 10);
  const dataDate = String(results[0]?.result?.prediction_basis ?? '').match(/数据生成于 ([\d-]+)/u)?.[1] ?? '未知';

  const sections = results.map((item) => predictionSection(item));
  const html = page({ generatedAt, dataDate, sections, lookup });

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, html, 'utf8');
  await writeFile(join(OUT_DIR, '.nojekyll'), '', 'utf8');
  console.log(`wrote ${OUT_FILE} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
