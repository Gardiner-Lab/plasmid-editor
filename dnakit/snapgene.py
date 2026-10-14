"""
SnapGene (.dna) files: written from, and read into, Biopython records.

Biopython reads SnapGene files but cannot write them, and drops feature
colours when it reads. This module adds both. It needs only Biopython, and the
same file serves both lab tools: the Plasmid Editor (dnakit/snapgene.py) and
the MoClo Library Tool (app/services/snapgene.py). Keep the two copies identical.

A SnapGene file is a series of packets: one byte giving the packet's type, a
big-endian four-byte length, then the data. Written here:

    0x09  cookie: "SnapGene", sequence type, export and import versions
    0x00  the DNA: one flags byte (circular, double-stranded), then the bases
    0x06  notes, as XML
    0x0A  the features, as XML: one <Feature> each, with its <Segment>s
          (1-based, inclusive ranges, which wrap through the origin as
          "start-end" with start > end) and its qualifiers as <Q><V/></Q>

That is the part of the format other readers (Biopython among them) rely on.
Primers, history and display settings are left out; SnapGene fills in its
defaults for them.
"""

import io
import struct
import xml.etree.ElementTree as ET
from datetime import date
from typing import Dict, List, Optional
from xml.dom.minidom import parseString

from Bio import SeqIO
from Bio.SeqFeature import CompoundLocation
from Bio.SeqRecord import SeqRecord

# DNA; then the export and import format versions, as SnapGene's own files carry them.
COOKIE = (b'SnapGene', 1, 14, 16)
CIRCULAR = 0x01
DOUBLE_STRANDED = 0x02

# Colours travel in ApE's qualifiers inside the tools, as in their GenBank files.
_COLOR_KEYS = ('ApEinfo_fwdcolor', 'ApEinfo_revcolor', 'color')
# Qualifiers SnapGene works out for itself, or that only describe display.
_SKIP_QUALIFIERS = set(_COLOR_KEYS) | {'ApEinfo_graphicformat', 'translation', 'codon_start'}
_LABEL_KEYS = ('label', 'gene', 'product', 'name', 'locus_tag', 'note')
_DEFAULT_COLORS = {
    'CDS': '#60a5fa', 'promoter': '#34d399', 'terminator': '#f87171', 'rep_origin': '#fbbf24',
    'primer_bind': '#a78bfa', 'RBS': '#2dd4bf', 'gene': '#93c5fd',
}


def _packet(kind: int, data: bytes) -> bytes:
    return struct.pack('>BI', kind, len(data)) + data


def _first(qualifiers: Dict[str, list], keys) -> str:
    for key in keys:
        values = qualifiers.get(key)
        if values:
            return str(values[0] if isinstance(values, list) else values)
    return ''


def _segments(location, n: int) -> List[str]:
    """1-based inclusive ranges; one wrapping range for a feature through the origin."""
    parts = sorted(((int(p.start), int(p.end)) for p in location.parts), key=lambda p: p[0])
    if isinstance(location, CompoundLocation) and len(parts) == 2 \
            and parts[0][0] == 0 and parts[1][1] == n:
        return [f'{parts[1][0] + 1}-{parts[0][1]}']
    return [f'{start + 1}-{end}' for start, end in parts]


