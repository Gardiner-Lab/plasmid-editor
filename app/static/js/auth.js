/* Login and registration form. */

let mode = 'login';

function setMode(next) {
  mode = next;
  document.querySelectorAll('.auth-tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === next));
  document.getElementById('labField').hidden = next !== 'register';
  document.getElementById('submitBtn').textContent = next === 'register' ? 'Create account' : 'Log in';
  document.getElementById('password').setAttribute('autocomplete',
    next === 'register' ? 'new-password' : 'current-password');
  document.getElementById('alert').replaceChildren();
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
  if (mode === 'register') payload.lab_source = document.getElementById('lab_source').value;
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
