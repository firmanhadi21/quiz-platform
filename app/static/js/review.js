// Review after a game: step through the questions with the answer key, without replaying the quiz.
// The host sees how the class answered; a player sees their own answers.
import { api, canTeach, h, onLeave, playerToken, show, spinner, state, t, typeName } from './core.js';
import { answerKey, attachPassage, questionHead } from './play.js';
import { distCounts, textCloud } from './host.js';

const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

export async function reviewPage(code) {
  document.body.className = 'stage';
  show(spinner());
  const info = await api('/games/' + code);
  const teacher = info.host && canTeach();
  const data = teacher ? await api(`/games/${code}/report`) : await api(`/games/${code}/review`, { player: playerToken(code) || undefined });
  const passages = teacher ? data.settings.passages || [] : data.passages;
  const qs = data.questions;
  const from = Number(new URLSearchParams(location.search).get('q')) || 1;
  let at = Math.min(Math.max(from, 1), qs.length) - 1;
  let open = !teacher;  // the host reveals each answer when the class is ready; a player sees theirs at once

  const tone = (q) => {
    if (q.type === 'poll') return '';
    if (teacher) { const p = pct(q.correct, q.answered); return !q.answered ? '' : p >= 70 ? 'good' : p >= 40 ? 'mid' : 'bad'; }
    return !q.answered ? 'blank' : q.correct ? 'good' : 'bad';
  };

  function draw() {
    const q = qs[at], poll = q.type === 'poll';
    const counts = teacher && open ? distCounts(q, q.dist) : null;
    let verdict = null;
    if (teacher) {
      verdict = h('p', { class: 'lead center' }, poll ? t('answered_by', { n: q.answered }) : t('review_class', { p: pct(q.correct, q.answered), a: q.correct, n: q.answered }));
    } else if (!poll) {
      verdict = h('div', { class: 'verdict ' + (q.correct ? 'good' : 'bad') }, h('h1', null, !q.answered ? t('review_blank') : q.correct ? t('correct_excl') : t('wrong_excl')),
        h('p', null, '+', q.points, ' ', t('pts')));
    }
    show(h('section', { class: 'host review' },
      h('div', { class: 'host-bar' }, h('span', null, data.title, teacher ? '' : ` · ${data.name}`),
        h('span', null, t('q_of', { a: at + 1, b: qs.length }), ' · ', typeName(q.type), q.criterion && teacher ? ` · ${q.criterion}` : ''),
        h('a', { class: 'btn small ghost-light', href: teacher ? '/report/' + code : (state.user ? '/results' : '/') }, teacher ? t('results_dash') : t('close'))),
      h('div', { class: 'dots', role: 'tablist', 'aria-label': t('questions') }, qs.map((x, i) => h('button', { class: `dot ${tone(x)}${i === at ? ' on' : ''}`, role: 'tab',
        'aria-selected': i === at, 'aria-label': `${t('question')} ${i + 1}`, onclick: () => go(i) }, i + 1))),
      !teacher ? verdict : null,
      questionHead(q),
      q.type === 'text' ? [open ? answerKey(q, q.answer, teacher ? null : q.mine) : h('p', { class: 'lead center' }, t('type_answer')), teacher && open ? textCloud(q.dist) : null]
        : answerKey(q, open ? q.answer : null, teacher ? null : q.mine, counts),
      teacher && open ? verdict : null,
      open && q.explanation ? h('p', { class: 'explain' }, q.explanation) : null,
      h('div', { class: 'row center review-nav' },
        h('button', { class: 'btn ghost-light', disabled: at === 0, onclick: () => go(at - 1) }, '← ', t('review_prev')),
        teacher ? h('button', { class: 'btn big light', onclick: () => { open = !open; draw(); } }, open ? t('hide_answer') : t('show_answer')) : null,
        h('button', { class: 'btn ghost-light', disabled: at === qs.length - 1, onclick: () => go(at + 1) }, t('review_next'), ' →')),
      teacher ? h('p', { class: 'muted-light center small' }, t('review_keys')) : null));
    attachPassage(q.passage != null && passages[q.passage] ? passages[q.passage] : null);
  }
  function go(i) {
    if (i < 0 || i >= qs.length) return;
    at = i;
    if (teacher) open = false;
    history.replaceState(null, '', `/review/${code}?q=${at + 1}`);
    draw();
  }
  const keys = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') go(at + 1);
    else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(at - 1);
    else if (teacher && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); open = !open; draw(); }
  };
  document.addEventListener('keydown', keys);
  onLeave(() => document.removeEventListener('keydown', keys));
  draw();
}