def write(record: SeqRecord) -> bytes:
    """A SnapGene file holding this record's sequence and features."""
    sequence = str(record.seq)          # SnapGene keeps the case, as the tools do
    n = len(sequence)
    circular = record.annotations.get('topology') == 'circular'

    notes = ET.Element('Notes')
    ET.SubElement(notes, 'Type').text = 'Synthetic'
    ET.SubElement(notes, 'LastModified').text = date.today().strftime('%Y.%m.%d')
    if record.description and record.description not in ('.', '<unknown description>'):
        ET.SubElement(notes, 'Description').text = record.description

    features = [f for f in record.features if f.type != 'source' and f.location is not None]
    root = ET.Element('Features', nextValidID=str(len(features)))
    for i, feature in enumerate(features):
        q = {k: (v if isinstance(v, list) else [v]) for k, v in feature.qualifiers.items()}
        strand = feature.location.strand
        name = _first(q, _LABEL_KEYS) or feature.type
        color = _first(q, ('ApEinfo_revcolor',) if strand == -1 else ()) or _first(q, _COLOR_KEYS) \
            or _DEFAULT_COLORS.get(feature.type, '#94a3b8')
        node = ET.SubElement(root, 'Feature', recentID=str(i), name=name, type=feature.type,
                             allowSegmentOverlaps='0', consecutiveTranslationNumbering='1')
        # As SnapGene writes them: no directionality for a feature without a strand.
        if strand == 1:
            node.set('directionality', '1')
        elif strand == -1:
            node.set('directionality', '2')
            node.set('swappedSegmentNumbering', '1')
            node.set('readingFrame', '-1')
        for rng in _segments(feature.location, n):
            segment = ET.SubElement(node, 'Segment', range=rng, color=color, type='standard')
            if feature.type == 'CDS':
                segment.set('translated', '1')     # SnapGene shows the protein under it
        for key, values in q.items():
            if key in _SKIP_QUALIFIERS:
                continue
            qualifier = ET.SubElement(node, 'Q', name=key)
            for value in values:
                ET.SubElement(qualifier, 'V', text=str(value))

    xml = lambda e: b'<?xml version="1.0"?>' + ET.tostring(e, encoding='utf-8')  # noqa: E731
    flags = DOUBLE_STRANDED | (CIRCULAR if circular else 0)
    return b''.join([
        _packet(0x09, struct.pack('>8sHHH', *COOKIE)),
        _packet(0x00, bytes([flags]) + sequence.encode('ascii')),
        _packet(0x06, xml(notes)),
        _packet(0x0A, xml(root)),
    ])


def _feature_colors(data: bytes) -> List[tuple]:
    """(type, first range, colour) for each feature in a file's features packets, in order."""
    found, stream = [], io.BytesIO(data)
    while True:
        head = stream.read(5)
        if len(head) < 5:
            return found
        kind, length = struct.unpack('>BI', head)
        body = stream.read(length)
        if kind != 0x0A:
            continue
        try:
            dom = parseString(body.decode('utf-8'))
        except Exception:      # a malformed packet only costs the colours
            continue
        for feature in dom.getElementsByTagName('Feature'):
            segments = [s for s in feature.getElementsByTagName('Segment')
                        if s.getAttribute('type') != 'gap']
            first = segments[0] if segments else None
            found.append((feature.getAttribute('type') or 'misc_feature',
                          first.getAttribute('range') if first else '',
                          first.getAttribute('color') if first else ''))


def read(data: bytes) -> SeqRecord:
    """
    A SnapGene file as a record, as Biopython reads it, with each feature's
    colour added as ApE's colour qualifiers so the tools' GenBank handling
    keeps it.
    """
    record = SeqIO.read(io.BytesIO(data), 'snapgene')
    colors = _feature_colors(data)
    pending = 0
    for feature in record.features:
        if pending >= len(colors):
            break
        kind, rng, color = colors[pending]
        if feature.type != kind:
            continue           # a primer, from the separate primers packet
        pending += 1
        start = rng.split('-')[0] if rng else ''
        starts = {str(int(p.start) + 1) for p in feature.location.parts}
        if color and start in starts:
            feature.qualifiers.setdefault('ApEinfo_fwdcolor', [color])
            feature.qualifiers.setdefault('ApEinfo_revcolor', [color])
    return record


def to_genbank(data: bytes, name: str = 'Untitled') -> str:
    """
    A SnapGene file as GenBank text, for code that reads GenBank. The file
    seldom names its sequence, so `name` (the file's, say) is used instead.
    """
    record = read(data)
    record.annotations.setdefault('molecule_type', 'DNA')
    if not record.name or record.name.startswith('<'):
        safe = ''.join(c if c.isalnum() or c in '-_.' else '_' for c in name)[:16] or 'Untitled'
        record.name = record.id = safe
        record.description = record.description if record.description not in ('', '<unknown description>') else name
    out = io.StringIO()
    SeqIO.write(record, out, 'genbank')
    return out.getvalue()


def from_genbank(text: str) -> bytes:
    """GenBank text as a SnapGene file, for code that writes GenBank."""
    return write(SeqIO.read(io.StringIO(text), 'genbank'))


def is_snapgene(data: bytes, filename: Optional[str] = '') -> bool:
    return (filename or '').lower().endswith('.dna') or data[:1] == b'\x09' and data[5:13] == b'SnapGene'
