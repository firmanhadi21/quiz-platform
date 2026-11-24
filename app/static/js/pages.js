// Home, join, sign in, dashboard, library, quiz page, my results.
import { api, canTeach, confirmBox, copy, fatal, go, h, joinUrl, LETTERS, loadMe, modal, needTeacher, needUser, playerToken, prettyCode,
  qr, show, spinner, state, t, toast, typeName, when } from './core.js';

const query = () => new URLSearchParams(location.search);

function codeBox() {
  const input = h('input', { class: 'code-input', inputmode: 'numeric', maxlength: '7', placeholder: '123 456',
    'aria-label': t('game_code'), autocomplete: 'off' });
  const form = h('form', { class: 'code-form', onsubmit: (e) => {
    e.preventDefault();
    const code = input.value.replace(/\D/g, '');
    if (code.length !== 6) return toast(t('code_six'), true);
    go('/join/' + code);
  } }, input, h('button', { class: 'btn big' }, t('join')));
  return form;
}

export function home() {
  document.body.className = 'stage';
  show(
    h('section', { class: 'hero' },
      h('h1', null, t('hero_title')),
      h('p', { class: 'lead' }, t('hero_lead')),
      codeBox()),
    h('section', { class: 'features' },
      feature('▶', t('f_live'), t('f_live_d')),
      feature('✎', t('f_assign'), t('f_assign_d')),
      feature('◔', t('f_wheel'), t('f_wheel_d'), '/wheel'),
      feature('▤', t('f_report'), t('f_report_d'))),
    h('section', { class: 'cta' },
      h('h2', null, t('cta_title')),
      h('p', null, t('cta_lead')),
      h('div', { class: 'row center' },
        h('a', { class: 'btn big light', href: state.user ? '/dashboard' : '/register' }, state.user ? (canTeach() ? t('dashboard') : t('my_results')) : t('register_free')),
        h('a', { class: 'btn big ghost-light', href: '/explore' }, t('explore')))));
}
function feature(icon, title, text, href) {
  return h(href ? 'a' : 'div', { class: 'feature', href }, h('span', { class: 'feature-icon', 'aria-hidden': 'true' }, icon),
    h('h3', null, title), h('p', null, text));
}

export async function join(code) {
  if (!code) { document.body.className = 'stage'; return show(h('section', { class: 'hero' }, h('h1', null, t('join_title')), codeBox())); }
  show(spinner());
  let game;
  try { game = await api('/games/' + code); } catch (e) {
    if (e.status !== 404) throw e;
    document.body.className = 'stage';
    return show(h('section', { class: 'hero' }, h('h1', null, t('no_game', { code: prettyCode(code) })), h('p', { class: 'lead' }, t('no_game_d')), codeBox()));
  }
  if (playerToken(code)) {  // already joined on this device
    try { await api('/play/' + code, { player: playerToken(code) }); return go('/play/' + code, true); } catch { playerToken(code, null); }
  }
  if (game.status === 'ended') {
    return show(h('section', { class: 'narrow center' }, h('h1', null, game.title), h('p', null, t('game_ended')),
      h('a', { class: 'btn', href: '/' }, t('home'))));
  }
  const enter = async (name) => {
    try {
      const res = await api(`/games/${code}/join`, { method: 'POST', body: { name } });
      playerToken(code, res.token);
      go('/play/' + code, true);
    } catch (e) { toast(e.message, true); }
  };
  if (game.require_login && !state.user) {
    return show(h('section', { class: 'narrow center card' }, h('h1', null, game.title), h('p', null, t('need_account')),
      h('div', { class: 'row center' },
        h('a', { class: 'btn', href: '/login?next=/join/' + code }, t('login')),
        h('a', { class: 'btn ghost', href: '/register?next=/join/' + code }, t('register')))));
  }
  const name = h('input', { maxlength: '30', required: true, placeholder: t('nickname'), value: state.user ? state.user.name.slice(0, 30) : '',
    'aria-label': t('nickname'), disabled: game.require_login, autocomplete: 'nickname' });
  show(h('section', { class: 'narrow center card' },
    h('p', { class: 'eyebrow' }, game.mode === 'live' ? t('live_game') : t('assignment'), ' · ', t('n_questions', { n: game.count })),
    h('h1', null, game.title),
    game.deadline ? h('p', { class: 'muted' }, t('deadline'), ': ', when(game.deadline)) : null,
    h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); enter(name.value.trim()); } },
      name, h('button', { class: 'btn big' }, t('join'))),
    game.require_login ? h('p', { class: 'muted small' }, t('joined_as_account')) : h('p', { class: 'muted small' }, t('nick_hint'))));
  if (!game.require_login) name.focus();
}

