/*
 * Admin page.
 *
 * Administrators manage the labs, each lab's registration code, and everyone's
 * role and lab. Lab leads see their own lab, its members and its code (to hand
 * out), read only: only an administrator can change codes or roles.
 */

const ROLE_NAMES = { admin: 'Administrator', lab_lead: 'Lab lead', member: 'Member' };

const Admin = {
  data: null,

  async init() {
    document.getElementById('btnAddLab').addEventListener('click', () => this.addLab());
    document.getElementById('newLabName').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.addLab();
    });
    await this.load();
  },

  async load() {
    try {
      this.data = await API.get('/api/admin/overview');
      this.render();
    } catch (err) { toast(err.message, 'error'); }
  },

  get isAdmin() { return this.data && this.data.can_manage_labs; },

  render() {
    const d = this.data;
    document.getElementById('addLab').hidden = !this.isAdmin;
    document.getElementById('labsTitle').textContent =
      this.isAdmin ? 'Labs and registration codes' : 'Your lab';
    document.getElementById('labsHint').textContent = this.isAdmin
      ? 'Someone joining chooses their lab and gives that lab\'s code; every lab has its own. '
        + 'A lab without a code takes nobody new. Changing a code retires the old one at once; '
        + 'existing accounts are not affected.'
      : 'Give new members of your lab this code so they can register. Only an administrator can '
        + 'change it; ask one if it needs changing.';
    document.getElementById('usersTitle').textContent = this.isAdmin ? 'Accounts' : 'Your lab\'s members';
    document.getElementById('usersHint').textContent = this.isAdmin
      ? 'Lab leads can act as administrators for their own lab\'s members and plasmids, and see '
        + 'their lab\'s code, but cannot change codes or roles.'
      : 'As lab lead you can open and change your lab members\' plasmids, as an administrator can.';

    const notice = document.getElementById('adminNotice');
    notice.replaceChildren(d.codes_required ? '' : el('div', { class: 'alert alert-warning' },
      'This server lets anyone register without a code (REQUIRE_REGISTRATION_CODE=false).'));

    document.getElementById('labRows').replaceChildren(...(d.labs.length
      ? d.labs.map((lab) => this.labRow(lab))
      : [el('tr', {}, el('td', { colspan: 4, class: 'hint' },
          this.isAdmin ? 'No labs yet. Add one below.' : 'You are not in a lab yet.'))]));
    document.getElementById('userRows').replaceChildren(...d.users.map((u) => this.userRow(u)));
  },

  labRow(lab) {
    const status = lab.code
      ? el('span', { class: 'hint', style: 'display:block' },
          lab.code_updated_by ? `Set by ${lab.code_updated_by}, ${lab.code_updated_at || ''}` : '')
      : el('span', { class: 'hint', style: 'display:block' }, 'No code: closed to new members');

    if (!this.isAdmin) {
      return el('tr', {},
        el('td', {}, lab.name),
        el('td', { class: 'num' }, String(lab.members)),
        el('td', {}, lab.code ? el('code', { class: 'mono' }, lab.code) : '—', status),
        el('td', { style: 'text-align:right' }, lab.code
          ? el('button', { class: 'btn btn-sm btn-secondary', type: 'button',
                           onclick: () => this.copy(lab.code) }, 'Copy') : null));
    }

    const input = el('input', { type: 'text', class: 'mono', value: lab.code || '',
                                placeholder: 'No code', autocomplete: 'off', spellcheck: 'false',
                                style: 'min-width:12rem' });
    return el('tr', {},
      el('td', {}, el('div', { style: 'font-weight:600' }, lab.name),
        el('button', { class: 'btn btn-sm btn-secondary', type: 'button', style: 'margin-top:.25rem',
                       onclick: () => this.renameLab(lab) }, 'Rename')),
      el('td', { class: 'num' }, String(lab.members)),
      el('td', {}, input, status),
      el('td', { style: 'white-space:nowrap;text-align:right' },
        el('button', { class: 'btn btn-sm btn-secondary', type: 'button',
                       onclick: () => this.suggest(input) }, 'Suggest'),
        ' ',
        el('button', { class: 'btn btn-sm', type: 'button',
                       onclick: () => this.saveCode(lab, input.value) }, 'Save code'),
        ' ',
        el('button', { class: 'btn btn-sm btn-secondary', type: 'button', disabled: !lab.code,
                       title: 'Remove the code, so nobody new can join this lab',
                       onclick: () => this.saveCode(lab, null) }, 'Close'),
        ' ',
        el('button', { class: 'btn btn-sm btn-secondary', type: 'button', disabled: lab.members > 0,
                       title: lab.members ? 'Only a lab without members can be removed' : 'Remove this lab',
                       onclick: () => this.deleteLab(lab) }, '✕')));
  },

  userRow(u) {
    const joined = (u.created_at || '').slice(0, 10);
    if (!this.isAdmin) {
      return el('tr', {}, el('td', {}, u.username), el('td', {}, u.lab || '—'),
        el('td', {}, ROLE_NAMES[u.role] || u.role), el('td', {}, joined));
    }
    const labSelect = el('select', { onchange: (e) => this.setLab(u, e.target.value) },
      u.lab && !this.data.labs.some((l) => l.name.toLowerCase() === u.lab.toLowerCase())
        ? el('option', { value: '' }, `${u.lab} (not a lab here)`) : null,
      u.lab ? null : el('option', { value: '' }, 'No lab'),
      ...this.data.labs.map((l) => el('option', { value: l.id,
        selected: !!u.lab && l.name.toLowerCase() === u.lab.toLowerCase() }, l.name)));
    const roleSelect = el('select', { disabled: u.username === this.data.me.username,
                                      title: u.username === this.data.me.username
                                        ? 'You cannot change your own role' : '',
                                      onchange: (e) => this.setRole(u, e.target.value) },
      ...this.data.roles.map((r) => el('option', { value: r, selected: r === u.role }, ROLE_NAMES[r])));
    return el('tr', {}, el('td', {}, u.username), el('td', {}, labSelect),
      el('td', {}, roleSelect), el('td', {}, joined));
  },

  async suggest(input) {
    try {
      input.value = (await API.get('/api/admin/codes/suggest')).code;
      input.focus();
      toast('Suggested a new code. Press "Save code" to use it.', 'info', 3000);
    } catch (err) { toast(err.message, 'error'); }
  },

  async saveCode(lab, code) {
    if (code !== null && !String(code).trim()) {
      toast('Type a code, or use "Close"', 'error');
      return;
    }
    try {
      await API.put(`/api/admin/labs/${lab.id}/code`, { code });
      toast(code === null ? `${lab.name} is closed to new members.`
                          : `Code saved for ${lab.name}. The old one no longer works.`, 'success');
      await this.load();
    } catch (err) { toast(err.message, 'error'); }
  },

  async addLab() {
    const input = document.getElementById('newLabName');
    const name = input.value.trim();
    if (!name) { toast('Give the lab a name', 'error'); return; }
    try {
      await API.post('/api/admin/labs', { name });
      input.value = '';
      toast(`Added ${name}. Give it a registration code so people can join.`, 'success');
      await this.load();
    } catch (err) { toast(err.message, 'error'); }
  },

  renameLab(lab) {
    modal({
      title: `Rename ${lab.name}`,
      build: (body) => body.append(el('div', { class: 'field' },
        el('label', { for: 'renameLab' }, 'New name'),
        el('input', { type: 'text', id: 'renameLab', value: lab.name, maxlength: 100 }),
        el('span', { class: 'hint' }, 'Its members move with it.'))),
      buttons: [
        { label: 'Cancel', kind: 'secondary' },
        { label: 'Rename', onClick: async () => {
          await API.patch(`/api/admin/labs/${lab.id}`, { name: document.getElementById('renameLab').value });
          await this.load();
        } },
      ],
    });
  },

  async deleteLab(lab) {
    try {
      await API.del(`/api/admin/labs/${lab.id}`);
      toast(`Removed ${lab.name}`, 'success');
      await this.load();
    } catch (err) { toast(err.message, 'error'); }
  },

  async setRole(u, role) {
    try {
      await API.put(`/api/admin/users/${encodeURIComponent(u.username)}/role`, { role });
      toast(`${u.username} is now ${ROLE_NAMES[role].toLowerCase()}.`, 'success');
    } catch (err) { toast(err.message, 'error'); }
    await this.load();
  },

  async setLab(u, labId) {
    if (!labId) return;
    try {
      await API.put(`/api/admin/users/${encodeURIComponent(u.username)}/lab`, { lab_id: labId });
      toast(`Moved ${u.username}.`, 'success');
    } catch (err) { toast(err.message, 'error'); }
    await this.load();
  },

  async copy(code) {
    if (await copyText(code)) toast('Code copied', 'success', 2000);
    else toast(`Copying is blocked here: the code is ${code}`, 'info', 5000);
  },
};

Admin.init();
