"""
Reading and writing sequence files.

Reads GenBank / ApE (.ape is GenBank), EMBL, FASTA, SnapGene (.dna), ABI
chromatograms (.ab1) and raw sequence text. Writes GenBank and FASTA.
Parsing is delegated to BioPython.
"""

import io
import os
from typing import Any, Dict, List

from Bio import SeqIO
from Bio.Seq import Seq
from Bio.SeqFeature import CompoundLocation, FeatureLocation, SeqFeature
from Bio.SeqRecord import SeqRecord

from . import snapgene
from .model import clean_sequence, make_document, new_id
from .translate import translate_stretch

# ApE stores feature colours in these qualifiers; SnapGene and Benchling use the others.
_FWD_COLOR_KEYS = ('ApEinfo_fwdcolor', 'color', 'note_color')
_REV_COLOR_KEYS = ('ApEinfo_revcolor',)
_LABEL_KEYS = ('label', 'gene', 'product', 'note', 'locus_tag', 'name')
_DROP_QUALIFIERS = {'ApEinfo_fwdcolor', 'ApEinfo_revcolor', 'ApEinfo_graphicformat'}
# A translation the user made goes out as a CDS feature with this note, which
# other programs show as an ordinary CDS with its protein, and comes back in
# as a translation rather than a feature.
TRANSLATION_NOTE = 'Plasmid Editor translation'

_EXT_FORMAT = {
    '.gb': 'genbank', '.gbk': 'genbank', '.genbank': 'genbank', '.ape': 'genbank', '.gbff': 'genbank',
    '.embl': 'embl', '.fa': 'fasta', '.fasta': 'fasta', '.fna': 'fasta', '.fas': 'fasta', '.seq': 'fasta',
    '.dna': 'snapgene', '.ab1': 'abi', '.abi': 'abi',
}


class SequenceFileError(ValueError):
    pass


def _first(qualifiers: Dict[str, List[str]], keys) -> str:
    for k in keys:
        v = qualifiers.get(k)
        if v:
            return v[0] if isinstance(v, list) else str(v)
    return ''


def _feature_from_bio(feat: SeqFeature, seq_len: int, circular: bool) -> Dict[str, Any]:
    loc = feat.location
    strand = -1 if loc.strand == -1 else 1
    parts = [(int(p.start), int(p.end)) for p in loc.parts]
    start, end = int(loc.start), int(loc.end)
    segments = None
    if len(parts) > 1:
        # A two-part join through the origin is a single wrapped feature.
        ordered = parts if strand == 1 else list(reversed(parts))
        if circular and len(parts) == 2 and ordered[0][1] == seq_len and ordered[1][0] == 0:
            start, end = ordered[0][0], ordered[1][1]
        else:
            segments = [list(p) for p in parts]
    q = {k: list(v) for k, v in feat.qualifiers.items()}
    color = _first(q, _REV_COLOR_KEYS if strand == -1 else _FWD_COLOR_KEYS) or _first(q, _FWD_COLOR_KEYS)
    out = {
        'id': new_id(),
        'name': _first(q, _LABEL_KEYS) or feat.type,
        'type': feat.type,
        'start': start, 'end': end, 'strand': strand,
        'color': color or None,
        'qualifiers': {k: v for k, v in q.items() if k not in _DROP_QUALIFIERS},
    }
    if segments:
        out['segments'] = segments
    return out


def record_to_document(record: SeqRecord, fallback_name: str = 'Untitled') -> Dict[str, Any]:
    seq = str(record.seq)
    topology = record.annotations.get('topology', 'linear')
    circular = topology == 'circular'
    name = record.name if record.name and record.name not in ('<unknown name>', '.', 'Exported') else ''
    if not name and record.id and record.id not in ('<unknown id>', '.'):
        name = record.id
    doc = make_document(name or fallback_name, seq, circular,
                        description=record.description if record.description not in ('<unknown description>', '.') else '')
    doc['translations'] = []
    for feat in record.features:
        if feat.type == 'source':
            continue
        if feat.location is None:
            continue
        feature = _feature_from_bio(feat, len(seq), circular)
        if feat.type == 'CDS' and TRANSLATION_NOTE in (feat.qualifiers.get('note') or []):
            doc['translations'].append({'id': feature['id'], 'name': feature['name'],
                                        'start': feature['start'], 'end': feature['end'],
                                        'strand': feature['strand']})
        else:
            doc['features'].append(feature)
    return doc


def _sniff_format(text: str) -> str:
    head = text.lstrip()[:200]
    if head.startswith('LOCUS'):
        return 'genbank'
    if head.startswith('ID   '):
        return 'embl'
    if head.startswith('>'):
        return 'fasta'
    return 'raw'


