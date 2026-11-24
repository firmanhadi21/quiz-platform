// Admin: accounts, roles and site settings. Plus "my account" for everyone.
import { api, applySite, confirmBox, h, loadMe, modal, needUser, show, spinner, state, t, toast, when } from './core.js';

const ROLES = ['student', 'teacher', 'admin'];
export const roleName = (role) => t('role_' + role);

function passwordBox(title, email, password) {
  const close = modal(title, h('div', { class: 'stack' },
    h('p', null, t('temp_pw_for', { email })),
    h('p', { class: 'temp-pw' }, password),
    h('p', { class: 'muted small' }, t('temp_pw_d'))),
  [h('button', { class: 'btn ghost', onclick: async () => { try { await navigator.clipboard.writeText(password); toast(t('copied_pw')); } catch { /* shown on screen */ } } }, t('copy')),
    h('button', { class: 'btn', onclick: () => close() }, t('close'))]);
}

export async function adminPage() {
  if (!needUser()) return;
  if (state.user.role !== 'admin') return show(h('section', { class: 'narrow center card' }, h('h1', null, 'Admin'), h('p', null, t('admin_only'))));
  show(spinner());
  const search = h('input', { type: 'search', placeholder: t('search_user_ph'), 'aria-label': t('search') });
  let filter = '';

  const draw = async () => {
    const data = await api('/admin/users?q=' + encodeURIComponent(search.value));
    const act = async (fn, done) => { try { const res = await fn(); if (done) done(res); await draw(); } catch (e) { toast(e.message, true); await draw(); } };
    const users = filter ? data.users.filter((u) => (filter === 'disabled' ? u.disabled : u.role === filter)) : data.users;
    const chip = (key, label, n) => h('button', { class: 'pill-btn' + (filter === key ? ' on' : ''), onclick: () => { filter = key; draw(); } }, label, n == null ? null : h('b', null, n));

    const row = (u) => {
      const me = u.id === state.user.id;
      return h('tr', { class: u.disabled ? 'off-row' : '' },
        h('td', null, h('strong', null, u.name), me ? h('span', { class: 'badge' }, t('you')) : null, h('br'), h('small', { class: 'muted' }, u.email)),
        h('td', null, h('select', { 'aria-label': `${t('role')}: ${u.name}`, disabled: me, onchange: (e) => act(() => api('/admin/users/' + u.id, { method: 'PATCH', body: { role: e.target.value } }),
          () => toast(t('role_changed', { name: u.name, role: roleName(e.target.value) }))) },
        ROLES.map((r) => h('option', { value: r, selected: u.role === r }, roleName(r))))),
        h('td', null, h('span', { class: 'badge ' + (u.disabled ? 'low' : 'on') }, u.disabled ? t('disabled') : t('active'))),
        h('td', { class: 'mono' }, `${u.quizzes} · ${u.games} · ${u.plays}`),
        h('td', null, when(u.created)),
        h('td', { class: 'row end' }, me ? h('a', { class: 'btn small ghost', href: '/account' }, t('my_account')) : [
          h('button', { class: 'btn small ghost', onclick: () => confirmBox(t('reset_pw_q', { name: u.name }), t('reset_pw'),
            () => act(() => api(`/admin/users/${u.id}/reset-password`, { method: 'POST' }), (res) => passwordBox(t('reset_pw'), u.email, res.password))) }, t('reset_pw')),
          h('button', { class: 'btn small ghost', onclick: () => act(() => api('/admin/users/' + u.id, { method: 'PATCH', body: { disabled: !u.disabled } })) }, u.disabled ? t('enable') : t('disable')),
          h('button', { class: 'btn small ghost danger-text', onclick: () => confirmBox(t('delete_user_q', { name: u.name, q: u.quizzes, g: u.games }), t('delete'),
            () => act(() => api('/admin/users/' + u.id, { method: 'DELETE' }))) }, t('delete'))]));
    };

    const s = data.settings;
    const site = data.site;
    const saveSite = (body) => act(() => api('/admin/settings', { method: 'PUT', body }), (res) => { state.site = res.site; applySite(res.site); toast(t('saved')); });
    const logoFile = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true, onchange: async () => {
      const f = logoFile.files[0];
      if (!f) return;
      try { const res = await api('/admin/logo', { method: 'POST', body: f, raw: true }); state.site = res; applySite(res); toast(t('saved')); await draw(); } catch (e) { toast(e.message, true); }
    } });
    const siteName = h('input', { value: site.name, maxlength: '60', 'aria-label': t('brand_name') });
    const orgName = h('input', { value: site.org, maxlength: '120', placeholder: t('brand_org_ph'), 'aria-label': t('brand_org') });
    const primary = h('input', { type: 'color', value: site.primary, 'aria-label': t('brand_primary') });
    const accent = h('input', { type: 'color', value: site.accent, 'aria-label': t('brand_accent') });
    const brandCard = h('section', { class: 'card stack' }, h('h2', null, t('brand_title')),
      h('p', { class: 'muted small' }, t('brand_d')),
      h('div', { class: 'brand-row' }, h('label', null, t('brand_name'), siteName), h('label', null, t('brand_org'), orgName)),
      h('div', { class: 'brand-row' },
        h('label', { class: 'check' }, primary, h('span', null, t('brand_primary'))),
        h('label', { class: 'check' }, accent, h('span', null, t('brand_accent'))),
        h('div', { class: 'row' }, logoFile, site.logo ? h('img', { class: 'logo-preview', src: site.logo, alt: t('brand_logo') }) : null,
          h('button', { class: 'btn small ghost', type: 'button', onclick: () => logoFile.click() }, site.logo ? t('brand_logo_change') : t('brand_logo_add')),
          site.logo ? h('button', { class: 'btn small ghost', type: 'button', onclick: async () => { try { const res = await api('/admin/logo', { method: 'DELETE' }); state.site = res; applySite(res); await draw(); } catch (e) { toast(e.message, true); } } }, t('brand_logo_remove')) : null)),
      h('div', { class: 'row' }, h('button', { class: 'btn', onclick: () => saveSite({ site_name: siteName.value, org_name: orgName.value, color_primary: primary.value, color_accent: accent.value }) }, t('save')),
        h('button', { class: 'btn ghost', onclick: () => saveSite({ color_primary: '#0f6b5f', color_accent: '#f0b429' }) }, t('brand_reset'))));
    show(
      h('section', null,
        h('div', { class: 'head' }, h('h1', null, t('admin_title')), h('button', { class: 'btn', onclick: addUser }, '+ ', t('add_user'))),
        h('div', { class: 'stats' },
          h('div', null, h('strong', null, data.totals.users), h('span', null, t('accounts'))),
          h('div', null, h('strong', null, data.totals.teacher), h('span', null, roleName('teacher'))),
          h('div', null, h('strong', null, data.totals.student), h('span', null, roleName('student'))),
          h('div', null, h('strong', null, data.totals.admin), h('span', null, roleName('admin'))),
          h('div', null, h('strong', null, data.totals.quizzes), h('span', null, t('quiz'))),
          h('div', null, h('strong', null, data.totals.games), h('span', null, t('games'))))),
      brandCard,
      h('section', { class: 'card stack' }, h('h2', null, t('site_settings')),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: s.registration, onchange: (e) => act(() => api('/admin/settings', { method: 'PUT', body: { registration: e.target.checked } }), () => toast(t('saved'))) }),
          h('span', null, t('set_registration'), h('small', null, t('set_registration_d')))),
        h('label', null, t('set_default_role'),
          h('select', { onchange: (e) => act(() => api('/admin/settings', { method: 'PUT', body: { default_role: e.target.value } }), () => toast(t('saved'))) },
            ['student', 'teacher'].map((r) => h('option', { value: r, selected: s.default_role === r }, roleName(r)))),
          h('span', { class: 'hint' }, t('set_default_role_d')))),
      h('section', null,
        h('div', { class: 'head' }, h('h2', null, t('accounts')),
          h('form', { class: 'row', onsubmit: (e) => { e.preventDefault(); draw().catch((err) => toast(err.message, true)); } }, search, h('button', { class: 'btn ghost' }, t('search')))),
        h('div', { class: 'row filter' }, chip('', t('all')), ROLES.map((r) => chip(r, roleName(r))), chip('disabled', t('disabled'))),
        users.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'users' },
          h('thead', null, h('tr', null, [t('account'), t('role'), t('status'), t('activity_col'), t('joined'), ''].map((x) => h('th', null, x)))),
          h('tbody', null, users.map(row)))) : h('p', { class: 'muted' }, t('no_users'))),
      h('section', null, h('h2', null, t('roles_title')),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, [t('can_do'), ...ROLES.map(roleName)].map((x) => h('th', null, x)))),
          h('tbody', null, [['perm_play', 1, 1, 1], ['perm_teach', 0, 1, 1], ['perm_ai', 0, 1, 1], ['perm_admin', 0, 0, 1]].map(([key, ...marks]) =>
            h('tr', null, h('td', { class: 'wrap' }, t(key)), marks.map((m) => h('td', { class: 'mark ' + (m ? 'y' : '') }, m ? '✓' : '–')))))))));
  };

  function addUser() {
    const name = h('input', { required: true, maxlength: '60', placeholder: t('name_ph') });
    const email = h('input', { type: 'email', required: true, placeholder: 'nama@email.com' });
    const role = h('select', null, ROLES.map((r) => h('option', { value: r, selected: r === 'teacher' }, roleName(r))));
    const submit = async (e) => {
      e.preventDefault();
      try {
        const res = await api('/admin/users', { method: 'POST', body: { name: name.value, email: email.value, role: role.value } });
        close();
        passwordBox(t('add_user'), email.value, res.password);
        await draw();
      } catch (err) { toast(err.message, true); }
    };
    const form = h('form', { class: 'stack', id: 'add-user', onsubmit: submit }, h('label', null, t('name'), name), h('label', null, 'Email', email), h('label', null, t('role'), role),
      h('p', { class: 'muted small' }, t('add_user_d')));
    const close = modal(t('add_user'), form, [h('button', { class: 'btn ghost', type: 'button', onclick: () => close() }, t('cancel')),
      h('button', { class: 'btn', form: 'add-user' }, t('add'))]);
  }

  await draw();
}