export function auth(mode) {
  const next = query().get('next');
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/dashboard';
  if (state.user) return go(safeNext, true);
  const reg = mode === 'register';
  if (reg && !state.registration) return show(h('section', { class: 'narrow center card' }, h('h1', null, t('register')), h('p', null, t('reg_closed'))));
  const f = {
    name: h('input', { required: true, maxlength: '60', autocomplete: 'name', placeholder: t('name_ph') }),
    email: h('input', { type: 'email', required: true, autocomplete: 'email', placeholder: 'nama@email.com' }),
    password: h('input', { type: 'password', required: true, minlength: '8', autocomplete: reg ? 'new-password' : 'current-password' }),
  };
  const error = h('p', { class: 'form-error', role: 'alert' });
  const button = h('button', { class: 'btn big' }, reg ? t('register') : t('login'));
  const submit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    button.disabled = true;
    try {
      await api(reg ? '/auth/register' : '/auth/login', { method: 'POST',
        body: { name: f.name.value, email: f.email.value, password: f.password.value } });
      await loadMe();
      go(safeNext, true);
    } catch (err) { error.textContent = err.message; button.disabled = false; }
  };
  const suffix = next ? '?next=' + encodeURIComponent(next) : '';
  show(h('section', { class: 'narrow card' },
    h('h1', null, reg ? t('register_title') : t('login_title')),
    h('form', { class: 'stack', onsubmit: submit },
      reg ? h('label', null, t('name'), f.name) : null,
      h('label', null, 'Email', f.email),
      h('label', null, t('password'), f.password, reg ? h('span', { class: 'hint' }, t('pw_hint')) : null),
      error, button),
    h('p', { class: 'muted' }, reg ? t('have_account') : t('no_account'), ' ',
      h('a', { href: (reg ? '/login' : '/register') + suffix }, reg ? t('login') : t('register'))),
    reg ? null : h('p', { class: 'muted small' }, t('forgot_pw'))));
  (reg ? f.name : f.email).focus();
}

// ---- starting a game
export function startDialog(quiz) {
  let mode = 'live';
  const box = (key, on) => h('input', { type: 'checkbox', checked: on, 'data-k': key });
  const opts = { shuffle_questions: box('shuffle_questions', false), shuffle_options: box('shuffle_options', true),
    show_answers: box('show_answers', true), require_login: box('require_login', false), timer: box('timer', false) };
  const deadline = h('input', { type: 'datetime-local' });
  const anticheat = h('input', { type: 'checkbox', onchange: () => { guardOpts.hidden = !anticheat.checked; } });
  const penalty = h('select', { 'aria-label': t('penalty'), onchange: () => { lockAfter.hidden = penalty.value !== 'lock'; } },
    [['record', t('pen_record')], ['zero', t('pen_zero')], ['lock', t('pen_lock_opt')]].map(([v, label]) => h('option', { value: v }, label)));
  const lockN = h('input', { type: 'number', min: '1', max: '10', value: '3', 'aria-label': t('lock_after') });
  const lockAfter = h('label', { hidden: true }, t('lock_after'), lockN);
  const guardOpts = h('div', { class: 'stack indent', hidden: true }, h('label', null, t('penalty'), penalty), lockAfter);
  const asyncOnly = h('div', { class: 'stack', hidden: true },
    h('label', { class: 'check' }, opts.timer, h('span', null, t('opt_timer'), h('small', null, t('opt_timer_d')))),
    h('label', null, t('deadline_opt'), deadline));
  const pick = (m) => { mode = m; tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.m === m)); asyncOnly.hidden = m !== 'async'; };
  const tab = (m, title, text) => h('button', { type: 'button', class: 'mode', 'data-m': m, onclick: () => pick(m) }, h('strong', null, title), h('span', null, text));
  const tabs = h('div', { class: 'modes' }, tab('live', t('live_game'), t('live_d')), tab('async', t('assignment'), t('assign_d')));
  const start = async () => {
    const body = { mode };
    for (const k in opts) body[k] = opts[k].checked;
    Object.assign(body, { anticheat: anticheat.checked, penalty: penalty.value, lock_after: Number(lockN.value) || 3 });
    if (mode === 'async' && deadline.value) body.deadline = new Date(deadline.value).getTime() / 1000;
    try {
      const { code } = await api(`/quizzes/${quiz.id}/games`, { method: 'POST', body });
      close();
      go(mode === 'live' ? '/host/' + code : '/report/' + code);
    } catch (e) { toast(e.message, true); }
  };
  const close = modal(t('start_title', { title: quiz.title }), h('div', { class: 'stack' }, tabs,
    h('label', { class: 'check' }, opts.shuffle_questions, h('span', null, t('opt_shuffle_q'))),
    h('label', { class: 'check' }, opts.shuffle_options, h('span', null, t('opt_shuffle_o'))),
    h('label', { class: 'check' }, opts.show_answers, h('span', null, t('opt_show'))),
    h('label', { class: 'check' }, opts.require_login, h('span', null, t('opt_login'), h('small', null, t('opt_login_d')))),
    h('label', { class: 'check' }, anticheat, h('span', null, '🛡 ', t('opt_guard'), h('small', null, t('opt_guard_d')))),
    guardOpts,
    asyncOnly),
  [h('button', { class: 'btn ghost', onclick: () => close() }, t('cancel')), h('button', { class: 'btn', onclick: start }, t('start'))]);
  pick('live');
}

