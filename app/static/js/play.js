// What a player sees: live games over WebSocket, assignments over plain requests.
import { lockScreen, startGuard, stopGuard } from './guard.js';
import { $app, api, go, h, LETTERS, onLeave, playerToken, show, spinner, t, toast } from './core.js';

// ---- reading passages: shown alone first, then beside every question that belongs to them
const passageText = (p) => h('div', { class: 'passage-text' }, p.text.split(/\n\s*\n/).map((para) => h('p', null, para)));
export function showReading(p, k, footer) {
  show(h('section', { class: 'reading' },
    h('p', { class: 'eyebrow light' }, p.count > 1 ? t('reading_for', { a: k + 1, b: k + p.count }) : t('reading_for_one', { a: k + 1 })),
    h('div', { class: 'passage solo' }, p.title ? h('h1', null, p.title) : null, passageText(p)), footer));
}
export function attachPassage(p) {
  const main = $app().firstElementChild;
  if (!p || !main) return;
  $app().replaceChildren(h('div', { class: 'split' },
    h('aside', { class: 'passage', 'aria-label': t('passage') }, h('p', { class: 'eyebrow' }, t('passage')), p.title ? h('h2', null, p.title) : null, passageText(p)), main));
}

// ---- pieces shared with the host screen
export function clock(msLeft, seconds, onZero) {
  const bar = h('div', { class: 'clock-bar' });
  const num = h('span', { class: 'clock-num', 'aria-live': 'off' });
  const el = h('div', { class: 'clock' }, h('div', { class: 'clock-track' }, bar), num);
  const end = performance.now() + msLeft;
  let raf = 0, stopped = false;
  const tick = () => {
    if (stopped) return;
    const left = Math.max(0, end - performance.now());
    bar.style.width = `${Math.min(100, (left / (seconds * 1000)) * 100)}%`;
    num.textContent = Math.ceil(left / 1000);
    el.classList.toggle('low', left < 5000);
    if (left <= 0) { stopped = true; if (onZero) onZero(); return; }
    raf = requestAnimationFrame(tick);
  };
  tick();
  el.stop = () => { stopped = true; cancelAnimationFrame(raf); };
  return el;
}

export function questionHead(q, small) {
  return [h('h1', { class: 'q-title' + (small ? ' small' : '') }, q.text), q.image ? h('img', { class: 'q-img', src: q.image, alt: '' }) : null];
}

// Buttons/inputs for answering `q`. Calls send(answer) once.
function answerPad(q, send) {
  let sent = false;
  const once = (a) => { if (sent) return; sent = true; pad.classList.add('sent'); send(a); };
  let pad;
  if (q.type === 'single' || q.type === 'poll') {
    pad = h('div', { class: 'tiles' }, q.options.map((o, i) => h('button', { class: `tile c${i}`, onclick: (e) => { e.currentTarget.classList.add('picked'); once(i); } },
      h('b', null, LETTERS[i]), h('span', null, o))));
  } else if (q.type === 'tf') {
    pad = h('div', { class: 'tiles two' }, [true, false].map((v) => h('button', { class: `tile ${v ? 'c2' : 'c0'}`, onclick: (e) => { e.currentTarget.classList.add('picked'); once(v); } },
      h('b', null, v ? '✓' : '✗'), h('span', null, v ? t('true') : t('false')))));
  } else if (q.type === 'multi') {
    const chosen = new Set();
    const submit = h('button', { class: 'btn big light', disabled: true, onclick: () => once([...chosen].sort()) }, t('submit'));
    pad = h('div', null, h('p', { class: 'pad-hint' }, t('pick_many')),
      h('div', { class: 'tiles' }, q.options.map((o, i) => h('button', { class: `tile c${i}`, 'aria-pressed': 'false', onclick: (e) => {
        if (sent) return;
        chosen.has(i) ? chosen.delete(i) : chosen.add(i);
        e.currentTarget.classList.toggle('picked', chosen.has(i));
        e.currentTarget.setAttribute('aria-pressed', chosen.has(i));
        submit.disabled = !chosen.size;
      } }, h('b', null, LETTERS[i]), h('span', null, o)))),
      h('div', { class: 'row center pad-submit' }, submit));
  } else {
    const input = h('input', { class: 'text-answer', maxlength: '200', placeholder: t('type_answer'), autocomplete: 'off', 'aria-label': t('type_answer') });
    pad = h('form', { class: 'stack text-pad', onsubmit: (e) => { e.preventDefault(); if (input.value.trim()) once(input.value.trim()); } },
      input, h('button', { class: 'btn big light' }, t('submit')));
    setTimeout(() => input.focus(), 50);
  }
  return pad;
}

