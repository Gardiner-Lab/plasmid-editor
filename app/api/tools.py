"""Analysis endpoints: restriction, ORFs, translation, primers, assembly, alignment."""

from flask import Blueprint, jsonify, request

from app.services.auth import require_auth
from dnakit import align, assembly, features, model, primers, restriction, seqio, translate

tools_bp = Blueprint('tools', __name__)


def _document(data, key='document'):
    return model.normalize_document(data.get(key) or {})


def _json():
    return request.get_json(silent=True) or {}


def _bad(exc):
    return jsonify({'error': str(exc)}), 400


# ---------------------------------------------------------------------------
# Enzymes and restriction
# ---------------------------------------------------------------------------

@tools_bp.route('/enzymes', methods=['GET'])
@require_auth
def enzymes(user):
    """
    The built-in enzyme sets, this person's own lists and the one they last
    showed; with ?catalog=1, every enzyme too, for choosing a list from.
    """
    from app.models import enzyme_list
    body = {'sets': restriction.enzyme_sets(), 'ladders': sorted(restriction.LADDERS),
            'lists': enzyme_list.for_owner(user.id), 'choice': enzyme_list.choice(user.id)}
    if request.args.get('catalog'):
        body['catalog'] = restriction.enzyme_catalog()
    return jsonify(body), 200


# --- the person's own enzyme lists ------------------------------------------

@tools_bp.route('/enzyme-lists', methods=['POST'])
@require_auth
def create_enzyme_list(user):
    from app.models import enzyme_list
    data = _json()
    try:
        made = enzyme_list.create(user.id, data.get('name', ''), data.get('enzymes'))
    except ValueError as exc:
        return _bad(exc)
    return jsonify({'list': made}), 201


@tools_bp.route('/enzyme-lists/<list_id>', methods=['PUT', 'PATCH'])
@require_auth
def update_enzyme_list(user, list_id):
    from app.models import enzyme_list
    data = _json()
    try:
        changed = enzyme_list.update(list_id, user.id, data.get('name'), data.get('enzymes'))
    except ValueError as exc:
        return _bad(exc)
    if changed is None:
        return jsonify({'error': 'No such list'}), 404
    return jsonify({'list': changed}), 200


@tools_bp.route('/enzyme-lists/<list_id>', methods=['DELETE'])
@require_auth
def delete_enzyme_list(user, list_id):
    from app.models import enzyme_list
    if not enzyme_list.delete(list_id, user.id):
        return jsonify({'error': 'No such list'}), 404
    if enzyme_list.choice(user.id) == f'list:{list_id}':
        enzyme_list.set_choice(user.id, 'Default')
    return jsonify({'ok': True}), 200


@tools_bp.route('/enzyme-choice', methods=['PUT'])
@require_auth
def set_enzyme_choice(user):
    """Remember which list the person is showing, for their next visit, on any computer."""
    from app.models import enzyme_list
    enzyme_list.set_choice(user.id, _json().get('choice', ''))
    return jsonify({'ok': True}), 200


@tools_bp.route('/enzymes/<name>', methods=['GET'])
@require_auth
def enzyme_detail(user, name):
    try:
        return jsonify(restriction.enzyme_info(name)), 200
    except ValueError as exc:
        return _bad(exc)


@tools_bp.route('/sites', methods=['POST'])
@require_auth
def sites(user):
    data = _json()
    try:
        doc = _document(data)
        names = data.get('enzymes') or restriction.enzyme_sets()['Default']
        hits = restriction.find_sites(doc['sequence'], names, doc['circular'])
    except ValueError as exc:
        return _bad(exc)
    counts = {}
    for h in hits:
        counts[h['enzyme']] = counts.get(h['enzyme'], 0) + 1
    if data.get('unique_only'):
        hits = [h for h in hits if counts[h['enzyme']] == 1]
    return jsonify({'sites': hits, 'counts': counts,
                    'non_cutters': sorted(e for e in (data.get('enzymes') or []) if e not in counts)}), 200


