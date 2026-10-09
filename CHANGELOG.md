# Changelog

All notable changes to the Plasmid Editor are recorded here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project uses [semantic versioning](https://semver.org/).

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
