# Changelog

All notable changes to the Plasmid Editor are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/).

## [Unreleased]

## [0.5.2] - 2026-10-19

### Fixed
- A circular map with many stacked features or long labels grows to take them in, rather than
  cutting them off at the edge (the MoClo Library Tool draws its maps the same way).
- The v0.5.1 tag was made by mistake before the version number was raised; 0.5.2 is the same code
  with the right number.

## [0.5.0] - 2026-10-19

### Added
- **Enzymes cutting at most N times**: in the Enzymes panel, "Cutting at most [1] time(s)" (formerly
  "Unique cutters only") shows only the enzymes that cut the sequence that many times or fewer, in the
  list, the sequence view and the map. Typing a number turns it on. The sites API takes `max_cuts`.

### Changed
- **A plasmid is always seen by its owner's labs** (everyone in them), and by nobody else, until its
  owner ticks **Public**, in the editor under Golden Gate ready, which lets every lab see it. Public is
  off for new plasmids and for every plasmid made before (the older "shared" setting is no longer
  read). Its sequencing is seen by whoever sees it; the library marks public plasmids.
- Inside the suite, someone can be in several labs: they see all of them, and a lab lead oversees
  the members of the labs they lead. Changing a plasmid stays with its owner, their lab leads and
  administrators.

## [0.4.3] - 2026-10-16

### Changed
- **The plasmids open in the editor come first** in the Sequencing page's reference list, the active
  one at the top, marked "open in the editor"; the rest follow as before.

## [0.4.2] - 2026-10-16

### Fixed
- **Copy buttons work over plain http.** Browsers allow the clipboard API only on secure pages
  (https, or localhost); elsewhere Copy (sequences, selections, cloning products, lab codes) now copies with the copy command instead, and says so
  when even that is blocked.

## [0.4.1] - 2026-10-16

### Fixed
- **Save to primer stock** failed with "Failed to execute 'appendChild' on 'Node'" after the primers
  were saved, so the button came back and a second click saved them again. The message naming the
  new primers now shows.

## [0.4.0] - 2026-10-16

### Added
- **Lab Stocks**, the suite's glycerol stocks and primers, when the editor runs in the suite
  (`STOCKS_URL`, `/stocks` there; unset, all of this is hidden).
  - Confirming a plasmid by sequencing can make its glycerol stock in Lab Stocks, with the lab's
    next number (GL-G-0042), the clone, the strain and where it is kept. A number from before can
    still be typed.
  - A plasmid's glycerol stocks show beside its tags, each a link to it in Lab Stocks.
  - **Save to primer stock** in Design primers adds the pair to the lab's primers, numbered there.
  - **Lab primers** lists the lab's primers that bind the sequence (the last 15 nt matching exactly,
    on either strand), selects where each binds, and adds it as a primer_bind feature.

## [0.3.5] - 2026-10-15

### Added
- **The sequenced tag opens the plasmid's sequencing.** In the editor's header,
  "✓ Sequenced", and a new "Not sequenced" tag for plasmids not confirmed yet,
  open the plasmid on the Sequencing page, ready to add or judge reads.
  - A plasmid never saved has to be saved first.
  - With unsaved changes, you choose to save them first or open the saved version.
  - The same tags in My sequences open the same page.

## [0.3.4] - 2026-10-15

### Added
- **Correct a plasmid to its sequencing read.** Beside an alignment's
  differences, "Correct this one" changes the plasmid at the difference shown
  to what the read has, and "Correct all to this read" does so at every
  difference. Both list the changes and ask first. Bases change as they would
  typed in the editor, so features and translations move, stretch or shrink
  with them and keep marking the same parts; the reads are then aligned again,
  keeping their verdicts, and a plasmid linked to MoClo is updated there too.
  Only those who may change the plasmid see the buttons. A correction is saved
  at once, and kept in the history as a correction to that read.
- **History and rollback.** Every change to a sequence's content (created,
  imported, saved, corrected to a read, pulled from MoClo, rolled back) is kept
  as a version, with who made it, when and what changed. History, in the
  editor's toolbar and on the Sequencing page, lists them; whoever may change
  the sequence can roll back to any version, which is kept as a version too,
  so a rollback can be undone. Reads are aligned again after a rollback, and
  MoClo is updated. Sequences saved before this release keep their current
  content as their first version at their next change.