@tools_bp.route('/digest', methods=['POST'])
@require_auth
def digest(user):
    data = _json()
    try:
        doc = _document(data)
        names = data.get('enzymes') or []
        if not names:
            return jsonify({'error': 'Select at least one enzyme'}), 400
        frags = restriction.digest(doc['sequence'], names, doc['circular'])
    except ValueError as exc:
        return _bad(exc)
    include_seq = bool(data.get('include_sequence'))
    out = []
    for f in frags:
        row = {k: v for k, v in f.items() if k not in ('top', 'bottom', 'features')}
        if include_seq:
            row['top'] = f['top']
            row['bottom'] = f['bottom']
        out.append(row)
    return jsonify({'fragments': out, 'count': len(out)}), 200


@tools_bp.route('/gel', methods=['POST'])
@require_auth
def gel(user):
    """Virtual gel for one or more digests of one or more sequences."""
    data = _json()
    ladder = data.get('ladder') or '1 kb ladder'
    if ladder not in restriction.LADDERS:
        return jsonify({'error': f'Unknown ladder: {ladder}'}), 400
    lanes = []
    try:
        for lane in data.get('lanes') or []:
            doc = model.normalize_document(lane.get('document') or {})
            names = lane.get('enzymes') or []
            frags = restriction.digest(doc['sequence'], names, doc['circular']) if names else \
                [{'length': len(doc['sequence'])}]
            label = lane.get('label') or f"{doc['name']} / {'+'.join(names) or 'uncut'}"
            lanes.append({'label': label, 'fragments': frags})
    except ValueError as exc:
        return _bad(exc)
    if not lanes:
        return jsonify({'error': 'No lanes given'}), 400
    return jsonify(restriction.gel_lanes(lanes, ladder)), 200


@tools_bp.route('/silent-sites', methods=['POST'])
@require_auth
def silent_sites(user):
    data = _json()
    try:
        doc = _document(data)
        start, end = int(data.get('cds_start', 0)), int(data.get('cds_end', len(doc['sequence'])))
        names = data.get('enzymes') or restriction.enzyme_sets()['Default']
        results = restriction.silent_sites(doc['sequence'], start, end, names,
                                           int(data.get('max_changes', 2)), doc['circular'])
    except (ValueError, TypeError) as exc:
        return _bad(exc)
    return jsonify({'sites': results[:500], 'count': len(results)}), 200


@tools_bp.route('/diagnostic-digest', methods=['POST'])
@require_auth
def diagnostic_digest(user):
    data = _json()
    try:
        docs = [model.normalize_document(d) for d in (data.get('documents') or [])]
        if not docs:
            return jsonify({'error': 'No sequences given'}), 400
        names = data.get('enzymes') or restriction.enzyme_sets()['Default']
        results = restriction.diagnostic_digests(
            docs, names, max_enzymes=int(data.get('max_enzymes', 2)),
            min_bands=int(data.get('min_bands', 2)), max_bands=int(data.get('max_bands', 5)),
            min_size=int(data.get('min_size', 250)))
    except (ValueError, TypeError) as exc:
        return _bad(exc)
    return jsonify({'suggestions': results}), 200


# ---------------------------------------------------------------------------
# Translation, ORFs, features
# ---------------------------------------------------------------------------

@tools_bp.route('/translate', methods=['POST'])
@require_auth
def translate_region(user):
    data = _json()
    seq = model.clean_sequence(data.get('sequence') or '')
    if not seq:
        try:
            doc = _document(data)
        except ValueError as exc:
            return _bad(exc)
        start, end = int(data.get('start', 0)), int(data.get('end', len(doc['sequence'])))
        seq = model.subsequence(doc['sequence'], start, end, doc['circular'])
        if data.get('strand') == -1:
            seq = model.reverse_complement(seq)
    protein = translate.translate(seq, to_stop=bool(data.get('to_stop')))
    return jsonify({'protein': protein, 'three_letter': ''.join(translate.THREE_LETTER.get(a, 'Xaa') for a in protein),
                    **translate.protein_stats(protein)}), 200


@tools_bp.route('/reverse-translate', methods=['POST'])
@require_auth
def reverse_translate(user):
    protein = (_json().get('protein') or '').strip()
    if not protein:
        return jsonify({'error': 'No protein sequence given'}), 400
    return jsonify({'sequence': translate.reverse_translate(protein)}), 200