export async function accountPage() {
  if (!needUser()) return;
  const current = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const next = h('input', { type: 'password', required: true, minlength: '8', autocomplete: 'new-password' });
  const error = h('p', { class: 'form-error', role: 'alert' });
  const submit = async (e) => {
    e.preventDefault();
    error.textContent = '';
    try {
      await api('/auth/password', { method: 'POST', body: { current: current.value, new: next.value } });
      current.value = next.value = '';
      toast(t('pw_changed'));
    } catch (err) { error.textContent = err.message; }
  };
  await loadMe();
  const u = state.user;
  show(h('section', { class: 'narrow stack' },
    h('div', { class: 'card stack' }, h('h1', null, t('my_account')),
      h('p', null, h('strong', null, u.name), h('br'), h('span', { class: 'muted' }, u.email)),
      h('p', null, t('role'), ': ', h('span', { class: 'badge on' }, roleName(u.role))),
      u.role === 'student' ? h('p', { class: 'muted small' }, t('student_note')) : null),
    h('form', { class: 'card stack', onsubmit: submit }, h('h2', null, t('change_pw')),
      h('label', null, t('current_pw'), current),
      h('label', null, t('new_pw'), next, h('span', { class: 'hint' }, t('pw_hint'))),
      error, h('button', { class: 'btn' }, t('change_pw')))));
}