### Changed
- **A save over a newer version is held back.** The editor says which
  version it opened; if someone saved meanwhile (or corrected the plasmid to a
  read), Save asks whether to save over it or open the saved version, rather
  than overwriting it unseen. Ctrl+Z brings back your edits after opening the
  saved version.

## [0.3.3] - 2026-10-15

### Added
- **Go to the problems in a sequencing alignment.** Each difference listed
  above an alignment is a button that scrolls the alignment to it and outlines
  it; Previous and Next step through them ("Difference 3 of 12"); and every
  difference is coloured in the alignment (mismatch, insertion, deletion), where
  clicking one selects it.

### Changed
- **A sufficient alignment needs a glycerol stock.** Judging a sequencing read
  sufficient confirms the plasmid, so the verdict now asks for the glycerol
  stock the clone is kept as first, and records the verdict, the stock and the
  confirmation together. The API refuses a sufficient verdict without
  `glycerol_stock`, and nothing changes. Before, the verdict was saved first and
  the stock asked for afterwards, so cancelling left a sufficient read on an
  unconfirmed plasmid with no stock.

## [0.3.2] - 2026-10-14

### Added
- Select amino acids on a translation's row: click one, drag across several, or
  double-click (or click the translation in its panel) for all of it. Copy AA
  and Ctrl+C then copy exactly those amino acids, read on the translation's own
  strand; a plain selection of bases still copies bases.

### Fixed
- Find selected the match it moved to, but the selection was hidden under the
  match colour; the selected match now shows as selected, ready to copy, cut or
  annotate like a clicked feature.
- The Enzymes panel's Choose… button ran off the edge of the panel. The set or
  list picker and Choose… now share a row of their own under the panel's title,
  the picker taking whatever room the button leaves.

## [0.3.1] - 2026-10-14

### Added
- **Open sequences are kept until you sign out.** Every sequence open in the
  editor, unsaved edits included, and which one you were working on, come back
  after a reload, a visit to another tool or closing the browser tab. They are
  kept on the server for that sign-in (new `workspaces` table); signing out, or
  signing in again, starts with nothing open. Inside the suite they follow the
  suite's sign-in (`X-Suite-Session`).
- The Open panel works as tabs: click one to switch, × to close it (asking
  first if it has unsaved changes), and a dot marks unsaved changes per tab.

### Changed
- The side panels (Open, Find, Analysis, Features, Translations, Enzymes) stay
  in view under the toolbar while the sequence scrolls; a column taller than
  the window scrolls on its own.

## [0.3.0] - 2026-10-14

### Added
- `SUITE_AUTH=proxy`: inside the Gardiner Lab tool suite, signing in to the suite
  signs in here, and signing out of it signs out here. The suite's proxy names the
  signed-in user in an `X-Suite-User` header; the editor follows it on every
  request, and Log in and Log out go to the suite's pages (`SUITE_LOGIN_URL`,
  `SUITE_LOGOUT_URL`). `POST /api/auth/login` is closed in this mode. Off
  unless set.
  - Registration, labs, their codes and roles are the suite's too: the
    registration page and the Admin page send people to the suite's
    (`SUITE_REGISTER_URL`, and the Labs tab of `SUITE_DASHBOARD_URL`), and
    their APIs are closed. The navigation's Admin link becomes Dashboard, for
    everyone.
  - Each person's lab and lab-lead role are read from the suite's database
    (`SUITE_DATABASE_PATH`), so a change there shows here at once.
  - Administrator status given or taken away in the MoClo tool shows here at
    the next request, rather than at the next sign-in.
  - Being sent to sign in again comes back to the page you were on.

- **Translations.** Select bases and choose 🧬 Translate to add a translation of
  them, on either strand. Each amino acid appears under the codon that encodes
  it, on a band per codon (stop codons in red); click one to select its codon,
  double-click to select the whole translation. Translations are kept apart
  from features, in their own panel, where each can be renamed, its protein
  copied, or removed. They are saved with the plasmid (a new `translations`
  column) and follow edits, reverse complementing and a new origin. GenBank
  export writes each as a `CDS` feature with its protein in `/translation` and
  a `/note` saying it is a Plasmid Editor translation, so other programs show
  an ordinary CDS and importing the file here brings back the translation.