@tools_bp.route('/orfs', methods=['POST'])
@require_auth
def orfs(user):
    data = _json()
    try:
        doc = _document(data)
        found = translate.find_orfs(doc['sequence'], doc['circular'],
                                    min_aa=int(data.get('min_aa', 75)),
                                    require_start=data.get('require_start', True) is not False)
    except (ValueError, TypeError) as exc:
        return _bad(exc)
    if not data.get('include_protein'):
        for o in found:
            o.pop('protein', None)
    return jsonify({'orfs': found, 'count': len(found)}), 200


@tools_bp.route('/find', methods=['POST'])
@require_auth
def find(user):
    """Find a DNA pattern (IUPAC) or a peptide in all six frames."""
    data = _json()
    try:
        doc = _document(data)
    except ValueError as exc:
        return _bad(exc)
    query = (data.get('query') or '').strip()
    if not query:
        return jsonify({'error': 'No search pattern given'}), 400
    if data.get('mode') == 'protein':
        hits = features.find_protein(doc['sequence'], query, doc['circular'])
    else:
        hits = features.find_pattern(doc['sequence'], query, doc['circular'],
                                     data.get('both_strands', True) is not False)
    return jsonify({'hits': hits, 'count': len(hits)}), 200


@tools_bp.route('/annotate', methods=['POST'])
@require_auth
def annotate(user):
    """Auto-annotate from a feature library (uploaded ApE-style file or the built-in set)."""
    data = _json()
    try:
        doc = _document(data)
    except ValueError as exc:
        return _bad(exc)
    library = data.get('library')
    if not library:
        from app.services.library import default_library
        library = default_library()
    new = features.auto_annotate(doc, library)
    return jsonify({'features': new, 'count': len(new)}), 200


# ---------------------------------------------------------------------------
# Primers and PCR
# ---------------------------------------------------------------------------

@tools_bp.route('/oligo', methods=['POST'])
@require_auth
def oligo(user):
    data = _json()
    seq = data.get('sequence') or ''
    if not model.clean_sequence(seq):
        return jsonify({'error': 'No oligo sequence given'}), 400
    kw = {k: float(data[k]) for k in ('na_mm', 'mg_mm', 'dntps_mm', 'oligo_nm') if k in data}
    return jsonify(primers.oligo_report(seq, **kw)), 200


@tools_bp.route('/primer-sites', methods=['POST'])
@require_auth
def primer_sites(user):
    data = _json()
    try:
        doc = _document(data)
    except ValueError as exc:
        return _bad(exc)
    results = []
    for p in data.get('primers') or []:
        seq = p.get('sequence') if isinstance(p, dict) else p
        name = p.get('name') if isinstance(p, dict) else 'primer'
        hits = primers.find_binding_sites(doc['sequence'], seq or '', doc['circular'],
                                          int(data.get('min_anneal', 15)),
                                          int(data.get('max_mismatches', 0)))
        results.append({'name': name, 'sequence': (seq or '').upper(), 'sites': hits})
    return jsonify({'primers': results}), 200


@tools_bp.route('/pcr', methods=['POST'])
@require_auth
def run_pcr(user):
    data = _json()
    try:
        doc = _document(data)
        products = primers.pcr(doc['sequence'], data.get('forward') or '', data.get('reverse') or '',
                               doc['circular'], int(data.get('min_anneal', 15)),
                               int(data.get('max_mismatches', 0)))
    except (ValueError, TypeError) as exc:
        return _bad(exc)
    return jsonify({'products': products, 'count': len(products),
                    'forward': primers.oligo_report(data.get('forward') or ''),
                    'reverse': primers.oligo_report(data.get('reverse') or '')}), 200


@tools_bp.route('/design-primers', methods=['POST'])
@require_auth
def design_primers(user):
    data = _json()
    try:
        doc = _document(data)
        result = primers.design_primers(
            doc['sequence'], int(data['start']), int(data['end']),
            target_tm=float(data.get('target_tm', 60.0)),
            min_len=int(data.get('min_len', 18)), max_len=int(data.get('max_len', 32)),
            forward_tail=data.get('forward_tail', ''), reverse_tail=data.get('reverse_tail', ''),
            circular=doc['circular'])
    except (KeyError, ValueError, TypeError) as exc:
        return _bad(exc)
    return jsonify(result), 200


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------

