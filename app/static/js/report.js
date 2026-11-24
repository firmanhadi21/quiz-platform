// Results dashboard of one game: winner, class numbers, student and question tables.
import { api, confirmBox, go, h, LETTERS, needTeacher, onLeave, show, spinner, t, toast, typeName, when } from './core.js';
import { distCounts, textCloud } from './host.js';
import { answerText, shareBox } from './pages.js';

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
const secs = (ms, n) => (n ? `${(ms / n / 1000).toFixed(1)} ${t('sec')}` : '–');
const grade = (p) => (p >= 70 ? 'on' : p >= 40 ? 'mid' : 'low');

function optionLabel(q, key) {
  if (key === '-') return t('no_answer_short');
  if (q.type === 'tf') return key === 'true' ? t('true') : t('false');
  if (q.options) return `${LETTERS[key]}. ${q.options[key]}`;
  return key;
}
function isRight(q, key) {
  if (q.type === 'tf') return String(q.answer) === key;
  if (q.type === 'single') return String(q.answer) === key;
  if (q.type === 'multi') return q.answer.includes(Number(key));
  if (q.type === 'text') return q.answer.some((a) => a.replace(/\s+/g, ' ').trim().toLowerCase() === key);
  return true;
}
function commonMistake(q) {
  const wrong = Object.entries(q.dist).filter(([k]) => k !== '-' && !isRight(q, k)).sort((a, b) => b[1] - a[1])[0];
  return wrong ? `${optionLabel(q, wrong[0])} (${wrong[1]}×)` : '–';
}