export async function practice(quizId) {
  try {
    const res = await api(`/quizzes/${quizId}/practice`, { method: 'POST' });
    playerToken(res.code, res.token);
    go('/play/' + res.code);
  } catch (e) { toast(e.message, true); }
}

// Copy a quiz under a new name, e.g. one copy per class. The copy has its own ID, games and reports.
export function copyDialog(q, then) {
  const name = h('input', { maxlength: '200', value: q.mine ? `${q.title} (${t('copy_suffix')})`.slice(0, 200) : q.title, 'aria-label': t('copy_name') });
  const submit = async (e) => {
    e.preventDefault();
    if (!name.value.trim()) return name.focus();
    try {
      const r = await api(`/quizzes/${q.id}/duplicate`, { method: 'POST', body: { title: name.value.trim() } });
      close();
      toast(t('copied_quiz'));
      then(r.id);
    } catch (err) { toast(err.message, true); }
  };
  const close = modal(t('copy_title'), h('form', { class: 'stack', id: 'copy-quiz', onsubmit: submit },
    h('label', null, t('copy_name'), name), h('p', { class: 'muted small' }, t('copy_d'))),
  [h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, t('cancel')), h('button', { class: 'btn', form: 'copy-quiz' }, t('duplicate'))]);
  name.select();
}

export function shareBox(code) {
  return h('div', { class: 'share' }, qr(joinUrl(code), 5),
    h('div', null,
      h('p', { class: 'eyebrow' }, t('game_code')),
      h('p', { class: 'share-code' }, prettyCode(code)),
      h('p', { class: 'muted' }, t('share_how', { host: location.host })),
      h('button', { class: 'btn small ghost', onclick: () => copy(joinUrl(code)) }, t('copy_link'))));
}

// ---- dashboard
function quizCard(q, reload) {
  const act = (label, fn, cls = 'ghost') => h('button', { class: 'btn small ' + cls, onclick: fn }, label);
  return h('article', { class: 'quiz-card' },
    h(canTeach() ? 'a' : 'div', { class: 'quiz-card-main', href: canTeach() ? '/quiz/' + q.id : null },
      h('p', { class: 'eyebrow' }, q.subject || t('quiz'), q.public ? h('span', { class: 'badge' }, t('public')) : null),
      h('h3', null, q.title),
      h('p', { class: 'muted small' }, t('n_questions', { n: q.count }), ' · ', t('n_plays', { n: q.plays }),
        q.mine ? null : [' · ', q.author])),
    h('div', { class: 'row' },
      canTeach() ? act(t('host'), () => startDialog(q), '') : null,
      q.mine ? h('a', { class: 'btn small ghost', href: '/edit/' + q.id }, t('edit')) : null,
      canTeach() ? act(t('duplicate'), () => copyDialog(q, (id) => (q.mine && reload ? reload() : go('/edit/' + id)))) : null,
      state.user ? act(t('practice'), () => practice(q.id)) : h('a', { class: 'btn small', href: '/login?next=/explore' }, t('login_to_play')),
      (q.mine || (state.user && state.user.role === 'admin')) && reload ? act(t('delete'), () => confirmBox(t('delete_quiz_q', { title: q.title }), t('delete'), async () => {
        try { await api('/quizzes/' + q.id, { method: 'DELETE' }); reload(); } catch (e) { toast(e.message, true); }
      })) : null));
}

