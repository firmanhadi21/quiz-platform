// Quiz editor: one card per question, saved as a whole.
import { api, go, h, LETTERS, lang, modal, needTeacher, onLeave, show, spinner, state, t, toast, typeName } from './core.js';

const TYPES = ['single', 'multi', 'tf', 'text', 'poll'];
const TIMES = [10, 20, 30, 45, 60, 90, 120, 180, 300];
const POINTS = [0, 500, 1000, 2000];

function blank(type) {
  const q = { type, text: '', image: '', time: 30, points: type === 'poll' ? 0 : 1000, explanation: '', criterion: '', passage: null };
  if (type === 'single') Object.assign(q, { options: ['', '', '', ''], answer: 0 });
  if (type === 'multi') Object.assign(q, { options: ['', '', '', ''], answer: [] });
  if (type === 'poll') q.options = ['', ''];
  if (type === 'tf') q.answer = true;
  if (type === 'text') q.answer = [''];
  return q;
}

// Paste format: blocks separated by a blank line. First line is the question, the lines after
// it are options, "*" marks a correct one. A single "= answer" line makes a typed-answer question.
export function parseText(text) {
  const out = [];
  for (const block of text.replace(/\r/g, '').split(/\n\s*\n/)) {
    const lines = block.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) continue;
    const question = lines[0].replace(/^\d+[.)]\s*/, '');
    const rest = lines.slice(1);
    if (rest.every((l) => l.startsWith('='))) {
      out.push({ ...blank('text'), text: question, answer: rest.map((l) => l.slice(1).trim()).filter(Boolean) });
      continue;
    }
    const options = [], right = [];
    for (const line of rest) {
      const star = line.startsWith('*');
      const label = line.replace(/^\*\s*/, '').replace(/^([a-fA-F][.)]|[-•])\s*/, '').trim();
      if (!label) continue;
      if (star) right.push(options.length);
      options.push(label);
    }
    if (options.length < 2) continue;
    const yesNo = options.map((o) => o.toLowerCase());
    if (options.length === 2 && right.length === 1 && ['benar', 'true'].includes(yesNo[0]) && ['salah', 'false'].includes(yesNo[1])) {
      out.push({ ...blank('tf'), text: question, answer: right[0] === 0 });
    } else if (right.length === 0) {
      out.push({ ...blank('poll'), text: question, options: options.slice(0, 6) });
    } else if (right.length === 1) {
      out.push({ ...blank('single'), text: question, options: options.slice(0, 6), answer: right[0] });
    } else {
      out.push({ ...blank('multi'), text: question, options: options.slice(0, 6), answer: right });
    }
  }
  return out;
}