@tools_bp.route('/golden-gate', methods=['POST'])
@require_auth
def golden_gate_assemble(user):
    data = _json()
    try:
        docs = [model.normalize_document(d) for d in (data.get('documents') or [])]
        if len(docs) < 2:
            return jsonify({'error': 'Golden Gate assembly needs at least two parts'}), 400
        result = assembly.golden_gate(docs, data.get('enzyme') or 'BsaI',
                                      name=data.get('name') or 'Golden Gate product')
    except ValueError as exc:
        return _bad(exc)
    return jsonify(result), 200


@tools_bp.route('/gibson', methods=['POST'])
@require_auth
def gibson(user):
    data = _json()
    try:
        frags = [model.normalize_document(d) for d in (data.get('documents') or [])]
        result = assembly.overlap_assembly(frags, circular=data.get('circular', True) is not False,
                                           min_overlap=int(data.get('min_overlap', 15)),
                                           name=data.get('name') or 'Gibson product')
    except ValueError as exc:
        return _bad(exc)
    return jsonify(result), 200


@tools_bp.route('/ligate', methods=['POST'])
@require_auth
def ligate(user):
    """Cut a vector and an insert with chosen enzymes and report the ligation products."""
    data = _json()
    try:
        vector = model.normalize_document(data.get('vector') or {})
        insert = model.normalize_document(data.get('insert') or {})
        products = assembly.restriction_ligation(
            vector, data.get('vector_enzymes') or [], int(data.get('vector_fragment', 0)),
            insert, data.get('insert_enzymes') or [], int(data.get('insert_fragment', 0)),
            name=data.get('name') or 'Ligation product')
    except (IndexError, ValueError, TypeError) as exc:
        return _bad(exc)
    return jsonify({'products': products, 'count': len(products)}), 200


@tools_bp.route('/recombine', methods=['POST'])
@require_auth
def recombine(user):
    data = _json()
    try:
        donor = model.normalize_document(data.get('donor') or {})
        acceptor = model.normalize_document(data.get('acceptor') or {})
        results = assembly.recombine(donor, acceptor, int(data.get('min_core', 13)),
                                     int(data.get('max_core', 60)),
                                     name=data.get('name') or 'Recombination product')
    except (ValueError, TypeError) as exc:
        return _bad(exc)
    return jsonify({'products': results, 'count': len(results)}), 200


# ---------------------------------------------------------------------------
# Alignment
# ---------------------------------------------------------------------------

@tools_bp.route('/align', methods=['POST'])
@require_auth
def pairwise_align(user):
    data = _json()
    a = model.clean_sequence(data.get('a') or '')
    b = model.clean_sequence(data.get('b') or '')
    if not a or not b:
        return jsonify({'error': 'Two sequences are required'}), 400
    molecule = data.get('molecule', 'dna')
    if molecule == 'protein':
        a, b = (data.get('a') or '').upper(), (data.get('b') or '').upper()
    try:
        return jsonify(align.pairwise(a, b, data.get('mode', 'global'), molecule)), 200
    except (ValueError, KeyError) as exc:
        return _bad(exc)


@tools_bp.route('/align-reads', methods=['POST'])
@require_auth
def align_reads(user):
    """Align pasted or uploaded reads to a document without storing them."""
    data = _json()
    try:
        doc = _document(data)
    except ValueError as exc:
        return _bad(exc)
    results = []
    for r in data.get('reads') or []:
        bases = model.clean_sequence(r.get('sequence') if isinstance(r, dict) else r or '')
        name = r.get('name') if isinstance(r, dict) else 'read'
        if not bases:
            continue
        results.append(align.map_read(doc['sequence'], bases, doc['circular'],
                                      r.get('quality') if isinstance(r, dict) else None, name or 'read'))
    return jsonify({'reads': results,
                    'coverage': align.coverage(len(doc['sequence']), results)}), 200


@tools_bp.route('/trace', methods=['POST'])
@require_auth
def trace(user):
    """Read an ABI chromatogram and align it in one step."""
    f = request.files.get('file')
    if f is None:
        return jsonify({'error': 'No file uploaded'}), 400
    try:
        parsed = seqio.read_trace(f.read())
    except seqio.SequenceFileError as exc:
        return _bad(exc)
    reference = model.clean_sequence(request.form.get('reference') or '')
    alignment = None
    if reference:
        alignment = align.map_read(reference, parsed['sequence'],
                                   request.form.get('circular') == 'true',
                                   parsed['quality'], parsed['name'])
    return jsonify({'trace': parsed, 'alignment': alignment}), 200