export async function dashboard() {
  if (!needUser()) return;
  if (!canTeach()) return go('/results', true);
  show(spinner());
  const [quizzes, games] = await Promise.all([api('/quizzes'), api('/games')]);
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: true, onchange: async () => {
    const file = fileInput.files[0];
    if (!file) return;
    try {
      const { id } = await api('/quizzes', { method: 'POST', body: JSON.parse(await file.text()) });
      go('/edit/' + id);
    } catch (e) { toast(e instanceof SyntaxError ? t('bad_json') : e.message, true); }
  } });
  show(
    h('section', null,
      h('div', { class: 'head' }, h('h1', null, t('my_quizzes')),
        h('div', { class: 'row' }, fileInput,
          h('button', { class: 'btn ghost', onclick: () => fileInput.click() }, t('import_json')),
          state.ai ? h('a', { class: 'btn ghost', href: '/edit/new?ai=1' }, '✨ ', t('ai_button')) : null,
          h('a', { class: 'btn', href: '/edit/new' }, '+ ', t('new_quiz')))),
      quizzes.length ? h('div', { class: 'grid' }, quizzes.map((q) => quizCard(q, dashboard)))
        : h('div', { class: 'empty' }, h('p', null, t('no_quizzes')),
          h('div', { class: 'row center' }, h('a', { class: 'btn', href: '/edit/new' }, t('new_quiz')), h('a', { class: 'btn ghost', href: '/explore' }, t('explore'))))),
    h('section', null,
      h('div', { class: 'head' }, h('h2', null, t('my_games')), h('a', { class: 'btn small ghost', href: '/results' }, t('my_results'))),
      games.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, [t('game_code'), t('quiz'), t('mode'), t('players'), t('date'), ''].map((x) => h('th', null, x)))),
        h('tbody', null, games.map((g) => h('tr', null,
          h('td', { class: 'mono' }, prettyCode(g.code)),
          h('td', null, g.title),
          h('td', null, g.mode === 'live' ? t('live_game') : t('assignment'), ' ',
            h('span', { class: 'badge ' + (g.status === 'ended' ? 'off' : 'on') }, g.status === 'ended' ? t('ended') : t('open'))),
          h('td', null, g.players), h('td', null, when(g.created)),
          h('td', { class: 'row end' },
            g.mode === 'live' && g.status !== 'ended' ? h('a', { class: 'btn small', href: '/host/' + g.code }, t('open_host')) : null,
            h('a', { class: 'btn small ghost', href: '/report/' + g.code }, t('report'))))))))
        : h('p', { class: 'muted' }, t('no_games'))));
}

export async function explore() {
  const input = h('input', { type: 'search', placeholder: t('search_ph'), value: query().get('q') || '', 'aria-label': t('search') });
  const list = h('div', { class: 'grid' });
  const load = async () => {
    list.replaceChildren(spinner());
    const found = await api('/explore?q=' + encodeURIComponent(input.value));
    list.replaceChildren(...(found.length ? found.map((q) => quizCard(q, () => load().catch(fatal))) : [h('p', { class: 'muted' }, t('none_found'))]));
  };
  show(h('section', null,
    h('div', { class: 'head' }, h('h1', null, t('explore')),
      h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); load().catch(fatal); } }, input, h('button', { class: 'btn ghost' }, t('search')))),
    h('p', { class: 'muted' }, t('explore_d')), list));
  await load();
}

export function answerText(q) {
  if (q.type === 'tf') return q.answer ? t('true') : t('false');
  if (q.type === 'text') return q.answer.join(' / ');
  return '';
}