export async function editor(id) {
  if (!needTeacher()) return;
  show(spinner());
  const quiz = id === 'new'
    ? { title: '', subject: '', description: '', public: false, questions: [blank('single')] }
    : await api('/quizzes/' + id);
  quiz.passages = quiz.passages || [];
  let dirty = false;
  const touch = () => { dirty = true; };
  const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  const list = h('div', { class: 'stack' });

  const field = (obj, key, attrs = {}, tag = 'input') => h(tag, { ...attrs, value: obj[key] ?? '', oninput: (e) => { obj[key] = e.target.value; touch(); } });
  const select = (obj, key, values, label) => h('select', { 'aria-label': label, onchange: (e) => { obj[key] = Number(e.target.value); touch(); } },
    values.map((v) => h('option', { value: v, selected: obj[key] === v }, label === t('time') ? `${v} ${t('sec')}` : `${v} ${t('pts')}`)));

  function optionRows(q, redraw) {
    const multi = q.type === 'multi';
    return [h('div', { class: 'opts' }, q.options.map((opt, j) => h('div', { class: 'opt-row' },
      q.type === 'poll' ? h('b', { class: 'opt-letter' }, LETTERS[j])
        : h('label', { class: 'opt-mark', title: t('mark_correct') },
          h('input', { type: multi ? 'checkbox' : 'radio', name: 'ans' + q._id, 'aria-label': `${t('mark_correct')} ${LETTERS[j]}`,
            checked: multi ? q.answer.includes(j) : q.answer === j,
            onchange: (e) => {
              if (multi) q.answer = e.target.checked ? [...q.answer, j].sort() : q.answer.filter((a) => a !== j);
              else q.answer = j;
              touch();
            } }), h('b', null, LETTERS[j])),
      h('input', { value: opt, maxlength: '300', placeholder: `${t('option')} ${LETTERS[j]}`, oninput: (e) => { q.options[j] = e.target.value; touch(); } }),
      q.options.length > 2 ? h('button', { class: 'icon', type: 'button', 'aria-label': t('remove_option'), onclick: () => {
        q.options.splice(j, 1);
        if (multi) q.answer = q.answer.filter((a) => a !== j).map((a) => (a > j ? a - 1 : a));
        else if (q.type === 'single') q.answer = q.answer === j ? 0 : q.answer > j ? q.answer - 1 : q.answer;
        touch(); redraw();
      } }, '×') : null))),
    q.options.length < 6 ? h('button', { class: 'btn small ghost', type: 'button', onclick: () => { q.options.push(''); touch(); redraw(); } }, '+ ', t('add_option')) : null,
    q.type === 'poll' ? null : h('p', { class: 'hint' }, multi ? t('hint_multi') : t('hint_single'))];
  }

  function card(q, i) {
    q._id = q._id || Math.random().toString(36).slice(2);
    const move = (d) => { const j = i + d; if (j < 0 || j >= quiz.questions.length) return; quiz.questions.splice(j, 0, quiz.questions.splice(i, 1)[0]); touch(); draw(); };
    const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', hidden: true, onchange: async () => {
      const f = file.files[0];
      if (!f) return;
      if (f.size > 2 * 1024 * 1024) return toast(t('img_big'), true);
      try { q.image = (await api('/uploads', { method: 'POST', body: f, raw: true })).url; touch(); draw(); } catch (e) { toast(e.message, true); }
    } });
    let body;
    if (q.type === 'tf') {
      body = h('div', { class: 'row' }, [true, false].map((v) => h('label', { class: 'pill' },
        h('input', { type: 'radio', name: 'tf' + q._id, checked: q.answer === v, onchange: () => { q.answer = v; touch(); } }), v ? t('true') : t('false'))));
    } else if (q.type === 'text') {
      body = h('label', null, t('accepted'), h('input', { value: q.answer.join('; '), placeholder: 'SRGI2013; SRGI 2013',
        oninput: (e) => { q.answer = e.target.value.split(';').map((s) => s.trim()).filter(Boolean); touch(); } }),
        h('span', { class: 'hint' }, t('hint_text')));
    } else body = optionRows(q, draw);
    return h('article', { class: 'q-card' },
      h('header', null, h('strong', null, `${i + 1}.`),
        h('select', { 'aria-label': t('q_type'), onchange: (e) => { const n = blank(e.target.value); Object.assign(n, { text: q.text, image: q.image, time: q.time, explanation: q.explanation, criterion: q.criterion || '', passage: q.passage ?? null });
          if (n.options && q.options) n.options = q.options.slice(); quiz.questions[i] = n; touch(); draw(); } },
          TYPES.map((x) => h('option', { value: x, selected: q.type === x }, typeName(x)))),
        select(q, 'time', TIMES.includes(q.time) ? TIMES : [...TIMES, q.time].sort((a, b) => a - b), t('time')),
        q.type === 'poll' ? null : select(q, 'points', POINTS.includes(q.points) ? POINTS : [...POINTS, q.points].sort((a, b) => a - b), t('points')),
        quiz.passages.length ? h('select', { class: 'pick-passage', 'aria-label': t('passage'), onchange: (e) => { q.passage = e.target.value === '' ? null : Number(e.target.value); touch(); } },
          h('option', { value: '', selected: q.passage == null }, t('no_passage')),
          quiz.passages.map((p, j) => h('option', { value: j, selected: q.passage === j }, `${t('passage')} ${j + 1}${p.title ? ': ' + p.title.slice(0, 30) : ''}`))) : null,
        h('span', { class: 'spacer' }),
        h('button', { class: 'icon', type: 'button', 'aria-label': t('move_up'), disabled: i === 0, onclick: () => move(-1) }, '↑'),
        h('button', { class: 'icon', type: 'button', 'aria-label': t('move_down'), disabled: i === quiz.questions.length - 1, onclick: () => move(1) }, '↓'),
        h('button', { class: 'icon', type: 'button', 'aria-label': t('duplicate'), onclick: () => { const c = JSON.parse(JSON.stringify(q)); delete c._id; quiz.questions.splice(i + 1, 0, c); touch(); draw(); } }, '⧉'),
        h('button', { class: 'icon', type: 'button', 'aria-label': t('delete'), disabled: quiz.questions.length === 1, onclick: () => { quiz.questions.splice(i, 1); touch(); draw(); } }, '×')),
      field(q, 'text', { rows: '2', maxlength: '2000', placeholder: t('q_ph'), 'aria-label': t('question') }, 'textarea'),
      h('div', { class: 'row' }, file,
        q.image ? [h('img', { class: 'q-img small', src: q.image, alt: '' }), h('button', { class: 'btn small ghost', type: 'button', onclick: () => { q.image = ''; touch(); draw(); } }, t('remove_image'))]
          : h('button', { class: 'btn small ghost', type: 'button', onclick: () => file.click() }, '🖼 ', t('add_image'))),
      body,
      field(q, 'explanation', { maxlength: '2000', placeholder: t('expl_ph'), 'aria-label': t('explanation') }),
      field(q, 'criterion', { class: 'criterion', maxlength: '120', placeholder: t('criterion_ph'), 'aria-label': t('criterion') }));
  }

  function draw() {
    list.replaceChildren(...quiz.questions.map(card));
    count.textContent = t('n_questions', { n: quiz.questions.length });
  }
  const count = h('span', { class: 'muted' });
  const passBox = h('div', { class: 'stack' });
  const words = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
  function drawPassages() {
    passBox.replaceChildren(...quiz.passages.map((p, j) => {
      const n = h('span', { class: 'muted small' }, t('n_words', { n: words(p.text) }));
      return h('article', { class: 'p-card' },
        h('header', null, h('strong', null, `${t('passage')} ${j + 1}`), n, h('span', { class: 'spacer' }),
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => { for (const q of quiz.questions) if (q.passage == null) q.passage = j; touch(); draw(); toast(t('passage_applied')); } }, t('passage_apply')),
          h('button', { class: 'icon', type: 'button', 'aria-label': t('remove_passage'), onclick: () => {
            quiz.passages.splice(j, 1);
            for (const q of quiz.questions) q.passage = q.passage === j ? null : q.passage > j ? q.passage - 1 : q.passage;
            touch(); drawPassages(); draw();
          } }, '×')),
        h('input', { value: p.title, maxlength: '200', placeholder: t('passage_title_ph'), 'aria-label': t('title'), oninput: (e) => { p.title = e.target.value; touch(); }, onchange: () => draw() }),
        h('textarea', { value: p.text, rows: '9', maxlength: '20000', placeholder: t('passage_text_ph'), 'aria-label': t('passage'), oninput: (e) => { p.text = e.target.value; n.textContent = t('n_words', { n: words(p.text) }); touch(); } }));
    }),
    h('div', { class: 'row' }, h('button', { class: 'btn small ghost', type: 'button', onclick: () => { quiz.passages.push({ title: '', text: '' }); touch(); drawPassages(); draw(); passBox.querySelector('.p-card:last-of-type input').focus(); } }, '+ ', t('add_passage')),
      h('span', { class: 'muted small' }, t('passages_d'))));
  }

  const addBar = h('div', { class: 'row add-bar' }, h('span', { class: 'muted' }, t('add_question'), ':'),
    TYPES.map((x) => h('button', { class: 'btn small ghost', type: 'button', onclick: () => { quiz.questions.push(blank(x)); touch(); draw(); list.lastChild.scrollIntoView({ behavior: 'smooth', block: 'center' }); list.lastChild.querySelector('textarea').focus(); } }, '+ ', typeName(x))),
    h('button', { class: 'btn small ghost', type: 'button', onclick: pasteDialog }, t('paste_many')),
    h('button', { class: 'btn small', type: 'button', onclick: aiDialog }, '✨ ', t('ai_button')));

  function pasteDialog() {
    const area = h('textarea', { rows: '12', placeholder: t('paste_ph') });
    const close = modal(t('paste_many'), h('div', { class: 'stack' }, h('p', { class: 'muted small pre' }, t('paste_help')), area), [
      h('button', { class: 'btn ghost', onclick: () => close() }, t('cancel')),
      h('button', { class: 'btn', onclick: () => {
        const found = parseText(area.value);
        if (!found.length) return toast(t('paste_none'), true);
        const empty = quiz.questions.length === 1 && !quiz.questions[0].text;
        quiz.questions = empty ? found : quiz.questions.concat(found);
        touch(); draw(); close(); toast(t('paste_added', { n: found.length }));
      } }, t('add'))]);
  }

  function aiDialog() {
    if (!state.ai) return toast(t('ai_off'), true);
    const material = h('textarea', { rows: '9', maxlength: '60000', placeholder: t('ai_material_ph'), 'aria-label': t('ai_material') });
    const status = h('p', { class: 'muted small', role: 'status' });
    const rubric = h('textarea', { rows: '4', maxlength: '20000', placeholder: t('ai_rubric_ph'), 'aria-label': t('ai_rubric') });
    const rubricStatus = h('p', { class: 'muted small', role: 'status' });
    const reader = (target, note) => {
      const input = h('input', { type: 'file', accept: '.pdf,.docx,.pptx,.txt,.md', hidden: true, onchange: async () => {
        const f = input.files[0];
        if (!f) return;
        if (f.size > 50 * 1024 * 1024) return toast(t('ai_file_big'), true);
        note.textContent = t('ai_reading', { name: f.name });
        try {
          const { text } = await api('/ai/extract', { method: 'POST', body: f, raw: true });
          target.value = (target.value.trim() ? target.value.trim() + '\n\n' : '') + text;
          note.textContent = t('ai_read', { name: f.name, n: text.length.toLocaleString() });
        } catch (e) { note.textContent = ''; toast(e.message, true); }
        input.value = '';
      } });
      return input;
    };
    const file = reader(material, status);
    const rubricFile = reader(rubric, rubricStatus);
    const pick = (values, chosen, label) => h('select', { 'aria-label': label }, values.map(([v, text]) => h('option', { value: v, selected: v === chosen }, text)));
    const count = pick([5, 10, 15, 20, 25].map((n) => [String(n), t('n_questions', { n })]), '10', t('ai_count'));
    const level = pick([['easy', t('ai_easy')], ['medium', t('ai_medium')], ['hard', t('ai_hard')]], 'medium', t('ai_level'));
    const language = pick([['id', 'Bahasa Indonesia'], ['en', 'English']], lang(), t('ai_language'));
    const kinds = ['single', 'tf', 'multi', 'text'].map((k) => [k, h('input', { type: 'checkbox', checked: k === 'single' || k === 'tf' })]);
    const notes = h('input', { maxlength: '500', placeholder: t('ai_notes_ph'), 'aria-label': t('ai_notes') });
    const reading = h('input', { type: 'checkbox', onchange: () => { if (reading.checked) language.value = 'en'; kindRow.hidden = rubricRow.hidden = reading.checked; } });
    const button = h('button', { class: 'btn', onclick: async () => {
      const types = kinds.filter(([, box]) => box.checked).map(([k]) => k);
      if (material.value.trim().length < 200) return toast(t('ai_short'), true);
      if (!types.length) return toast(t('ai_pick_type'), true);
      button.disabled = true;
      button.replaceChildren(h('span', { class: 'spinner light' }), ' ', t('ai_working'));
      try {
        const res = await api('/ai/generate', { method: 'POST', body: { material: material.value, count: Number(count.value),
          level: level.value, language: language.value, types, notes: notes.value, rubric: reading.checked ? '' : rubric.value, reading: reading.checked } });
        if (res.passage) { quiz.passages.push(res.passage); for (const q of res.questions) q.passage = quiz.passages.length - 1; drawPassages(); }
        const empty = quiz.questions.length === 1 && !quiz.questions[0].text;
        quiz.questions = empty ? res.questions : quiz.questions.concat(res.questions);
        if (!quiz.title && res.title) { quiz.title = res.title; titleInput.value = res.title; }
        touch(); draw(); close();
        toast(res.criteria.length ? t('ai_added_rubric', { n: res.questions.length, c: res.criteria.length }) : t('ai_added', { n: res.questions.length }));
      } catch (e) {
        toast(e.message, true);
        button.disabled = false;
        button.replaceChildren('✨ ', t('ai_generate'));
      }
    } }, '✨ ', t('ai_generate'));
    const kindRow = h('div', { class: 'row' }, kinds.map(([k, box]) => h('label', { class: 'pill' }, box, typeName(k))));
    const rubricRow = h('div', { class: 'stack' }, h('label', null, t('ai_rubric'), h('span', { class: 'hint' }, t('ai_rubric_d'))),
      h('div', { class: 'row' }, rubricFile, h('button', { class: 'btn small ghost', type: 'button', onclick: () => rubricFile.click() }, '📋 ', t('ai_rubric_upload')), rubricStatus),
      rubric);
    const close = modal(t('ai_title'), h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, t('ai_intro')),
      h('div', { class: 'row' }, file, h('button', { class: 'btn small ghost', type: 'button', onclick: () => file.click() }, '📄 ', t('ai_upload')), status),
      material,
      h('label', { class: 'check' }, reading, h('span', null, t('ai_reading'), h('small', null, t('ai_reading_d')))),
      rubricRow,
      h('div', { class: 'row' }, count, level, language),
      kindRow,
      notes,
      h('p', { class: 'muted small' }, t('ai_note'))),
    [h('button', { class: 'btn ghost', onclick: () => close() }, t('cancel')), button]);
  }

  const save = async (then) => {
    const body = { title: quiz.title, subject: quiz.subject, description: quiz.description, public: quiz.public,
      passages: quiz.passages, questions: quiz.questions.map(({ _id, ...q }) => q) };
    try {
      const res = await api(id === 'new' ? '/quizzes' : '/quizzes/' + id, { method: id === 'new' ? 'POST' : 'PUT', body });
      dirty = false;
      toast(t('saved'));
      if (then) go(then(res.id));
      else if (id === 'new') { window.removeEventListener('beforeunload', warn); go('/edit/' + res.id, true); }
    } catch (e) { toast(e.message, true); }
  };

  const titleInput = field(quiz, 'title', { maxlength: '200', placeholder: t('title_ph') });
  show(h('section', { class: 'editor' },
    h('div', { class: 'head sticky' }, h('h1', null, id === 'new' ? t('new_quiz') : t('edit_quiz')), count,
      h('div', { class: 'row' },
        h('button', { class: 'btn ghost', onclick: aiDialog }, '✨ ', t('ai_button')),
        h('button', { class: 'btn ghost', onclick: () => save((qid) => '/quiz/' + qid) }, t('save_close')),
        h('button', { class: 'btn', onclick: () => save() }, t('save')))),
    h('div', { class: 'card stack' },
      h('label', null, t('title'), titleInput),
      h('div', { class: 'two' },
        h('label', null, t('subject'), field(quiz, 'subject', { maxlength: '100', placeholder: t('subject_ph') })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: quiz.public, onchange: (e) => { quiz.public = e.target.checked; touch(); } }),
          h('span', null, t('make_public'), h('small', null, t('make_public_d'))))),
      h('label', null, t('description'), field(quiz, 'description', { rows: '2', maxlength: '1000' }, 'textarea'))),
    h('h2', { class: 'sec' }, t('passages')), passBox, h('h2', { class: 'sec' }, t('questions')), list, addBar));
  drawPassages();
  draw();
  if (id === 'new' && new URLSearchParams(location.search).get('ai')) aiDialog();
  onLeave(() => window.removeEventListener('beforeunload', warn));
}