- The toolbar's whole-frame translation toggle is now called Reading frame, so
  it is not confused with the new Translate button.
- **SnapGene export.** Save as and the library can download a SnapGene `.dna`
  file, with the same features, colours and translations as the GenBank export;
  SnapGene shows a CDS's protein under it. Opening a `.dna` file now keeps its
  feature colours too (`dnakit/snapgene.py`).

- **Your own enzyme lists.** Choose… beside the Enzymes panel's list opens every
  REBASE enzyme, searchable by name or site and filterable to those sold
  commercially. Tick the ones to show and either show them at once or save them
  as a named list. Your lists are saved to your account, appear under "My lists"
  in the panel and in the silent-site tool, and can be changed, renamed or
  removed; the list you last showed is remembered on your account too.

### Fixed
- The Enzymes panel could show the sites of a previously chosen set when two
  searches overlapped (opening a sequence, then switching sets at once); only
  the latest search's answer is shown now.

### Changed
- The sequence view fills its pane: lines hold as many bases as fit, in tens
  (they were always 60), and re-flow when the window is resized, keeping the
  same part of the sequence at the top of the view.
- A read's alignment on the Sequencing page shows the reference's features
  above it, stacked where they overlap and with their strand, so you can see
  which features the read covers and where a difference falls. Line numbers on
  a read that runs through the origin of a circular plasmid start again at 1.
  Like the sequence view, the alignment fills its box and re-flows when it is
  resized.

## [0.2.1] - 2026-10-12

### Fixed
- Every download (from My sequences, and Save as) failed with "Cannot access 'url'
  before initialization": the download helper's own variable shadowed the URL
  helper it called. A frontend test now covers it.

## [0.2.0] - 2026-10-12

### Added
- **Labs, each with its own registration code.** Joining means choosing your lab and giving
  that lab's code; a lab without a code takes nobody new (the first account of an empty
  installation excepted). Codes are unique, so one only ever opens its own lab.
  `REGISTRATION_CODE` sets the first code, and `REQUIRE_REGISTRATION_CODE=false` turns codes off.
- **An Admin page and a lab lead role.** Administrators add, rename and remove labs, set and
  change each lab's code, and give people roles. A lab lead acts as an administrator for their
  own lab's members and plasmids and can see their lab's code, but cannot change codes, labs
  or roles.
- A **BLAST** button in the Analysis panel opens NCBI nucleotide BLAST in a new tab with
  the highlighted sequence as the query, or the whole sequence when nothing is highlighted.
- A "← Lab tools" link in the navigation bar back to the suite's launch page, shown
  when `SUITE_HOME_URL` is set (the suite sets it to `/`).
- **Sequencing alignments are open to everyone signed in**, private plasmids included,
  so anyone in the lab can check a construct's reads, alignments and traces on the
  Sequencing page. Uploading reads, judging alignments and confirming stay with the
  plasmid's owner (and admins), and their controls are hidden for viewers. The
  plasmid itself stays private everywhere else.
- **Shared accounts with the MoClo Library Tool.** When the MoClo database is mounted,
  every account lives in MoClo's user directory: an account registered in either tool
  works in both, and administrator status comes from MoClo. Accounts that existed only
  here are copied across on startup and keep everything they own, and accounts in an
  existing MoClo instance become editor users at the same time. Without MoClo, local
  accounts work as before.
- **Direct sequence typing.** The sequence view is a focusable text field: click
  to place a cursor, then type A/C/G/T (and other IUPAC codes) to insert, or use
  Backspace and Delete. Arrow keys, Home, End, Page Up/Down and shift-select
  navigate as in a text editor.
- **Undo and redo** (Ctrl+Z / Ctrl+Shift+Z, plus toolbar buttons) covering typing,
  deletion, paste, reverse complement, topology changes, origin moves, feature
  edits, auto-annotation and silent mutations.