def read_sequences(data: bytes, filename: str = '') -> List[Dict[str, Any]]:
    """Parse a file's bytes into a list of documents. Raises SequenceFileError."""
    base, ext = os.path.splitext(os.path.basename(filename or ''))
    fmt = _EXT_FORMAT.get(ext.lower())
    fallback = base or 'Untitled'

    if fmt in ('snapgene', 'abi'):
        try:
            # SnapGene through our reader, which keeps the feature colours.
            records = [snapgene.read(data)] if fmt == 'snapgene' else list(SeqIO.parse(io.BytesIO(data), fmt))
        except Exception as exc:
            raise SequenceFileError(f'could not read {fmt} file: {exc}') from exc
        docs = [record_to_document(r, fallback) for r in records]
        if fmt == 'snapgene':
            for d in docs:
                d['name'] = fallback if d['name'] in ('', 'Exported') else d['name']
        return docs

    try:
        text = data.decode('utf-8')
    except UnicodeDecodeError:
        text = data.decode('latin-1')
    sniffed = _sniff_format(text)
    if fmt is None or (fmt == 'fasta' and sniffed != 'fasta') or fmt != sniffed and sniffed != 'raw':
        fmt = sniffed

    if fmt == 'raw':
        seq = clean_sequence(text)
        if not seq:
            raise SequenceFileError('no sequence found in file')
        return [make_document(fallback, seq)]

    try:
        records = list(SeqIO.parse(io.StringIO(text), fmt))
    except Exception as exc:
        raise SequenceFileError(f'could not read {fmt} file: {exc}') from exc
    if not records:
        raise SequenceFileError('no sequence records found in file')
    return [record_to_document(r, fallback) for r in records]


def read_trace(data: bytes) -> Dict[str, Any]:
    """Read an ABI chromatogram: base calls, quality, peak positions and the four channels."""
    try:
        record = SeqIO.read(io.BytesIO(data), 'abi')
    except Exception as exc:
        raise SequenceFileError(f'could not read ABI file: {exc}') from exc
    raw = record.annotations.get('abif_raw', {})
    order = (raw.get('FWO_1') or b'GATC').decode() if isinstance(raw.get('FWO_1'), bytes) else (raw.get('FWO_1') or 'GATC')
    channels = {}
    for i, base in enumerate(order):
        trace = raw.get(f'DATA{9 + i}')
        if trace:
            channels[base] = list(trace)
    return {
        'name': record.name or record.id,
        'sequence': str(record.seq),
        'quality': list(record.letter_annotations.get('phred_quality', [])),
        'peaks': list(raw.get('PLOC2') or []),
        'channels': channels,
    }


def _to_record(doc: Dict[str, Any]) -> SeqRecord:
    name = ''.join(c if c.isalnum() or c in '-_.' else '_' for c in doc['name'])[:16] or 'Untitled'
    rec = SeqRecord(Seq(doc['sequence']), id=name, name=name,
                    description=doc.get('description') or doc['name'])
    rec.annotations['molecule_type'] = 'DNA'
    rec.annotations['topology'] = 'circular' if doc.get('circular') else 'linear'
    n = len(doc['sequence'])
    for f in doc.get('features', []):
        q = {k: (v if isinstance(v, list) else [v]) for k, v in (f.get('qualifiers') or {}).items()}
        q['label'] = [f['name']]
        if f.get('color'):
            q['ApEinfo_fwdcolor'] = [f['color']]
            q['ApEinfo_revcolor'] = [f['color']]
        rec.features.append(SeqFeature(_location(f, n), type=f.get('type') or 'misc_feature', qualifiers=q))
    for t in doc.get('translations') or []:
        protein = translate_stretch(doc['sequence'], t['start'], t['end'], t.get('strand', 1))
        rec.features.append(SeqFeature(_location(t, n), type='CDS', qualifiers={
            'label': [t['name']],
            'note': [TRANSLATION_NOTE],
            'codon_start': ['1'],
            # GenBank leaves the stop codon out of /translation.
            'translation': [protein.rstrip('*')],
        }))
    return rec


def _location(f: Dict[str, Any], n: int):
    """A feature's or translation's location, joined through the origin when it wraps."""
    strand = f.get('strand', 1)
    if f.get('segments'):
        parts = [FeatureLocation(s, e, strand=strand) for s, e in f['segments']]
        return CompoundLocation(parts) if len(parts) > 1 else parts[0]
    if f['end'] > f['start']:
        return FeatureLocation(f['start'], f['end'], strand=strand)
    a = FeatureLocation(f['start'], n, strand=strand)
    b = FeatureLocation(0, f['end'], strand=strand)
    return CompoundLocation([a, b] if strand == 1 else [b, a])


def write_genbank(doc: Dict[str, Any]) -> str:
    out = io.StringIO()
    SeqIO.write(_to_record(doc), out, 'genbank')
    return out.getvalue()


def write_snapgene(doc: Dict[str, Any]) -> bytes:
    """A SnapGene .dna file, with the same features (and translations) as the GenBank export."""
    return snapgene.write(_to_record(doc))


def write_fasta(doc: Dict[str, Any], line_width: int = 70) -> str:
    seq = doc['sequence']
    lines = [seq[i:i + line_width] for i in range(0, len(seq), line_width)]
    return f">{doc['name']}\n" + '\n'.join(lines) + '\n'