export async function report(code) {
  if (!needTeacher()) return;
  show(spinner());
  let stop = false, pending = 0;
  onLeave(() => { stop = true; clearTimeout(pending); });
  const draw = async (refresh) => {
    const r = await api(`/games/${code}/report`);
    if (stop) return;
    const y = window.scrollY;
    const wasOpen = !!document.querySelector('.q-details[open]');
    const open = r.status !== 'ended';
    const scoredQs = r.questions.filter((q) => q.type !== 'poll');
    const scored = scoredQs.length || 1;
    const players = r.players.map((p) => {
      const right = p.marks.filter((m) => m === 1).length, wrong = p.marks.filter((m) => m === 0).length;
      return { ...p, right, wrong, blank: scoredQs.length - right - wrong, acc: pct(right, scored) };
    });
    const n = players.length;
    const avgAcc = n ? Math.round(players.reduce((a, p) => a + p.acc, 0) / n) : 0;
    const avgScore = n ? Math.round(players.reduce((a, p) => a + p.score, 0) / n) : 0;
    const totalMs = players.reduce((a, p) => a + p.ms, 0), totalAns = players.reduce((a, p) => a + p.answered, 0);
    const act = async (path, method, then, body) => { try { await api(path, { method, body }); then(); } catch (e) { toast(e.message, true); } };
    const ranked = scoredQs.filter((q) => q.answered).map((q) => ({ q, i: r.questions.indexOf(q), p: pct(q.correct, q.answered) }));
    const hardest = ranked.slice().sort((a, b) => a.p - b.p)[0], easiest = ranked.slice().sort((a, b) => b.p - a.p)[0];
    const struggling = players.filter((p) => p.acc < 50);
    const buckets = [0, 0, 0, 0, 0];
    for (const p of players) buckets[Math.min(4, Math.floor(p.acc / 20))] += 1;
    const tallest = Math.max(1, ...buckets);
    // Rubric criteria: how the class did on the questions tagged with each one.
    const byCriterion = new Map();
    for (const q of scoredQs) {
      if (!q.criterion) continue;
      const c = byCriterion.get(q.criterion) || { n: 0, answered: 0, correct: 0 };
      c.n += 1; c.answered += q.answered; c.correct += q.correct;
      byCriterion.set(q.criterion, c);
    }
    const hasCriteria = r.questions.some((q) => q.criterion);
    const step = (p, cls) => (p ? h('div', { class: 'step ' + cls }, h('span', { class: 'step-name' }, p.name), h('span', { class: 'step-score' }, p.score),
      h('div', { class: 'step-block' }, cls === 'first' ? '🏆' : cls === 'second' ? '2' : '3')) : h('div', { class: 'step ghost' }));

    show(
      h('section', null,
        h('p', { class: 'eyebrow' }, t('results_dash'), ' · ', r.mode === 'live' ? t('live_game') : t('assignment'), ' · ', when(r.created), ' ',
          h('span', { class: 'badge ' + (open ? 'on' : 'off') }, open ? t('open') : t('ended'))),
        h('div', { class: 'head' }, h('h1', null, r.title),
          h('div', { class: 'row' },
            open && r.mode === 'live' ? h('a', { class: 'btn', href: '/host/' + code }, t('open_host')) : null,
            open && r.mode === 'async' ? h('button', { class: 'btn ghost', onclick: () => confirmBox(t('end_assign_q'), t('end_game'), () => act(`/games/${code}/end`, 'POST', draw)) }, t('end_game')) : null,
            h('a', { class: 'btn', href: '/review/' + code }, '▶ ', t('review_btn')),
            h('a', { class: 'btn ghost', href: `/api/games/${code}/report.csv`, download: '' }, '⬇ CSV'),
            h('button', { class: 'btn ghost', onclick: () => window.print() }, '🖨 ', t('print')),
            h('a', { class: 'btn ghost', href: '/wheel?game=' + code }, '◔ ', t('f_wheel')),
            h('button', { class: 'btn ghost', onclick: () => confirmBox(t('delete_game_q'), t('delete'), () => act('/games/' + code, 'DELETE', () => go('/dashboard'))) }, t('delete')))),
        open && r.mode === 'async' ? shareBox(code) : null,
        r.settings.deadline ? h('p', { class: 'muted' }, t('deadline'), ': ', when(r.settings.deadline)) : null,
        r.settings.anticheat ? h('p', { class: 'muted' }, '🛡 ', t('guard_on'), ': ',
          r.settings.penalty === 'zero' ? t('pen_zero') : r.settings.penalty === 'lock' ? t('pen_lock', { n: r.settings.lock_after }) : t('pen_record'),
          ' · ', t('guard_total', { n: r.players.reduce((a, p) => a + p.exits, 0), k: r.players.filter((p) => p.exits).length })) : null),

      n ? h('section', { class: 'winner-band' },
        h('div', { class: 'winner-text' }, h('p', { class: 'eyebrow light' }, open ? t('leading') : t('winner_label')),
          h('h2', null, players[0].name),
          h('p', null, `${players[0].score} ${t('pts')} · ${players[0].right}/${scored} ${t('correct_lc')} · ${t('avg_time')} ${secs(players[0].ms, players[0].answered)}`)),
        h('div', { class: 'steps' }, step(players[1], 'second'), step(players[0], 'first'), step(players[2], 'third')))
        : h('section', null, h('div', { class: 'empty' }, open ? t('no_players_yet') : t('no_players'))),

      n ? h('section', null,
        h('div', { class: 'stats' },
          h('div', null, h('strong', null, n), h('span', null, t('players'))),
          h('div', null, h('strong', null, avgAcc, '%'), h('span', null, t('accuracy'))),
          h('div', null, h('strong', null, avgScore), h('span', null, t('avg_score'))),
          h('div', null, h('strong', null, players[0].score), h('span', null, t('top_score'))),
          h('div', null, h('strong', null, players.filter((p) => p.finished).length, '/', n), h('span', null, t('finished'))),
          h('div', null, h('strong', null, secs(totalMs, totalAns)), h('span', null, t('avg_time')))),
        h('div', { class: 'dash-two' },
          h('div', { class: 'card' }, h('h3', null, t('spread')),
            h('div', { class: 'histo', role: 'img', 'aria-label': t('spread') }, buckets.map((b, i) => h('div', null,
              h('em', null, b), h('i', { class: i >= 3 ? 'good' : i >= 2 ? 'mid' : 'low', style: `height:${(b / tallest) * 100}%` }), h('span', null, `${i * 20}–${i * 20 + 20}%`)))),
            h('p', { class: 'muted small' }, t('spread_d'))),
          h('div', { class: 'card' }, h('h3', null, t('insights')),
            h('ul', { class: 'insights' },
              hardest ? h('li', null, h('b', null, t('hardest'), ': '), `${t('question')} ${hardest.i + 1} (${hardest.p}% ${t('correct_lc')}) — ${hardest.q.text.slice(0, 110)}`) : null,
              easiest && easiest !== hardest ? h('li', null, h('b', null, t('easiest'), ': '), `${t('question')} ${easiest.i + 1} (${easiest.p}% ${t('correct_lc')}) — ${easiest.q.text.slice(0, 110)}`) : null,
              h('li', null, h('b', null, t('need_help'), ': '), struggling.length ? struggling.map((p) => `${p.name} (${p.acc}%)`).join(', ') : t('nobody')))))) : null,

      n ? h('section', null, h('h2', null, t('student_table')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'marks' },
          h('thead', null, h('tr', null, ['#', t('name'), t('score'), t('correct'), t('wrong'), t('blank'), t('accuracy_short'), t('avg_time'),
            r.settings.anticheat ? t('exits_col') : null, ...r.questions.map((_, i) => i + 1)].filter((x) => x != null).map((x) => h('th', null, x)))),
          h('tbody', null, players.map((p, i) => h('tr', { class: i === 0 ? 'lead-row' : '' }, h('td', null, i === 0 ? '🏆' : i + 1),
            h('td', null, p.name, p.account ? h('small', { class: 'muted' }, ' ', p.email) : null),
            h('td', { class: 'mono' }, p.score), h('td', null, p.right), h('td', null, p.wrong), h('td', null, p.blank),
            h('td', null, h('span', { class: 'badge ' + grade(p.acc) }, p.acc, '%')), h('td', null, secs(p.ms, p.answered)),
            r.settings.anticheat ? h('td', { title: p.exit_questions.length ? `${t('questions')}: ${p.exit_questions.join(', ')}` : '' },
              p.exits ? h('span', { class: 'badge low' }, `${p.exits}× · ${p.away} ${t('sec')}`) : '–',
              p.locked ? h('button', { class: 'btn small', onclick: () => act(`/games/${code}/unlock`, 'POST', draw, { name: p.name }) }, '🔒 ', t('unlock')) : null) : null,
            p.marks.map((m, j) => h('td', { class: 'mark ' + (m === 1 ? 'y' : m === 0 ? 'n' : ''), title: `${t('question')} ${j + 1}` }, m === 1 ? '✓' : m === 0 ? '✗' : '·')))))))) : null,

      byCriterion.size ? h('section', null, h('h2', null, t('criterion_table')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'ctable' },
          h('thead', null, h('tr', null, [t('criterion'), t('questions'), t('accuracy_short')].map((x) => h('th', null, x)))),
          h('tbody', null, [...byCriterion].map(([name, c]) => { const p = pct(c.correct, c.answered); return h('tr', null,
            h('td', { class: 'wrap' }, name), h('td', null, c.n),
            h('td', null, h('span', { class: 'meter ' + grade(p) }, h('i', { style: `width:${Math.round(p * 0.8)}px` }), h('b', null, p, '%')))); }))))) : null,

      h('section', null, h('h2', null, t('question_table')),
        h('div', { class: 'table-wrap' }, h('table', { class: 'qtable' },
          h('thead', null, h('tr', null, ['#', t('question'), hasCriteria ? t('criterion') : null, t('q_type'), t('accuracy_short'), t('answered_col'), t('avg_time'), t('common_mistake')].filter(Boolean).map((x) => h('th', null, x)))),
          h('tbody', null, r.questions.map((q, i) => {
            const p = pct(q.correct, q.answered);
            return h('tr', null, h('td', null, i + 1), h('td', { class: 'wrap' }, q.text), hasCriteria ? h('td', { class: 'wrap narrow-col' }, q.criterion || '–') : null, h('td', null, typeName(q.type)),
              h('td', null, q.type === 'poll' ? '–' : h('span', { class: 'meter ' + grade(p) }, h('i', { style: `width:${Math.round(p * 0.8)}px` }), h('b', null, p, '%'))),
              h('td', null, `${q.answered}/${n}`), h('td', null, secs(q.ms, q.answered)), h('td', { class: 'wrap' }, q.type === 'poll' ? '–' : commonMistake(q)));
          })))),
        h('details', { class: 'q-details', open: wasOpen || null }, h('summary', null, t('answer_detail')),
          r.questions.map((q, i) => {
            const counts = distCounts(q, q.dist);
            const labels = q.type === 'tf' ? [t('true'), t('false')] : q.options;
            const right = (j) => (q.type === 'tf' ? q.answer === (j === 0) : q.type === 'single' ? q.answer === j : q.type === 'multi' ? q.answer.includes(j) : false);
            return h('article', { class: 'q-preview' }, h('p', { class: 'q-text' }, `${i + 1}. ${q.text}`),
              counts ? h('ul', { class: 'bars' }, labels.map((o, j) => h('li', { class: right(j) ? 'ok' : '' },
                h('span', null, h('b', null, q.type === 'tf' ? '' : LETTERS[j] + ' '), o, right(j) ? ' ✓' : ''),
                h('i', { style: `--w:${q.answered ? (counts[j] / q.answered) * 100 : 0}%` }), h('em', null, counts[j]))))
                : [h('p', { class: 'ok-line' }, '✓ ', answerText(q)), textCloud(q.dist)],
              q.explanation ? h('p', { class: 'muted small' }, q.explanation) : null);
          }))));
    if (refresh === true) window.scrollTo(0, y);
    if (open) pending = setTimeout(() => draw(true).catch(() => {}), 10000);
  };
  await draw();
}
