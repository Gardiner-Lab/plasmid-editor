"""
Translation, ORF finding and reverse translation (standard genetic code).
"""

from typing import Any, Dict, List

from Bio.Data import CodonTable

from .model import reverse_complement

_TABLE = CodonTable.unambiguous_dna_by_id[1]
CODON_TABLE: Dict[str, str] = dict(_TABLE.forward_table)
for _stop in _TABLE.stop_codons:
    CODON_TABLE[_stop] = '*'

SYNONYMOUS: Dict[str, List[str]] = {}
for _codon, _aa in CODON_TABLE.items():
    SYNONYMOUS.setdefault(_aa, []).append(_codon)

THREE_LETTER = {
    'A': 'Ala', 'R': 'Arg', 'N': 'Asn', 'D': 'Asp', 'C': 'Cys', 'Q': 'Gln', 'E': 'Glu', 'G': 'Gly',
    'H': 'His', 'I': 'Ile', 'L': 'Leu', 'K': 'Lys', 'M': 'Met', 'F': 'Phe', 'P': 'Pro', 'S': 'Ser',
    'T': 'Thr', 'W': 'Trp', 'Y': 'Tyr', 'V': 'Val', '*': 'Stop', 'X': 'Xaa',
}

AA_MASS = {  # average residue masses (Da)
    'A': 71.0788, 'R': 156.1875, 'N': 114.1038, 'D': 115.0886, 'C': 103.1388, 'E': 129.1155,
    'Q': 128.1307, 'G': 57.0519, 'H': 137.1411, 'I': 113.1594, 'L': 113.1594, 'K': 128.1741,
    'M': 131.1926, 'F': 147.1766, 'P': 97.1167, 'S': 87.0782, 'T': 101.1051, 'W': 186.2132,
    'Y': 163.1760, 'V': 99.1326,
}

# One E. coli / plant-neutral codon per amino acid for quick back-translation.
PREFERRED_CODON = {
    'A': 'GCC', 'R': 'CGC', 'N': 'AAC', 'D': 'GAC', 'C': 'TGC', 'Q': 'CAG', 'E': 'GAG', 'G': 'GGC',
    'H': 'CAC', 'I': 'ATC', 'L': 'CTG', 'K': 'AAG', 'M': 'ATG', 'F': 'TTC', 'P': 'CCC', 'S': 'AGC',
    'T': 'ACC', 'W': 'TGG', 'Y': 'TAC', 'V': 'GTG', '*': 'TAA',
}


def translate(seq: str, to_stop: bool = False) -> str:
    seq = seq.upper().replace('U', 'T')
    protein = []
    for i in range(0, len(seq) - 2, 3):
        aa = CODON_TABLE.get(seq[i:i + 3], 'X')
        if aa == '*' and to_stop:
            break
        protein.append(aa)
    return ''.join(protein)


def protein_stats(protein: str) -> Dict[str, Any]:
    core = protein.rstrip('*')
    mass = sum(AA_MASS.get(a, 110.0) for a in core) + 18.015 if core else 0.0
    return {'length': len(core), 'mass_da': round(mass, 1)}


def reverse_translate(protein: str) -> str:
    return ''.join(PREFERRED_CODON.get(a.upper(), 'NNN') for a in protein if not a.isspace())


def find_orfs(seq: str, circular: bool = False, min_aa: int = 75,
              start_codons=('ATG',), require_start: bool = True) -> List[Dict[str, Any]]:
    """
    Open reading frames on both strands, longest first.

    Coordinates are on the forward strand (0-based, end-exclusive, end includes
    the stop codon). On circular sequences ORFs may run through the origin.
    """
    seq = seq.upper()
    n = len(seq)
    orfs = []
    for strand in (1, -1):
        s = seq if strand == 1 else reverse_complement(seq)
        search = s + s[:-1] if circular else s  # allow ORFs that wrap once
        limit = len(search)
        for frame in range(3):
            i = frame
            while i + 3 <= limit:
                codon = search[i:i + 3]
                is_start = codon in start_codons if require_start else True
                if is_start and i < n:
                    j = i
                    while j + 3 <= limit and j - i < n:
                        if CODON_TABLE.get(search[j:j + 3]) == '*':
                            break
                        j += 3
                    stop_found = j + 3 <= limit and CODON_TABLE.get(search[j:j + 3]) == '*'
                    end = j + 3 if stop_found else j
                    aa_len = (j - i) // 3
                    if stop_found and aa_len >= min_aa:
                        if strand == 1:
                            fstart, fend = i % n, end % n or n
                        else:
                            fstart, fend = (n - end) % n, (n - i) % n or n
                        orfs.append({'start': fstart, 'end': fend, 'strand': strand, 'frame': frame + 1,
                                     'length_aa': aa_len, 'length_bp': end - i,
                                     'protein': translate(search[i:end])})
                    i = end if stop_found else limit
                    continue
                i += 3
    # A wrapped ORF can be found twice (once from each copy); keep one.
    seen, unique = set(), []
    for o in sorted(orfs, key=lambda o: -o['length_aa']):
        key = (o['start'], o['end'], o['strand'])
        if key not in seen:
            seen.add(key)
            unique.append(o)
    return unique
