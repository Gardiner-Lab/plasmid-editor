# Plasmid Editor

A Docker-containerised web application for editing, annotating and analysing plasmid
sequences, and for aligning sequencing reads against them. It is the general-purpose
companion to the [MoClo Library Tool](https://github.com/Gardiner-Lab/moclo-library-tool):
use the MoClo tool for a Golden Gate parts library and modular assembly planning, and this
editor for everything else — classical cloning, sequence manipulation by hand, Gibson
assembly, Gateway reactions, primer design and sequencing verification.

The feature set is modelled on **ApE (A Plasmid Editor)** by M. Wayne Davis and
re-implemented independently; see [Attribution](#attribution).

## Features

### Sequence editing
- Open **GenBank, FASTA, EMBL, SnapGene (.dna), ApE (.ape), ABI (.ab1)** and raw sequence files
- Wrapped sequence view with complement strand, any of the six reading frames, feature
  bars and restriction cut marks
- **Type directly into the sequence**: click to place a cursor and type A/C/G/T, or use
  Backspace and Delete; arrow keys, Home/End and shift-select behave as in a text editor
- Undo and redo (Ctrl+Z / Ctrl+Shift+Z) across every editing operation
- Click and drag selection; cut, copy (plain, reverse complement or translated), paste and delete
- Reverse complement, circular ⇄ linear, move the origin of a circular plasmid
- Circular and linear plasmid maps as SVG, with features and cut sites
- Feature editing with colours, strand and types; features that cross the origin are handled
  throughout, and move correctly when the sequence is edited
- Save as: a copy in the lab library under a new name, or a downloaded file
- Export GenBank, FASTA or JSON, singly or as a zip

### Analysis
- Restriction site finding over REBASE enzyme sets (default, Golden Gate Type IIS,
  commercially available, or all ~1000 enzymes), including sites that span the origin
- Digests with sticky-end tracking, and a **virtual gel** against standard ladders
- **Diagnostic digest finder**: enzyme combinations that give readable, distinguishable band patterns
- **Silent restriction sites**: introduce a site into a reading frame without changing the protein
- ORF finder on both strands, translation, reverse translation, protein mass
- Find DNA by IUPAC pattern on both strands, or a peptide in all six frames
- Auto-annotation from a feature library (ApE library files import and export unchanged)
- Oligo properties (nearest-neighbour Tm, GC), primer binding sites, **PCR simulation** with
  5′ tails, and primer design for a selected region

### Cloning simulation
- **Golden Gate** one-pot assembly with a per-part log explaining any part that is not used
- **Gibson / overlap assembly**, flipping fragments automatically and reporting junction Tm
- **Restriction + ligation** of a vector and insert, giving both insert orientations
- **Site-specific recombination**: Gateway BP/LR, Cre-lox and FLP-FRT style double crossovers
- Golden Gate assembly is planned in the MoClo Library Tool, which has the parts library and
  overhang compatibility checking; the Cloning page links straight there

### Sequencing
- Attach `.ab1` chromatograms or FASTA reads to a saved sequence
- Alignment to both strands, including reads that cross the origin, with quality trimming
- Mismatches, insertions and deletions listed in reference coordinates
- Chromatogram viewer with base calls and Phred quality
- Coverage of the selected read, shown one read at a time rather than merged, so you can
  see how far each read actually reached; a read crossing the origin is drawn as two pieces
- Re-alignment of every read after the reference is edited

### Sequencing verification
- The reference plasmid is **searched, not scrolled**: results rank by relevance to what you
  type and then by date added, newest first, which stays usable at hundreds of plasmids
- Every read stays attached to the plasmid it was aligned to, with its **clone number**,
  so you can see whether a plasmid was sequenced before and what was found
- Judge each alignment **sufficient** or **not sufficient**; the judgement, who made it and
  any note are kept with the read and survive re-alignment
- A sufficient alignment marks the plasmid **✓ confirmed and sequenced**, prompting for the
  **glycerol stock number** it will be kept as
- The sequence library shows the green check, the read count and how many alignments passed,
  linking straight to the alignments for that plasmid
- For a plasmid linked to MoClo, confirmation is written into the MoClo record's own
  `sequenced` field

### Shared with the MoClo Library Tool
- Browse the MoClo tool's **parts, backbones and assembled plasmids** and open them here
- Tick **“Golden Gate ready”** on a plasmid to check whether a single Type IIS enzyme
  releases one clean insert with two 4 bp fusion sites
- If it does, add it straight to the **shared MoClo parts library**, stored the way the MoClo
  tool expects (both fusion sites included), so it is usable in assemblies there immediately
- If it does not, the reason is reported per enzyme

## Technology

- **Backend**: Python 3.12, Flask, SQLite, bcrypt
- **Sequence analysis**: Biopython (REBASE enzymes, file parsing, alignment, Tm)
- **Frontend**: vanilla JavaScript and inline SVG, no build step
- **Containerisation**: Docker, Docker Compose

## Getting started

### Production, alongside the MoClo tool

The editor shares the MoClo tool's data volume so both see the same parts database.

```bash
SECRET_KEY=$(openssl rand -hex 32) \
  MOCLO_BASE_URL=https://moclo.example.org \
  docker compose -f docker-compose.prod.yml up -d
```

The editor is then on port **5001** (the MoClo tool stays on 5000).

`docker-compose.prod.yml` expects the MoClo volume to be named `moclo-data`. Check with
`docker volume ls`; if it differs, pass the real name:

```bash
MOCLO_VOLUME=moclolibrarytool_moclo-data SECRET_KEY=... docker compose -f docker-compose.prod.yml up -d
```

### Production, standalone

Without the shared library — the MoClo browsing and contribution features hide themselves:

```bash
SECRET_KEY=$(openssl rand -hex 32) docker compose -f docker-compose.standalone.yml up -d
```

### First account

Self-registration is open by default, and the **first account created becomes the admin**.
Alternatively set `ADMIN_USERNAME` and `ADMIN_PASSWORD` to create it automatically on an
empty database, then set `ALLOW_REGISTRATION=false` to close registration.

### Automatic updates

```bash
SECRET_KEY=$(openssl rand -hex 32) \
  docker compose -f docker-compose.prod.yml -f docker-compose.watchtower.yml up -d
```

To stop them: `docker rm -f plasmid-editor-watchtower`.

### Development

```bash
docker compose up --build          # http://localhost:5001, admin / devpassword
```

Or without Docker:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
EDITOR_DATABASE_PATH=./data/editor.db \
  ADMIN_USERNAME=admin ADMIN_PASSWORD=devpassword \
  .venv/bin/python -m flask --app app.main run --port 5001 --debug
```

### Tests

```bash
pytest -q                       # 51 backend tests
node tests/js/helpers.test.js   # frontend sequence helpers
```

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `SECRET_KEY` | — | **Required in production.** Signs session cookies. |
| `EDITOR_DATABASE_PATH` | `/data/plasmid_editor.db` | The editor's own database. |
| `PARTS_DATABASE_PATH` | `/data/parts.db` | MoClo parts database (shared). Absent ⇒ contribution disabled. |
| `MOCLO_DATABASE_PATH` | `/data/moclo.db` | MoClo main database (shared, read only here). |
| `MOCLO_BASE_URL` | — | Where the MoClo tool is, for links out to it (`/` when it is at the root of the same host). Unset hides those links. |
| `ALLOW_REGISTRATION` | `true` | Set `false` to close self-registration. |
| `DEFAULT_LAB_SOURCE` | — | Pre-filled lab name for new accounts. |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `admin` / — | Creates the first admin on an empty database. |
| `PORT` | `5001` | Port inside the container. |

## Architecture

```
dnakit/            Framework-free sequence toolkit (no Flask imports)
  model.py         Sequence documents, features, coordinates
  seqio.py         GenBank / FASTA / EMBL / SnapGene / ABI reading and writing
  restriction.py   REBASE enzymes, site finding, digests, gels, silent sites
  translate.py     Genetic code, translation, ORFs
  primers.py       Tm, binding sites, PCR, primer design
  assembly.py      Ligation, Golden Gate, Gibson, recombination
  align.py         Pairwise alignment and sequencing-read mapping
  features.py      Feature libraries (ApE format) and auto-annotation
  goldengate.py    Golden Gate readiness analysis for MoClo contribution

app/               Flask application
  models/          Users, stored sequences, reads, feature library
  services/        Auth, feature library, MoClo shared-database bridge
  api/             REST endpoints
  templates/       Pages
  static/          CSS and JavaScript
```

`dnakit` deliberately has no web-framework dependency, so the MoClo Library Tool can
depend on the same package later rather than keeping its own copies of the restriction,
translation and export routines. Nothing in this repository modifies the MoClo tool.

### The shared database boundary

The MoClo Library Tool owns its schemas. This application only ever:

1. **reads** `parts`, `backbones` and `final_plasmids` so they can be opened here, and
2. **inserts** one row into `parts` when a user contributes a Golden Gate ready plasmid.

It never alters the MoClo schema or updates existing MoClo rows, so either tool can be
updated independently. Columns are discovered at runtime, so a MoClo schema that gains
columns keeps working.

## Attribution

The functionality is modelled on **ApE (A Plasmid Editor)**, the desktop program by
M. Wayne Davis. ApE is closed-source Tcl/Tk, so **no ApE code is used or derived from
here** — the features were re-implemented independently. ApE's conventions are followed
where they aid interoperability: its tab-separated feature-library format is read and
written unchanged, and its `ApEinfo_fwdcolor` / `ApEinfo_revcolor` GenBank qualifiers are
honoured, so files move between the two programs without losing annotations or colours.

If you publish work that used this tool, please cite ApE as the origin of the feature set:

> Davis MW, Jorgensen EM (2022). ApE, A Plasmid Editor: A Freely Available DNA Manipulation
> and Visualization Program. *Frontiers in Bioinformatics* 2:818619.
> doi:[10.3389/fbinf.2022.818619](https://doi.org/10.3389/fbinf.2022.818619)

ApE is available from <https://jorgensen.biology.utah.edu/wayned/ape/>. This project is not
affiliated with or endorsed by its author.

Also used: **Biopython** (Cock PJA et al. 2009, *Bioinformatics* 25:1422–1423) and
**REBASE** (Roberts RJ et al. 2015, *Nucleic Acids Res* 43:D298–D299) for enzyme data.

## Licence

GNU General Public License v3.0, matching the MoClo Library Tool. See [LICENSE](LICENSE).
