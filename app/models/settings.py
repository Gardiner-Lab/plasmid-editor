"""Lab-wide settings, changed by an administrator."""

from typing import Optional

from app.models.database import get_connection


def get(key: str) -> Optional[dict]:
    with get_connection() as conn:
        row = conn.execute('SELECT value, updated_by, updated_at FROM settings WHERE key = ?',
                           (key,)).fetchone()
    return dict(row) if row else None


def value(key: str, default: Optional[str] = None) -> Optional[str]:
    row = get(key)
    return row['value'] if row and row['value'] is not None else default


def put(key: str, new_value: Optional[str], updated_by: str) -> None:
    with get_connection() as conn:
        conn.execute(
            'INSERT INTO settings (key, value, updated_by, updated_at) '
            'VALUES (?, ?, ?, CURRENT_TIMESTAMP) '
            'ON CONFLICT(key) DO UPDATE SET value = excluded.value, '
            'updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP',
            (key, new_value, updated_by))
