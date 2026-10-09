# Sharing databases with the MoClo Library Tool

The Plasmid Editor and the [MoClo Library Tool](https://github.com/Gardiner-Lab/moclo-library-tool)
run as two containers on the same server and share the MoClo data volume. This document
describes exactly what is shared, who owns what, and how to keep the two tools working as
each is updated.

Nothing in the Plasmid Editor repository modifies the MoClo Library Tool. The integration
is entirely on the editor's side.

## What is shared

| Database | Path in the editor container | Editor access |
| --- | --- | --- |
| MoClo parts (`parts.db`) | `PARTS_DATABASE_PATH`, e.g. `/moclo/parts.db` | read + **insert new parts** |
| MoClo main (`moclo.db`) | `MOCLO_DATABASE_PATH`, e.g. `/moclo/moclo.db` | read only |
| Editor's own (`plasmid_editor.db`) | `EDITOR_DATABASE_PATH`, e.g. `/data/plasmid_editor.db` | full |

Both MoClo databases are opened **read-only** (SQLite URI `mode=ro`) for every operation
except contributing a part, which is the one write the editor performs.

If the paths do not exist, the shared features disappear from the interface and the rest of
the editor works normally. `GET /health` reports what the container can see:

```json
{"status": "healthy", "version": "0.1.0", "moclo": {"parts": true, "plasmids": false}}
```

## The contribution rule

A plasmid is offered to the MoClo parts library only when **all** of the following hold.
The check lives in `dnakit/goldengate.py` and runs on demand from the editor.

1. The user has ticked **Golden Gate ready** on the sequence. This is a deliberate human
   decision, never inferred — a plasmid can contain Type IIS sites for many reasons.
2. The sequence is **circular**. A MoClo part is a plasmid.
3. Exactly **two sites** for one Type IIS enzyme are present
   (BsaI, BsmBI/Esp3I, BbsI/BpiI, SapI/BspQI, PaqCI or AarI).
4. Those two sites release a fragment that **no longer contains a site** for that enzyme —
   the insert is cleanly excised rather than cut internally.
5. Both resulting overhangs are **4 bp**.

When several enzymes qualify, one with standard MoClo fusion sites
(Weber et al. 2011: `GGAG`, `AATG`, `GCTT`, …) is preferred.

If any condition fails, the interface reports which enzyme failed and why
("3 sites found; a part needs exactly 2"), rather than silently hiding the button.

## How a contributed part is stored

The MoClo Library Tool's `assemble_parts()` takes the first part in full and appends each
later part **minus its leading 4 bp**, so that the shared overhang scar appears exactly
once at each junction. For this to work, a stored part sequence must contain **both** of
its fusion sites: the 5′ overhang at the start and the 3′ overhang at the end.

The editor therefore writes:

```
sequence         = <5' overhang> + <insert body> + <3' overhang>
overhang_5prime  = the 4 bp fusion site at the start
overhang_3prime  = the 4 bp fusion site at the end
```

This matters because the digest routine in `dnakit/restriction.py` returns a fragment whose
**top strand carries only the left overhang** — the right one sits on the bottom strand of
that end. That representation is correct for chaining fragments during ligation, but it is
*not* what MoClo stores, so `goldengate.analyze()` exposes both forms:

- `insert.sequence` — the top strand, for ligation and assembly simulation
- `insert.part_sequence` — with both fusion sites, for the MoClo parts library

`tests/test_api.py::test_contributed_parts_reassemble_under_moclo_rules` pins this contract
by contributing two compatible parts and checking they rejoin into exactly the sequence
Golden Gate would produce.

### Columns written

| Column | Value |
| --- | --- |
| `id` | a fresh UUID |
| `name` | the part name given in the dialog (defaults to the sequence name) |
| `part_type` | one of MoClo's six types; suggested from the features inside the insert |
| `sequence` | insert including both fusion sites |
| `overhang_5prime`, `overhang_3prime` | the two 4 bp fusion sites |
| `lab_source` | from the dialog, or the user's profile |
| `contributor` | the editor username |
| `size` | the length of the **whole source plasmid**, matching MoClo's meaning |
| `features` | features inside the insert, as MoClo's JSON shape `{type, label, start, end, strand}`, re-based to the part |
| `comments` | a note recording that the editor contributed it and which enzyme released it |
| `plasmid_id`, `antibiotic`, `level`, `location_80`, `location_96_plate` | optional, from the dialog |

A part with the same `name` and the same pair of overhangs is refused, so pressing the
button twice cannot create duplicates.

## Why direct SQLite rather than MoClo's REST API

The MoClo tool's `POST /api/parts` would require the editor to hold a second set of
credentials for every user and keep a session against another service. Because both
containers already share a filesystem volume, writing the row directly is simpler and has
no credential-handling consequences. The cost is a dependency on MoClo's table shape, which
is contained as follows:

- Columns are discovered at runtime (`PRAGMA table_info`), and only columns that exist are
  written, so a MoClo release that **adds** columns keeps working untouched.
- The editor never runs DDL. If the `parts` table does not exist yet, it tells the user to
  start the MoClo tool once rather than creating it.
- All writes go through a single function, `app/services/moclo_bridge.contribute_part`.

### What would break this

A MoClo release that **renames or removes** one of the columns the editor writes, or that
changes the meaning of `sequence` (for example, to exclude the fusion sites), requires a
matching change in `moclo_bridge.py`. The test named above fails loudly in that case, so run
the editor's test suite against the new schema after a MoClo upgrade:

```bash
pytest tests/test_api.py -k "moclo or contribute or reassemble"
```

## Operational notes

- **Locking.** SQLite allows one writer at a time. Both tools use a busy timeout (10 s
  here), and the editor's single write is a short insert, so contention is not expected at
  lab scale. Reads are unaffected by a concurrent writer.
- **Backups.** `scripts/backup.sh` backs up the editor's own database only. The MoClo
  databases stay the responsibility of the MoClo tool's `backup-prod.sh`, so neither tool
  restores over the other's data.
- **Updating.** Either container can be rebuilt and restarted independently; there is no
  shared process state, only the files.
- **Running without MoClo.** Use `docker-compose.standalone.yml`. The editor hides the MoClo
  browsing panel and the contribute button, and explains why rather than failing.

## Future direction

`dnakit/` is a framework-free package with no Flask dependency. The MoClo Library Tool keeps
its own implementations of restriction-site finding, translation and GenBank export; those
could be replaced by `dnakit` so both tools share one tested implementation. That change
belongs in the MoClo repository and is deliberately not made here.