// The question with the right answer marked, and optionally what this player chose.
export function answerKey(q, answer, mine, counts) {
  if (q.type === 'text') {
    return h('div', { class: 'key-text' }, answer ? h('p', { class: 'ok-line big' }, '✓ ', answer.join(' / ')) : null,
      mine != null ? h('p', { class: 'muted-light' }, t('you_answered'), ': ', String(mine)) : null);
  }
  const options = q.type === 'tf' ? [t('true'), t('false')] : q.options;
  const value = (i) => (q.type === 'tf' ? i === 0 : i);
  const isRight = (i) => (answer == null ? false : Array.isArray(answer) ? answer.includes(i) : answer === value(i));
  const isMine = (i) => (mine == null ? false : Array.isArray(mine) ? mine.includes(i) : mine === value(i));
  const total = counts ? Math.max(1, counts.reduce((a, b) => a + b, 0)) : 0;
  return h('div', { class: 'tiles key' + (options.length === 2 ? ' two' : '') }, options.map((o, i) => h('div', {
    class: `tile c${q.type === 'tf' ? (i ? 0 : 2) : i}${answer != null && !isRight(i) ? ' dim' : ''}${isRight(i) ? ' right' : ''}${isMine(i) ? ' picked' : ''}` },
    h('b', null, q.type === 'tf' ? (i ? '✗' : '✓') : LETTERS[i]), h('span', null, o),
    isRight(i) ? h('em', null, '✓') : null,
    counts ? h('i', { class: 'count', style: `--w:${(counts[i] / total) * 100}%` }, counts[i]) : null)));
}

function podium(top) {
  return h('ol', { class: 'board' }, top.map((p, i) => h('li', { class: i < 3 ? 'top' + (i + 1) : '' },
    h('b', null, i + 1), h('span', null, p.name), h('em', null, p.score))));
}
export { podium };

// ---- player screens
let canReview = false;  // the teacher lets players see the answer key
export async function play(code) {
  const token = playerToken(code);
  if (!token) return go('/join/' + code, true);
  document.body.className = 'stage playing';
  show(spinner());
  let info;
  try { info = await api('/play/' + code + '?peek=1', { player: token }); } catch (e) {
    if (e.status === 401) { playerToken(code, null); return go('/join/' + code, true); }
    throw e;
  }
  canReview = !!info.show_answers;
  if (info.guard && !(await startGuard(code, token, info.guard))) return;  // rules first; no question is open yet
  document.body.className = 'stage playing' + (info.guard ? ' guarded' : '');
  return info.mode === 'live' ? playLive(code, token, info) : playAsync(code, token);
}

const frame = (name, score, ...kids) => h('section', { class: 'play' },
  h('div', { class: 'play-bar' }, h('span', null, name), h('strong', null, score, ' ', t('pts'))), kids);