export async function quizPage(id) {
  if (!needTeacher()) return;
  show(spinner());
  const q = await api('/quizzes/' + id);
  const dup = () => copyDialog(q, (newId) => go('/edit/' + newId));
  const download = () => {
    const blob = new Blob([JSON.stringify({ title: q.title, subject: q.subject, description: q.description, passages: q.passages, questions: q.questions }, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `quiz-${q.id}.json` });
    a.click();
    URL.revokeObjectURL(a.href);
  };
  show(
    h('section', null,
      h('p', { class: 'eyebrow' }, q.subject || t('quiz'), ' · ', q.author || state.user.name, q.public ? h('span', { class: 'badge' }, t('public')) : null),
      h('h1', null, q.title),
      q.description ? h('p', { class: 'lead-dark' }, q.description) : null,
      h('p', { class: 'muted' }, t('quiz_id'), ': ', h('span', { class: 'mono' }, q.id), ' · ', t('n_questions', { n: q.count }), ' · ', t('n_plays', { n: q.plays })),
      h('div', { class: 'row' },
        h('button', { class: 'btn', onclick: () => startDialog(q) }, '▶ ', t('host')),
        h('button', { class: 'btn ghost', onclick: () => practice(id) }, t('practice')),
        q.mine ? h('a', { class: 'btn ghost', href: '/edit/' + id }, t('edit')) : null,
        h('button', { class: 'btn ghost', onclick: dup }, t('duplicate')),
        h('button', { class: 'btn ghost', onclick: download }, t('export_json')))),
    h('section', null, h('h2', null, t('questions')),
      q.questions.map((x, i) => [x.passage != null && q.passages[x.passage] && (i === 0 || q.questions[i - 1].passage !== x.passage)
        ? h('article', { class: 'passage in-page' }, h('p', { class: 'eyebrow' }, t('passage'), ' ', x.passage + 1), q.passages[x.passage].title ? h('h3', null, q.passages[x.passage].title) : null,
          h('div', { class: 'passage-text' }, q.passages[x.passage].text.split(/\n\s*\n/).map((para) => h('p', null, para)))) : null,
      h('article', { class: 'q-preview' },
        h('p', { class: 'eyebrow' }, `${i + 1}. ${typeName(x.type)} · ${x.time} ${t('sec')} · ${x.points} ${t('pts')}`,
          x.criterion ? h('span', { class: 'badge crit' }, x.criterion) : null),
        h('p', { class: 'q-text' }, x.text),
        x.image ? h('img', { class: 'q-img small', src: x.image, alt: '', loading: 'lazy' }) : null,
        x.options ? h('ul', { class: 'opt-list' }, x.options.map((o, j) => {
          const ok = x.type === 'single' ? x.answer === j : x.type === 'multi' ? x.answer.includes(j) : false;
          return h('li', { class: ok ? 'ok' : '' }, h('b', null, LETTERS[j]), ' ', o, ok ? ' ✓' : '');
        })) : h('p', { class: 'ok-line' }, '✓ ', answerText(x)),
        x.explanation ? h('p', { class: 'muted small' }, x.explanation) : null)])));
}

export async function results() {
  if (!needUser()) return;
  show(spinner());
  const list = await api('/me/results');
  show(h('section', null, h('h1', null, t('my_results')),
    canTeach() ? null : h('p', { class: 'muted' }, t('student_note')),
    list.length ? h('div', { class: 'table-wrap' }, h('table', null,
      h('thead', null, h('tr', null, [t('quiz'), t('mode'), t('score'), t('correct'), t('rank'), t('date'), ''].map((x) => h('th', null, x)))),
      h('tbody', null, list.map((r) => h('tr', null, h('td', null, r.title),
        h('td', null, r.mode === 'live' ? t('live_game') : t('assignment')),
        h('td', { class: 'mono' }, r.score), h('td', null, `${r.correct}/${r.count}`), h('td', null, '#' + r.rank), h('td', null, when(r.when)),
        h('td', null, h('a', { class: 'btn small ghost', href: '/review/' + r.code }, t('review_link'))))))))
      : h('div', { class: 'empty' }, h('p', null, t('no_results')), h('a', { class: 'btn', href: '/' }, t('join_title')))));
}