- **Save as** (Ctrl+Shift+S): save a copy to the lab library under a new name, or
  download the open sequence as GenBank, FASTA or JSON. Downloads work for
  sequences that were never saved, via a new `POST /api/sequences/convert`.
- An "Unsaved changes" badge in the editor header.

### Security
- The MoClo tool creates an `admin` account with the published password `admin123`.
  With accounts shared, that would open every tool. At start-up the editor now
  replaces that password with `ADMIN_PASSWORD` when it is still the default, and
  logs a warning when there is no `ADMIN_PASSWORD` to replace it with.

### Fixed
- A plasmid could be marked "Sequenced" without any read judged sufficient. Confirming
  now requires a sufficient verdict, and the confirmation is withdrawn automatically
  when the last sufficient verdict is changed, cleared or its read deleted (the
  glycerol stock and clone are kept for re-confirming). Older confirmations with no
  sufficient read are cleared on start-up.
- Withdrawing a confirmation, by hand or automatically, left MoClo showing the plasmid as
  sequenced. The "Sequence confirmed" status the editor wrote is now cleared from the
  linked MoClo record as well; text entered in MoClo itself is left alone.
- A collapsed selection (a bare cursor) was measured as the whole sequence, so the
  statistics line read "Selection 18-17 (129 bp)" and Ctrl+C would have copied the
  entire sequence instead of nothing.
- Ctrl+A, Ctrl+C and Ctrl+V no longer hijack the browser's own editing shortcuts
  while the focus is in a text input.
- Restriction-site labels on the circular map no longer overlap: only unique
  cutters are labelled, crowded labels fan out across three rings, and a position
  tick is dropped where an enzyme label would sit on top of it.
- The MoClo library panel on the sequences page failed silently because of a
  mismatched element id, and its error handler could itself throw.
- `app/data/` was excluded by the `data/` ignore rule, so the built-in feature
  library was missing from the repository and the container image.

### Notes
- Typing at a feature's edge leaves the new base outside that feature; only text
  typed strictly inside a feature extends it. Overwriting a selection keeps the
  (resized) feature, while deleting it outright removes it.

## [0.1.0] - 2026-10-09

First release: a general-purpose plasmid editor to sit alongside the MoClo Library Tool.

### Added

**Sequence editing**
- Reading of GenBank, FASTA, EMBL, SnapGene (.dna), ApE (.ape), ABI (.ab1) and raw sequence
- Wrapped sequence view with complement strand, six reading frames, feature bars and cut marks
- Selection-based cut, copy (plain, reverse complement, translated), paste and delete
- Reverse complement, circular/linear switching, and moving the origin of a plasmid
- Feature editing with colours, strands and types, including features that cross the origin
- Circular and linear SVG maps; GenBank, FASTA, JSON and zip export

**Analysis**
- Restriction site finding over REBASE enzyme sets, including sites spanning the origin
- Digests with sticky-end tracking and a virtual gel against four standard ladders
- Diagnostic digest finder and silent restriction site finder
- ORF finding, translation, reverse translation, IUPAC and peptide search
- Auto-annotation from an ApE-compatible feature library
- Oligo properties, primer binding sites, PCR simulation and primer design

**Cloning simulation**
- Golden Gate assembly with a per-part diagnostic log
- Gibson/overlap assembly with automatic fragment flipping and junction Tm
- Restriction–ligation giving both insert orientations
- Site-specific recombination (Gateway BP/LR, Cre-lox, FLP-FRT)

**Sequencing**
- `.ab1` and FASTA read alignment on both strands, including across the origin
- Quality trimming, difference reporting, chromatogram viewer and coverage summary

**Integration with the MoClo Library Tool**
- Browsing MoClo parts, backbones and assembled plasmids from the shared databases
- A user-set "Golden Gate ready" flag, with an explained readiness check
- Contribution of a qualifying plasmid to the shared MoClo parts library, stored so that
  MoClo's own `assemble_parts()` rejoins it correctly
- Graceful standalone operation when the shared databases are not mounted

**Infrastructure**
- `dnakit`, a framework-free sequence toolkit reusable by the MoClo tool
- Docker image, production/standalone/development/Watchtower compose files
- Update script with health gate and automatic rollback, and a database backup script
- 48 backend tests and a frontend helper test suite, both run in CI
