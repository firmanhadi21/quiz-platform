// Browser run of a whole class session: one teacher, two students on phones.
//   BASE=http://127.0.0.1:8765 PLAYWRIGHT=/path/to/node_modules/playwright ADMIN_EMAIL=... ADMIN_PW=... bun tests/e2e.mjs [shots-dir]
// The admin account is made first with:  python app/manage.py create <email> Admin admin
const { chromium } = await import(process.env.PLAYWRIGHT || 'playwright');
const BASE = process.env.BASE || 'http://127.0.0.1:8765';
const SHOTS = process.argv[2];
const stamp = Date.now();
const problems = [];
let passed = 0;
let allow401 = false;  // set while the test deliberately signs in wrongly or uses a disabled account
const check = (label, ok) => { console.log((ok ? 'PASS ' : 'FAIL ') + label); ok ? passed++ : problems.push(label); };

const browser = await chromium.launch();
async function person(name, phone) {
  const ctx = await browser.newContext(phone ? { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2 } : { viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !(allow401 && m.text().includes('401'))) problems.push(`${name} console: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`${name} page error: ${e.message}`));
  if (process.env.DEBUG) page.on('response', async (r) => { if (/away|back/.test(r.url())) console.log('DEBUG', (Date.now() % 100000), name, r.request().method(), r.url().split('/api')[1], r.request().postData(), r.status(), await r.text().catch(() => '')); });
  if (process.env.DEBUG) page.on('requestfailed', (r) => console.log('DEBUG failed', name, r.url(), r.failure()?.errorText));
  return page;
}
const shot = async (page, name) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };
const PAD = '.play button.tile, .play .text-answer';  // an open question, not its answer key
const text = (page) => page.locator('#app').innerText();

const teacher = await person('teacher');
const admin = await person('admin');
const guruEmail = `guru${stamp}@example.org`;
const guruRow = () => admin.locator(`table.users tr:has-text("${guruEmail}")`);
const ani = await person('ani', true);
const budi = await person('budi', true);

// --- register
await teacher.goto(BASE + '/');
await shot(teacher, '01-home');
await teacher.goto(BASE + '/register');
await teacher.fill('input[autocomplete=name]', 'Bu Guru');
await teacher.fill('input[type=email]', guruEmail);
await teacher.fill('input[type=password]', 'rahasia-123');
await teacher.click('button:has-text("Daftar")');
await teacher.waitForURL('**/results');
await teacher.waitForSelector('text=Ini akun siswa');
check('a new account is a student: no dashboard, told how to become a teacher',
  (await text(teacher)).includes('Ini akun siswa') && await teacher.locator('#nav a:has-text("Dasbor")').count() === 0);
await teacher.goto(BASE + '/edit/new');
await teacher.waitForSelector('text=Khusus akun guru');
check('students cannot open the quiz editor', true);

// --- the admin promotes the new account to teacher
await admin.goto(BASE + '/login');
await admin.fill('input[type=email]', process.env.ADMIN_EMAIL);
await admin.fill('input[type=password]', process.env.ADMIN_PW);
await admin.click('button:has-text("Masuk")');
await admin.waitForURL('**/dashboard');
await admin.click('#nav a:has-text("Admin")');
await admin.waitForSelector('table.users');
check('admin sees the new account as a student', (await guruRow().locator('select').inputValue()) === 'student');
await admin.fill('input[aria-label="Nama situs"]', 'Kuis SMA Satu');
await admin.locator('input[aria-label="Warna utama"]').fill('#1e40af');
await admin.click('section:has-text("Identitas situs") button:has-text("Simpan")');
await admin.waitForFunction(() => document.getElementById('brand-name').textContent === 'Kuis SMA Satu');
check('admin renames and recolours the site; it applies at once',
  (await admin.title()) === 'Kuis SMA Satu' && (await admin.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--teal').trim())) === '#1e40af');
await guruRow().locator('select').selectOption('teacher');
await admin.waitForSelector('.toast:has-text("Bu Guru sekarang Guru")');
await shot(admin, '00-admin-users');
await teacher.goto(BASE + '/dashboard');
await teacher.waitForSelector('h1:has-text("Kuis saya")');
check('after promotion the same sign-in gets the teacher dashboard', (await text(teacher)).includes('Kuis saya'));
check('other users see the new name too', (await teacher.locator('#brand-name').innerText()) === 'Kuis SMA Satu');
check('menu has no stray text', !(await teacher.locator('#nav').innerText()).includes('null'));

// --- AI drafts a quiz from pasted material
await teacher.click('a:has-text("Buat dengan AI")');
await teacher.fill('.modal textarea[aria-label^="Rubrik"]', '1. Sistem zona UTM (40%)\n2. Jenis proyeksi (30%)\n3. Faktor skala (30%)');
await teacher.fill('.modal textarea[aria-label="Materi"]', 'Proyeksi UTM membagi bumi menjadi 60 zona selebar 6 derajat bujur. Setiap zona memakai proyeksi Transverse Mercator dengan faktor skala 0,9996 pada meridian tengah. '.repeat(2));
await shot(teacher, '01b-ai-dialog');
await teacher.click('.modal footer button:has-text("Buat soal")');
await teacher.waitForSelector('.q-card >> nth=2');
check('AI draft fills the editor with 3 questions and a title',
  await teacher.locator('.q-card').count() === 3 && await teacher.inputValue('input[placeholder^="Contoh: Kartografi"]') === 'Proyeksi UTM');
check('AI questions arrive with the correct answer marked', await teacher.locator('.q-card').first().locator('.opt-mark input:checked').count() === 1);
check('with a rubric, each AI question is labelled with its criterion',
  (await teacher.locator('.q-card input.criterion').evaluateAll((els) => els.map((e) => e.value))).join('|') === 'Sistem zona UTM|Jenis proyeksi|Faktor skala');
await shot(teacher, '01c-ai-result');
await teacher.click('button:has-text("Simpan & tutup")');
await teacher.waitForSelector('.q-preview');
check('AI quiz can be saved', (await text(teacher)).includes('Proyeksi UTM'));
await teacher.goto(BASE + '/dashboard');

// --- write a quiz
await teacher.click('a:has-text("Kuis baru")');
await teacher.fill('input[placeholder^="Contoh: Kartografi"]', 'Uji Coba Peta');
await teacher.fill('.q-card textarea', 'Satu zona UTM memiliki lebar…');
const opts = teacher.locator('.q-card .opt-row input:not([type=radio])');
for (const [i, v] of ['3 derajat', '6 derajat', '10 derajat', '12 derajat'].entries()) await opts.nth(i).fill(v);
await teacher.locator('.q-card .opt-mark input').nth(1).check();
await teacher.locator('.q-card input.criterion').first().fill('Sistem koordinat');
await teacher.click('.add-bar button:has-text("Benar / Salah")');
await teacher.locator('.q-card').nth(1).locator('textarea').fill('Kontur rapat berarti lereng curam.');
await teacher.click('.add-bar button:has-text("Tempel banyak soal")');
await teacher.fill('.modal textarea', 'Datum nasional Indonesia?\n= SRGI2013\n\nMana yang sistem proyeksi?\n*a. UTM\n*b. TM-3\nc. RGB');
await teacher.click('.modal footer button:has-text("Tambahkan")');
check('pasted questions are added (4 cards)', await teacher.locator('.q-card').count() === 4);
await shot(teacher, '02-editor');
await teacher.click('button:has-text("Simpan & tutup")');
await teacher.waitForURL('**/quiz/*');
await teacher.waitForSelector('.q-preview');
const quizId = teacher.url().split('/').pop();
check(`quiz saved with its own ID (${quizId})`, /^[a-z0-9]{8}$/.test(quizId) && (await text(teacher)).includes('6 derajat ✓'));

// --- copy the quiz for another class from its card
await teacher.goto(BASE + '/dashboard');
await teacher.locator('.quiz-card:has-text("Uji Coba Peta")').locator('button:has-text("Salin")').click();
check('the copy dialog suggests a name', (await teacher.inputValue('.modal input')) === 'Uji Coba Peta (Kelas B)');
await teacher.fill('.modal input', 'Uji Coba Peta (Kelas C)');
await teacher.click('.modal footer button:has-text("Salin")');
await teacher.waitForSelector('.quiz-card:has-text("Uji Coba Peta (Kelas C)")');
check('the copy appears on the dashboard next to the original', await teacher.locator('.quiz-card:has-text("Uji Coba Peta")').count() === 2);
await teacher.goto(`${BASE}/quiz/${quizId}`);
await teacher.waitForSelector('.q-preview');

// --- live game
await teacher.click('button:has-text("Mainkan")');
await teacher.click('.modal footer button:has-text("Mulai")');
await teacher.waitForURL('**/host/*');
const code = teacher.url().split('/').pop();
await teacher.waitForSelector('.lobby-code');
check(`live game gets a 6-digit code (${code})`, /^\d{6}$/.test(code));

for (const [page, name] of [[ani, 'Ani'], [budi, 'Budi']]) {
  await page.goto(BASE + '/');
  await page.fill('.code-input', code);
  await page.click('button:has-text("Gabung")');
  await page.fill('input[placeholder="Nama panggilan"]', name);
  await page.click('button:has-text("Gabung")');
  await page.waitForSelector('text=Anda sudah masuk!');
}
await teacher.waitForSelector('.chip >> nth=1');
await shot(teacher, '03-lobby');
await shot(ani, '04-student-lobby');
check('host lobby lists both students', (await teacher.locator('.chip').allInnerTexts()).sort().join() === 'Ani,Budi');

const answerRound = async (label) => {
  await teacher.click(`button:has-text("${label}")`);
  await ani.waitForSelector(PAD);
  await budi.waitForSelector(PAD);
};
await answerRound('Mulai');
const order = await ani.locator('.tile span').allInnerTexts();
await shot(ani, '05-student-question');
await shot(teacher, '06-host-question');
check('students see the question without the answer marked', order.length === 4 && await ani.locator('.tile.right').count() === 0);
await ani.click('.tile:has-text("6 derajat")');
await budi.click('.tile:has-text("3 derajat")');
await ani.waitForSelector('.verdict');
await budi.waitForSelector('.verdict');
check('right answer is marked correct with points', (await text(ani)).includes('Benar!') && /\+\d{3,4} poin/.test(await text(ani)));
check('wrong answer is marked and the right one shown', (await text(budi)).includes('Belum tepat') && await budi.locator('.tile.right:has-text("6 derajat")').count() === 1);
await teacher.waitForSelector('.tile .count');
await shot(teacher, '07-host-reveal');
await shot(budi, '08-student-wrong');
check('host sees the answer spread and leaderboard', (await text(teacher)).includes('1 dari 2 jawaban benar') && (await teacher.locator('.board li').first().innerText()).includes('Ani'));

await answerRound('Soal berikutnya');   // true/false: only Ani answers, teacher closes it
await ani.click('.tile:has-text("Benar")');
await ani.waitForSelector('text=Jawaban terkirim');
await teacher.click('button:has-text("Tutup soal")');
await budi.waitForSelector('.verdict');
check('unanswered question shows as missed', (await text(budi)).includes('Tidak sempat menjawab'));

await answerRound('Soal berikutnya');   // typed answer
await ani.fill('.text-answer', 'srgi2013');
await ani.click('button:has-text("Kirim")');
await budi.fill('.text-answer', 'WGS84');
await budi.click('button:has-text("Kirim")');
await ani.waitForSelector('.verdict.good');

await answerRound('Soal berikutnya');   // several answers
await ani.click('.tile:has-text("UTM")');
await ani.click('.tile:has-text("TM-3")');
await ani.click('button:has-text("Kirim")');
await budi.click('.tile:has-text("RGB")');
await budi.click('button:has-text("Kirim")');
await ani.waitForSelector('.verdict.good');
await teacher.click('button:has-text("Hasil akhir")');
await ani.waitForSelector('.huge');
await teacher.waitForSelector('.board');
await shot(teacher, '09-host-final');
await shot(ani, '10-student-final');
check('final ranking: Ani first, Budi second', (await ani.locator('.huge').innerText()) === '#1' && (await budi.locator('.huge').innerText()) === '#2');

await teacher.click('a:has-text("Dasbor hasil")');
await teacher.waitForSelector('table.marks');
if (SHOTS) await teacher.screenshot({ path: `${SHOTS}/11-results-dashboard.png`, fullPage: true });
const rowAni = await teacher.locator('table.marks tbody tr').first().innerText();
const rowBudi = await teacher.locator('table.marks tbody tr').nth(1).innerText();
check('dashboard names the winner', (await teacher.locator('.winner-band h2').innerText()) === 'Ani' && (await teacher.locator('.step.first .step-name').innerText()) === 'Ani');
check('student table: Ani 100%, Budi 0% with 3 wrong and 1 blank', rowAni.includes('Ani') && rowAni.includes('100%') && /Budi\s+0\s+0\s+3\s+1\s+0%/.test(rowBudi));
const qRow = await teacher.locator('table.qtable tbody tr').first().innerText();
check('question table: accuracy and the most common wrong answer', qRow.includes('50%') && qRow.includes('3 derajat (1×)'));
const cRow = await teacher.locator('table.ctable tbody tr').first().innerText();
check('dashboard reports performance per rubric criterion', cRow.includes('Sistem koordinat') && cRow.includes('50%'));
check('highlights list who may need support', (await teacher.locator('.insights').innerText()).includes('Budi (0%)'));

// --- review after the game: the teacher steps through questions; a student sees their own answers
await teacher.click('a:has-text("Bahas soal")');
await teacher.waitForSelector('.review .q-title');
check('review opens on question 1 with the answer hidden', (await teacher.locator('.q-title').innerText()).includes('UTM memiliki') && await teacher.locator('.tile.right').count() === 0);
await teacher.keyboard.press('Space');
await teacher.waitForSelector('.tile.right');
await shot(teacher, '11b-review-teacher');
check('showing the answer marks it and shows how the class answered',
  await teacher.locator('.tile.right:has-text("6 derajat")').count() === 1 && (await text(teacher)).includes('50% benar (1 dari 2 jawaban)'));
await teacher.keyboard.press('ArrowRight');
await teacher.waitForSelector('.q-title:has-text("Kontur")');
check('arrow keys move to the next question, answer hidden again', await teacher.locator('.tile.right').count() === 0 && (await teacher.locator('.dot.on').innerText()) === '2');
await budi.click('a:has-text("Lihat pembahasan")');
await budi.waitForSelector('.review .q-title');
await shot(budi, '11c-review-student');
check('a student reviews their own answers against the key',
  (await text(budi)).includes('Belum tepat') && await budi.locator('.tile.picked:has-text("3 derajat")').count() === 1 && await budi.locator('.tile.right:has-text("6 derajat")').count() === 1);
await budi.click('.dot >> nth=1');
await budi.waitForSelector('.q-title:has-text("Kontur")');
check('a question the student skipped shows as not answered', (await text(budi)).includes('Tidak dijawab'));
await teacher.goto(`${BASE}/report/${code}`);
await teacher.waitForSelector('table.marks');

// --- wheel filled from the game's players
await teacher.goto(`${BASE}/wheel?game=${code}`);
await teacher.waitForFunction(() => document.querySelector('.wheel-side textarea')?.value.includes('Budi'));
await teacher.click('.wheel-spin');
await teacher.waitForSelector('.winner', { timeout: 9000 });
const winner = await teacher.locator('.winner').innerText();
await shot(teacher, '12-wheel');
check(`wheel picks one of the players (${winner})`, ['Ani', 'Budi'].includes(winner));
await teacher.click('.modal footer button:has-text("Keluarkan dari roda")');
check('winner is removed from the wheel', !(await teacher.inputValue('.wheel-side textarea')).includes(winner));

// --- wheel from a class list file: numbers on the wheel, the name when it stops
await teacher.setInputFiles('.wheel-side input[type=file]', { name: 'kelas-a.csv', mimeType: 'text/csv', buffer: Buffer.from('No,Nama\n7,Dewi Lestari\n12,Eko Prasetyo\n25,Fajar Nugroho\n') });
await teacher.waitForFunction(() => document.querySelector('.wheel-side textarea')?.value === '7 | Dewi Lestari\n12 | Eko Prasetyo\n25 | Fajar Nugroho');
check('class list file fills the wheel as number | name', (await teacher.inputValue('.wheel-side input[aria-label="Judul"]')) === 'kelas-a');
await teacher.click('.wheel-spin');
await teacher.waitForSelector('.winner', { timeout: 9000 });
const pickedName = await teacher.locator('.winner').innerText(), pickedNo = await teacher.locator('.winner-no').innerText();
await shot(teacher, '12b-wheel-class-list');
check(`wheel result shows the student's name with their number (${pickedNo}: ${pickedName})`,
  ({ 'Nomor 7': 'Dewi Lestari', 'Nomor 12': 'Eko Prasetyo', 'Nomor 25': 'Fajar Nugroho' })[pickedNo] === pickedName);
await teacher.click('.modal footer button:has-text("Biarkan di roda")');

// --- assignment (self-paced)
await teacher.goto(`${BASE}/quiz/${quizId}`);
await teacher.click('button:has-text("Mainkan")');
await teacher.click('.mode:has-text("Tugas mandiri")');
await teacher.click('.modal footer button:has-text("Mulai")');
await teacher.waitForURL('**/report/*');
const code2 = teacher.url().split('/').pop();
await teacher.waitForSelector('.share-code');
await shot(teacher, '13-assignment-share');
check(`assignment gets a different code (${code2})`, /^\d{6}$/.test(code2) && code2 !== code);
await ani.goto(`${BASE}/join/${code2}`);
await ani.fill('input[placeholder="Nama panggilan"]', 'Ani');
await ani.click('button:has-text("Gabung")');
for (let i = 0; i < 4; i++) {
  await ani.waitForSelector(PAD);
  const q = await ani.locator('.q-title').innerText();
  if (q.includes('UTM memiliki')) await ani.click('.tile:has-text("6 derajat")');
  else if (q.includes('Kontur')) await ani.click('.tile:has-text("Salah")');
  else if (q.includes('Datum')) { await ani.fill('.text-answer', 'SRGI 2013'); await ani.click('button:has-text("Kirim")'); }
  else { await ani.click('.tile:has-text("UTM")'); await ani.click('.tile:has-text("TM-3")'); await ani.click('button:has-text("Kirim")'); }
  await ani.waitForSelector('.verdict');
  if (i === 0) await shot(ani, '14-assignment-feedback');
  await ani.click('.play .btn.big');
}
await ani.waitForSelector('.huge');
await shot(ani, '15-assignment-done');
check('assignment result: 2 of 4 correct, 2000 points', (await text(ani)).includes('2 dari 4 benar') && (await ani.locator('.huge').innerText()) === '2000');
await ani.reload();
await ani.waitForSelector('.huge');
check('reloading keeps the finished result', (await ani.locator('.huge').innerText()) === '2000');

// --- reading practice: AI turns a passage into questions; students read first, then answer beside it
await teacher.goto(BASE + '/edit/new?ai=1');
await teacher.check('.modal label:has-text("Latihan membaca") input');
const passageText = 'Johannes Gutenberg introduced movable type to Europe in the fifteenth century.\n\nWithin decades, books became cheaper and literacy spread through the towns of the continent, changing how knowledge travelled.'.repeat(2);
await teacher.fill('.modal textarea[aria-label="Materi"]', passageText);
check('reading mode hides the rubric and question-type choices', await teacher.locator('.modal textarea[aria-label^="Rubrik"]').isHidden());
await teacher.click('.modal footer button:has-text("Buat soal")');
await teacher.waitForSelector('.p-card');
check('the material becomes the quiz passage and every AI question points at it',
  (await teacher.inputValue('.p-card textarea')).includes('Gutenberg') && (await teacher.locator('.q-card .pick-passage').evaluateAll((els) => els.map((e) => e.value))).join('') === '00');
await shot(teacher, '17-editor-passage');
await teacher.click('button:has-text("Simpan & tutup")');
await teacher.waitForSelector('.passage.in-page');
await teacher.click('button:has-text("Mainkan")');
await teacher.click('.mode:has-text("Tugas mandiri")');
await teacher.click('.modal footer button:has-text("Mulai")');
await teacher.waitForURL('**/report/*');
const code3 = teacher.url().split('/').pop();
await budi.goto(`${BASE}/join/${code3}`);
await budi.fill('input[placeholder="Nama panggilan"]', 'Budi');
await budi.click('button:has-text("Gabung")');
await budi.waitForSelector('.reading .passage');
await shot(budi, '18-student-passage-first');
check('the student sees the passage first, with no question yet',
  (await text(budi)).toLowerCase().includes('bacaan untuk soal 1–2') && (await text(budi)).includes('Gutenberg') && await budi.locator('button.tile').count() === 0);
await budi.click('button:has-text("Mulai menjawab")');
await budi.waitForSelector(PAD);
await shot(budi, '19-student-passage-question');
check('then each question shows with the passage beside it', await budi.locator('.split .passage').count() === 1 && (await budi.locator('.split .passage').innerText()).includes('literacy spread'));
await budi.click('.tile:has-text("6 derajat")');
await budi.waitForSelector('.verdict');
await budi.click('.play .btn.big');
await budi.waitForSelector(PAD);
check('the next question on the same passage opens directly, passage still shown', await budi.locator('.split .passage').count() === 1 && await budi.locator('.reading').count() === 0);

// --- anti-cheat mode: leaving the page is noticed, recorded, and costs the open question
await teacher.goto(`${BASE}/quiz/${quizId}`);
await teacher.click('button:has-text("Mainkan")');
await teacher.click('.mode:has-text("Tugas mandiri")');
await teacher.check('.modal label:has-text("Mode anti-curang") input');
await teacher.selectOption('.modal select[aria-label="Sanksi"]', 'zero');
await shot(teacher, '20-start-anticheat');
await teacher.click('.modal footer button:has-text("Mulai")');
await teacher.waitForURL('**/report/*');
const code4 = teacher.url().split('/').pop();
const citra = await person('citra', true);
await citra.goto(`${BASE}/join/${code4}`);
await citra.fill('input[placeholder="Nama panggilan"]', 'Citra');
await citra.click('button:has-text("Gabung")');
await citra.waitForSelector('.guard-intro');
await shot(citra, '21-anticheat-rules');
check('student is told the rules before any question opens', (await text(citra)).includes('soal itu bernilai nol') && await citra.locator('button.tile').count() === 0);
await citra.click('button:has-text("Saya mengerti, mulai")');
await citra.waitForSelector(PAD);
const hide = (hidden) => citra.evaluate((h) => { Object.defineProperty(document, 'hidden', { value: h, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }, hidden);
await hide(true);                       // the student switches to another app...
await citra.waitForTimeout(2600);
await hide(false);                      // ...and comes back
await citra.waitForSelector('.modal:has-text("Anda meninggalkan halaman kuis")');
await shot(citra, '22-anticheat-warning');
check('coming back shows a warning with the count and the penalty', (await citra.locator('.modal').innerText()).includes('1 kali keluar') && (await citra.locator('.modal').innerText()).includes('bernilai nol'));
await citra.click('.modal button:has-text("Saya mengerti")');
await citra.click('.tile:has-text("6 derajat")');
await citra.waitForSelector('.verdict');
check('the right answer to that question scores zero', (await citra.locator('.verdict').innerText()).includes('+0 poin') && (await citra.locator('.verdict').innerText()).includes('nol karena keluar'));
await teacher.reload();
await teacher.waitForSelector('table.marks');
await shot(teacher, '23-report-anticheat');
check('the teacher sees who left the page, how often and for how long', /1× · [2-4] dtk/.test(await teacher.locator('table.marks tbody tr:has-text("Citra")').innerText()));

// --- language and sign-out
await teacher.goto(BASE + '/dashboard');
await teacher.click('.nav-btn.lang');
await teacher.waitForSelector('h1:has-text("My quizzes")');
await shot(teacher, '16-dashboard-en');
check('interface switches to English', (await text(teacher)).includes('My games'));
await teacher.click('button:has-text("Sign out")');
await teacher.goto(BASE + '/dashboard');
await teacher.waitForURL('**/login**');
check('signed-out visitors are sent to sign in', true);

// --- admin resets the teacher's password; the one-time password signs them in
allow401 = true;
await admin.goto(BASE + '/admin');
await guruRow().locator('button:has-text("Atur ulang sandi")').click();
await admin.click('.modal footer button:has-text("Atur ulang sandi")');
await admin.waitForSelector('.temp-pw');
const tempPw = await admin.locator('.temp-pw').innerText();
await admin.click('.modal footer button:has-text("Tutup")');
await teacher.goto(BASE + '/login');
if ((await teacher.locator('.nav-btn.lang').innerText()) === 'ID') await teacher.click('.nav-btn.lang');
await teacher.fill('input[type=email]', guruEmail);
await teacher.fill('input[type=password]', 'rahasia-123');
await teacher.click('main button:has-text("Masuk")');
await teacher.waitForSelector('.form-error:has-text("salah")');
await teacher.fill('input[type=password]', tempPw);
await teacher.click('main button:has-text("Masuk")');
await teacher.waitForURL('**/dashboard');
check('password reset: old password refused, one-time password works', tempPw.length >= 10);
await teacher.goto(BASE + '/account');
await teacher.fill('input[autocomplete=current-password]', tempPw);
await teacher.fill('input[autocomplete=new-password]', 'sandi-baru-456');
await teacher.click('button:has-text("Ganti kata sandi")');
await teacher.waitForSelector('.toast:has-text("Kata sandi diganti")');
check('the user then sets their own password on the account page', true);
// --- admin disables the account: it is signed out at once
await guruRow().locator('button:has-text("Nonaktifkan")').click();
await admin.waitForSelector(`table.users tr.off-row:has-text("${guruEmail}")`);
await teacher.goto(BASE + '/dashboard');
await teacher.waitForURL('**/login**');
check('a disabled account is signed out and sent to sign in', true);

await browser.close();
for (const p of problems) console.log('PROBLEM ' + p);
console.log(problems.length ? `${problems.length} PROBLEMS` : `ALL ${passed} PASS`);
process.exit(problems.length ? 1 : 0);
