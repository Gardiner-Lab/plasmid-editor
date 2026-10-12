"""
Who may create an account.

Every lab has its own registration code. Someone joining picks their lab and
gives that lab's code, which an administrator sets, changes or clears on the
Admin page and passes on (lab leads can see their own lab's code, to hand out,
but not change it). A lab without a code takes nobody new. The very first
account of an empty installation is the exception: there is no administrator
yet to set a code, so it needs none and becomes the administrator.

Codes are kept readable rather than hashed, because administrators need to see
them to hand them out. They are a gate against strangers, not passwords:
everyone who registers still chooses their own.
"""

import hmac
import os
import secrets
import time
from typing import Optional, Tuple

from app.models import settings
from app.models.lab import Lab
from app.models.user import User, _directory

MIN_CODE_LENGTH = 6
MAX_CODE_LENGTH = 64
MAX_LAB_LENGTH = 100
# Words that read well aloud, for a code that is easy to pass on.
_WORDS = ('amber', 'basil', 'cedar', 'delta', 'ember', 'fern', 'garnet', 'hazel', 'iris',
          'juniper', 'kelp', 'lotus', 'maple', 'nectar', 'olive', 'petal', 'quartz', 'reed',
          'sage', 'thyme', 'umber', 'violet', 'willow', 'yarrow', 'zinnia', 'clover',
          'birch', 'moss', 'poppy', 'tulip', 'orchid', 'lilac')
# Where the single, suite-wide code lived before codes were per lab.
_OLD_CODE_KEY = 'registration_code'


def code_required() -> bool:
    """REQUIRE_REGISTRATION_CODE=false turns codes off entirely."""
    return os.environ.get('REQUIRE_REGISTRATION_CODE', 'true').lower() not in ('0', 'false', 'no')


def normalise(code: str) -> str:
    """Codes are read out and typed by hand: case and surrounding space do not count."""
    return ' '.join((code or '').split()).lower()


def set_code(lab: Lab, code: Optional[str], updated_by: str) -> Optional[str]:
    """
    Set, change or clear (None or blank) a lab's code. Codes must be unique, so
    that a code only ever lets someone into the lab it was given out for.
    """
    if code is None or not code.strip():
        lab.set_code(None, updated_by)
        return None
    cleaned = ' '.join(code.split())
    if len(cleaned) < MIN_CODE_LENGTH:
        raise ValueError(f'A registration code must be at least {MIN_CODE_LENGTH} characters')
    if len(cleaned) > MAX_CODE_LENGTH:
        raise ValueError(f'A registration code must be at most {MAX_CODE_LENGTH} characters')
    for other in Lab.all():
        if other.id != lab.id and other.registration_code \
                and normalise(other.registration_code) == normalise(cleaned):
            raise ValueError('Another lab already uses that code; every lab needs its own')
    lab.set_code(cleaned, updated_by)
    return cleaned


def generate_code() -> str:
    """Three words and a number, e.g. "maple-orchid-reed-42"."""
    while True:
        code = '-'.join([secrets.choice(_WORDS) for _ in range(3)]
                        + [str(secrets.randbelow(90) + 10)])
        if not any(lab.registration_code and normalise(lab.registration_code) == code
                   for lab in Lab.all()):
            return code


def default_lab_name() -> str:
    return ' '.join(os.environ.get('DEFAULT_LAB_SOURCE', '').split())


def prepare_labs() -> None:
    """
    At start-up: every lab people already name becomes a lab here, and a code
    from the environment (the installer's) or from before codes were per lab
    goes to the default lab, unless an administrator has set one already.
    """
    with_names = {(u.lab_source or '').strip() for u in User.get_all()} | {default_lab_name()}
    for name in sorted(n for n in with_names if n):
        Lab.ensure(name)

    initial = os.environ.get('REGISTRATION_CODE', '').strip() or settings.value(_OLD_CODE_KEY)
    if initial:
        lab = Lab.ensure(default_lab_name() or 'Lab')
        if not lab.registration_code and not lab.code_updated_at:
            try:
                set_code(lab, initial, 'installer')
            except ValueError:
                pass
        if settings.value(_OLD_CODE_KEY):
            settings.put(_OLD_CODE_KEY, None, 'moved to labs')


def anyone_registered() -> bool:
    if User.count() > 0:
        return True
    conn = _directory()
    if conn is None:
        return False
    try:
        return conn.execute('SELECT COUNT(*) FROM users').fetchone()[0] > 0
    finally:
        conn.close()


def check(lab_name: str, code: str) -> Tuple[Optional[str], Optional[str], int]:
    """
    (lab name to record, None, 200) when this person may join, else
    (None, why not, HTTP status): 400 for a missing or unknown lab, 403 when
    the lab is closed or the code is wrong.
    """
    lab_name = ' '.join((lab_name or '').split())
    if not lab_name:
        return None, 'Choose the lab you work in', 400
    if len(lab_name) > MAX_LAB_LENGTH:
        return None, f'The lab name must be at most {MAX_LAB_LENGTH} characters', 400

    if not code_required() or not anyone_registered():
        # No codes in use, or the very first account: any lab name will do,
        # and it becomes a lab an administrator can then give a code to.
        lab = Lab.ensure(lab_name)
        return lab.name, None, 200

    lab = Lab.by_name(lab_name)
    if lab is None:
        return None, f'There is no lab called "{lab_name}" here. Choose your lab from the list.', 400
    if not lab.registration_code:
        return None, (f'{lab.name} is not taking new members: an administrator has not set its '
                      'registration code. Ask an administrator.'), 403
    if not hmac.compare_digest(normalise(code).encode(), normalise(lab.registration_code).encode()):
        time.sleep(1)       # blunt guessing
        return None, (f'That is not the registration code for {lab.name}. '
                      'Ask your lab lead or an administrator for it.'), 403
    return lab.name, None, 200
