/* Login and registration form. */

let mode = 'login';
let codeRequired = true;

function setMode(next) {
  mode = next;
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === next));
  const registering = next === 'register';
  document.getElementById('registerFields').hidden = !registering;
  document.getElementById('codeField').hidden = !codeRequired;
  // With codes in use, the lab is chosen from the labs an administrator set up;
  // the first account of a new installation names its own.
  document.getElementById('lab_choice').hidden = !codeRequired;
  document.getElementById('lab_source').hidden = codeRequired;
  document.getElementById('labLabel').htmlFor = codeRequired ? 'lab_choice' : 'lab_source';
  document.getElementById('lab_choice').required = registering && codeRequired;
  document.getElementById('lab_source').required = registering && !codeRequired;
  document.getElementById('registration_code').required = registering && codeRequired;
  document.getElementById('submitBtn').textContent = next === 'register' ? 'Create account' : 'Log in';
  document.getElementById('password').setAttribute('autocomplete',
    next === 'register' ? 'new-password' : 'current-password');
  document.getElementById('alert').replaceChildren();
}

async function loadLabs(preferred) {
  const select = document.getElementById('lab_choice');
  try {
    const { labs } = await API.get('/api/auth/labs', { allowAnonymous: true });
    const open = labs.filter((l) => l.open);
    select.replaceChildren(
      el('option', { value: '' }, open.length ? 'Choose your lab…' : 'No lab is taking new members'),
      ...open.map((l) => el('option', { value: l.name }, l.name)));
    if (open.some((l) => l.name === preferred)) select.value = preferred;
  } catch {
    select.replaceChildren(el('option', { value: '' }, 'Could not load the labs'));
  }
}

document.querySelectorAll('.auth-tab').forEach((tab) => {
  tab.addEventListener('click', () => setMode(tab.dataset.tab));
});

document.getElementById('authForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = document.getElementById('submitBtn');
  const alertBox = document.getElementById('alert');
  const payload = {
    username: document.getElementById('username').value,
    password: document.getElementById('password').value,
  };
  if (mode === 'register') {
    payload.lab_source = codeRequired ? document.getElementById('lab_choice').value
                                      : document.getElementById('lab_source').value;
    payload.registration_code = document.getElementById('registration_code').value;
  }
  btn.disabled = true;
  alertBox.replaceChildren();
  try {
    await API.post(`/api/auth/${mode}`, payload, { allowAnonymous: true });
    window.location.href = url('/editor');
  } catch (err) {
    alertBox.replaceChildren(el('div', { class: 'alert alert-error', text: err.message }));
    btn.disabled = false;
  }
});

API.get('/api/auth/session', { allowAnonymous: true }).then((s) => {
  // The first account of an empty installation needs no code.
  codeRequired = s.registration_code_required !== false;
  if (s.default_lab && !document.getElementById('lab_source').value) {
    document.getElementById('lab_source').value = s.default_lab;
  }
  if (codeRequired) loadLabs(s.default_lab);
  if (s.registration_open && new URLSearchParams(window.location.search).has('register')) {
    setMode('register');
  } else {
    setMode(mode);
  }
  if (!s.registration_open) {
    const tab = document.getElementById('registerTab');
    tab.disabled = true;
    tab.title = 'Registration is closed on this server';
    tab.style.opacity = '.5';
  }
  if (s.shared_accounts) {
    // One account per person, across the suite.
    const note = el('p', { class: 'hint', style: 'margin-bottom:1rem' },
      'One lab account works in every tool: sign in with the same username and password as the ',
      el('a', { href: '/parts' }, 'MoClo Library Tool'), ', and an account created here works there too.');
    document.getElementById('alert').after(note);
  }
}).catch(() => {});
