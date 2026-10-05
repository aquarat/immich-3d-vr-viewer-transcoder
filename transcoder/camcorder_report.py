#!/usr/bin/env python3
"""Summarise mvcscan.py results into a report of camcorder-made 3D video.

Keeps stereoscopic files that carry camcorder metadata (MDPM, or a maker's MP4
handler name), groups copies of the same recording by size and head hash, and
with --library notes which recordings exist only outside that folder — handy
for finding 3D footage that never made it into a photo library.

    ./camcorder_report.py scan.jsonl --library /srv/immich/originals
"""
import argparse
import collections
import json


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('scan', nargs='+', help='mvcscan.py results (JSONL); later files override earlier')
    ap.add_argument('--library', help='folder to report recordings missing from')
    args = ap.parse_args()
    library = args.library.rstrip('/') + '/' if args.library else None

    rows = {}
    for fn in args.scan:
        with open(fn) as f:
            for line in f:
                r = json.loads(line)
                rows[r['path']] = r

    groups = collections.defaultdict(list)
    for r in rows.values():
        cam = r.get('camera') or {}
        if not r.get('stereo3d') or r.get('mv_hevc') or not cam.get('make'):
            continue
        groups[(r['size'], r.get('head_sha1'))].append(r)

    by_camera = collections.defaultdict(list)
    for copies in groups.values():
        r = copies[0]
        cam = r['camera']
        kind = 'MVC' if r['mvc'] else f"frame packed ({r.get('frame_packing')})"
        model = cam.get('model') or f"(model not recorded, code {cam.get('model_code', '?')})"
        by_camera[f"{cam['make']} {model} - {kind}"].append(copies)

    print('# Camcorder 3D recordings\n')
    for label, recs in sorted(by_camera.items()):
        size = sum(c[0]['size'] for c in recs)
        dates = sorted(c[0]['camera'].get('recorded', '') for c in recs if c[0]['camera'].get('recorded'))
        print(f'## {label}\n')
        print(f'- {len(recs)} recordings, {size / 1e9:.1f} GB' +
              (f', recorded {dates[0][:10]} .. {dates[-1][:10]}' if dates else ''))
        if library:
            outside = [c for c in recs if not any(x['path'].startswith(library) for x in c)]
            print(f'- {len(recs) - len(outside)} in {library}, {len(outside)} only outside it\n')
            for c in sorted(outside, key=lambda c: c[0]['path']):
                rec = c[0]['camera'].get('recorded')
                print(f"  - `{c[0]['path']}` ({c[0]['size'] / 1e6:.0f} MB{', recorded ' + rec if rec else ''})")
        print()


if __name__ == '__main__':
    main()