function playLive(code, token, info) {
  let ws, closed = false, retry = 0, score = info.score, timer = null;
  const stopTimer = () => { if (timer) timer.stop(); timer = null; };
  const wait = (text) => h('div', { class: 'waiting' }, h('span', { class: 'spinner light' }), h('p', null, text));

  function handle(m) {
    if (m.t === 'lobby') {
      stopTimer();
      show(frame(info.name, score, h('div', { class: 'center' }, h('h1', null, t('you_are_in')), h('p', { class: 'lead' }, t('wait_start')),
        h('p', { class: 'muted-light' }, t('n_players', { n: m.count })))));
    } else if (m.t === 'question') {
      stopTimer();
      timer = clock(m.ms_left, m.q.time);
      const body = m.done ? wait(t('sent_wait')) : answerPad(m.q, (a) => {
        ws.send(JSON.stringify({ t: 'answer', qi: m.qi, answer: a }));
      });
      show(frame(info.name, score, h('p', { class: 'eyebrow light' }, t('q_of', { a: m.qi + 1, b: m.total })), timer, questionHead(m.q, true), body));
    } else if (m.t === 'answered') {
      const pad = document.querySelector('.play .tiles, .play .text-pad');
      const hint = document.querySelector('.pad-hint, .pad-submit');
      if (hint) hint.remove();
      if (pad) pad.after(wait(t('sent_wait')));
    } else if (m.t === 'reveal') {
      stopTimer();
      const you = m.you || {};
      score = you.score ?? score;
      const poll = m.q.type === 'poll';
      const verdict = poll ? t('thanks') : !you.answered ? t('no_answer') : you.correct ? t('correct_excl') : t('wrong_excl');
      show(frame(info.name, score,
        h('div', { class: 'verdict ' + (poll ? '' : you.correct ? 'good' : 'bad') }, h('h1', null, verdict),
          poll ? null : h('p', null, '+', you.points || 0, ' ', t('pts'), you.rank ? ` · ${t('rank')} #${you.rank}` : '')),
        questionHead(m.q, true), answerKey(m.q, m.answer, you.answer),
        m.explanation ? h('p', { class: 'explain' }, m.explanation) : null,
        h('p', { class: 'muted-light center' }, m.last ? t('wait_final') : t('wait_next'))));
    } else if (m.t === 'ended') {
      closed = true;
      stopTimer();
      stopGuard();
      const you = m.you;
      show(frame(info.name, you ? you.score : score,
        h('div', { class: 'center' }, h('p', { class: 'eyebrow light' }, t('final')),
          you ? [h('h1', { class: 'huge' }, '#', you.rank), h('p', { class: 'lead' }, t('of_players', { n: m.players, score: you.score }))] : null),
        podium(m.top),
        h('div', { class: 'row center' }, canReview ? h('a', { class: 'btn big light', href: '/review/' + code }, '▶ ', t('review_link')) : null,
          h('a', { class: 'btn ' + (canReview ? 'ghost-light' : 'light'), href: '/' }, t('home')))));
    } else if (m.t === 'kicked') {
      closed = true;
      playerToken(code, null);
      show(h('section', { class: 'hero' }, h('h1', null, t('kicked')), h('a', { class: 'btn light', href: '/' }, t('home'))));
    }
  }

  function connect() {
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${code}?player=${encodeURIComponent(token)}`);
    ws.onopen = () => { retry = 0; };
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      handle(m);
      if (m.t === 'reading') showReading(m.passage, m.qi, h('p', { class: 'muted-light center' }, t('reading_wait')));
      else if (m.t === 'question' || m.t === 'reveal') attachPassage(m.passage);
    };
    ws.onclose = (e) => {
      if (closed) return;
      if (e.code === 4401 || e.code === 4404) { playerToken(code, null); return go('/join/' + code, true); }
      retry += 1;
      toast(t('reconnecting'), true);
      setTimeout(() => { if (!closed) connect(); }, Math.min(8000, 800 * retry));
    };
  }
  connect();
  onLeave(() => { closed = true; stopTimer(); if (ws) ws.close(); });
}

async function playAsync(code, token, first) {
  let timer = null, left = false;
  onLeave(() => { left = true; if (timer) timer.stop(); });
  const load = async (state) => {
    const s = state || await api('/play/' + code, { player: token });
    if (left) return;
    if (s.guard && s.guard.locked) return lockScreen(code, token);
    if (s.finished) return done(s);
    if (s.reading) {  // read first; the question and its clock open when the student is ready
      const begin = h('button', { class: 'btn big light', onclick: () => api(`/play/${code}?start=${s.reading.k}`, { player: token }).then(load).catch((e) => toast(e.message, true)) }, t('start_answering'));
      showReading(s.reading, s.reading.k, h('div', { class: 'row center' }, begin));
      return;
    }
    const q = s.question;
    let answered = false;
    const send = async (a) => {
      if (answered) return;
      answered = true;
      if (timer) timer.stop();
      try { feedback(s, q, a, await api(`/play/${code}/answer`, { method: 'POST', player: token, body: { k: q.k, answer: a } })); }
      catch (e) { toast(e.message, true); if (e.status === 423) lockScreen(code, token); else if (e.status === 409 || e.status === 410) load(); else answered = false; }
    };
    timer = s.timer ? clock(s.ms_left, q.time, () => send(null)) : null;
    show(frame(s.name, s.score, h('p', { class: 'eyebrow light' }, t('q_of', { a: q.k + 1, b: s.total })),
      h('div', { class: 'progress' }, h('i', { style: `width:${(q.k / s.total) * 100}%` })), timer, questionHead(q, true), answerPad(q, send)));
    attachPassage(s.passage);
  };
  const feedback = (s, q, mine, r) => {
    const poll = q.type === 'poll';
    const verdict = poll ? t('thanks') : r.timed_out ? t('time_up') : r.correct ? t('correct_excl') : t('wrong_excl');
    const next = h('button', { class: 'btn big light', onclick: () => load().catch((e) => toast(e.message, true)) }, r.finished ? t('see_result') : t('next'));
    show(frame(s.name, r.score,
      h('div', { class: 'verdict ' + (poll ? '' : r.correct ? 'good' : 'bad') }, h('h1', null, verdict), poll ? null : h('p', null, '+', r.points, ' ', t('pts'), r.penalized ? ` · ${t('guard_zeroed')}` : '')),
      questionHead(q, true), answerKey(q, r.answer, mine),
      r.explanation ? h('p', { class: 'explain' }, r.explanation) : null,
      h('div', { class: 'row center' }, next)));
    attachPassage(s.passage);
    next.focus();
  };
  const done = (s) => {
    stopGuard();
    const you = s.standing.you;
    show(frame(s.name, s.score, h('div', { class: 'center' }, h('p', { class: 'eyebrow light' }, s.title),
      h('h1', { class: 'huge' }, s.score), h('p', { class: 'lead' }, t('result_line', { c: s.correct, n: s.total, rank: you ? you.rank : '-', players: s.standing.players }))),
    s.standing.players > 1 ? podium(s.standing.top) : null,
    h('div', { class: 'row center' }, canReview ? h('a', { class: 'btn big light', href: '/review/' + code }, '▶ ', t('review_link')) : null,
          h('a', { class: 'btn ' + (canReview ? 'ghost-light' : 'light'), href: '/' }, t('home')))));
  };
  await load(first);
}
