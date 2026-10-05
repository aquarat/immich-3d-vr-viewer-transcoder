#!/usr/bin/env python3
"""Put stereoscopic and 360 media into the Immich albums the viewer reads.

  VR 3D-SBS    side-by-side video: by default, the files the transcoder writes
               (*_LR.mp4 full width, *_3DH.mp4 half width), or anything under a
               path prefix you give with --sbs-path
  VR 360       anything Immich has tagged EQUIRECTANGULAR (photos and video)
  VR Spatial   Apple spatial (MV-HEVC) video, from a list made by
               find-spatial-videos.py

Albums rather than tags, for a reason worth knowing: Immich's metadata
extraction replaces an asset's entire tag set with whatever the file's own XMP
carries, so a tag applied by hand survives only until the next extraction pass
over that asset. Album membership is not derived from file metadata.

Selection reads Immich's database (see immich_db.py for the connection
settings). Writes go through the API, because album membership has audit tables
and sync state behind it that the mobile apps read.

    tools/backfill-albums.py                         what would change
    IMMICH_API_KEY=... tools/backfill-albums.py --apply

An API key belongs to one user, so --apply covers that user's own assets. Other
users need their own key; the viewer only shows what the signed-in user can see.
"""
import argparse
import json
import os
import sys
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import immich_db  # noqa: E402

BASE = os.environ.get('IMMICH_URL', 'http://127.0.0.1:2283').rstrip('/')
BATCH = 500
SBS, EQUIRECT, SPATIAL = 'VR 3D-SBS', 'VR 360', 'VR Spatial'

# The transcoder's output names. Selection never guesses from aspect ratio: a
# library's ~2:1 frames are mostly phone photos, not stereo pairs.
SBS_BY_NAME = (r"""(a."originalFileName" ilike '%\_LR.mp4' or a."originalFileName" ilike '%\_3DH.mp4')"""
               """ and a.type = 'VIDEO'""")
EQUIRECT_PRED = """exists (select 1 from asset_exif e
                           where e."assetId" = a.id and e."projectionType" = 'EQUIRECTANGULAR')"""


def api(key, method, path, body=None):
    req = urllib.request.Request(
        f'{BASE}/api{path}', method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={'x-api-key': key, 'Content-Type': 'application/json', 'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        sys.exit(f'{method} {path} -> {e.code} {e.reason}: {e.read()[:300].decode("utf-8", "replace")}')


def selections(args):
    preds = {}
    if args.sbs_path:
        preds[SBS] = (f'a."originalPath" like {immich_db.literal(args.sbs_path.rstrip("/") + "/%")}'
                      " and a.type = 'VIDEO'")
    else:
        preds[SBS] = SBS_BY_NAME
    preds[EQUIRECT] = EQUIRECT_PRED
    if args.spatial_list:
        with open(args.spatial_list) as f:
            paths = [line.strip() for line in f if line.strip()]
        if paths:
            preds[SPATIAL] = 'a."originalPath" in (' + ', '.join(immich_db.literal(p) for p in paths) + ')'
    if args.only:
        preds = {k: v for k, v in preds.items() if k == args.only}
    return preds


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--apply', action='store_true', help='make the change (needs IMMICH_API_KEY)')
    ap.add_argument('--key', default=os.environ.get('IMMICH_API_KEY'), help='Immich API key')
    ap.add_argument('--sbs-path', help='select side-by-side video by this path prefix, as Immich '
                                       'stores it (e.g. /originals/3D-SBS), instead of by file name')
    ap.add_argument('--spatial-list', help='file of spatial video paths, from find-spatial-videos.py')
    ap.add_argument('--only', choices=[SBS, EQUIRECT, SPATIAL], help='just one album')
    args = ap.parse_args()

    preds = selections(args)
    if SPATIAL not in preds and not args.only:
        print(f'{SPATIAL}: skipped — pass --spatial-list from find-spatial-videos.py')

    if not args.apply:
        # A dry run needs no key: it reports, per owner, what each album would hold.
        for name, pred in preds.items():
            rows = immich_db.query(f"""
select u.email, count(*) from asset a join "user" u on u.id = a."ownerId"
where a."deletedAt" is null and ({pred}) group by u.email order by 2 desc;""")
            for email, n in rows or [['(nobody)', '0']]:
                print(f'{name}: {n} assets owned by {email}')
        print('\ndry run — nothing written. Re-run with --apply and IMMICH_API_KEY set.')
        return

    if not args.key:
        sys.exit('--apply needs an API key: pass --key or set IMMICH_API_KEY\n'
                 '(Immich: Account Settings > API Keys > New API Key)')
    me = api(args.key, 'GET', '/users/me')
    print(f'as {me["email"]}\n')
    existing = {a['albumName']: a['id'] for a in api(args.key, 'GET', '/albums')}

    for name, pred in preds.items():
        ids = [r[0] for r in immich_db.query(f"""
select a.id from asset a
where a."deletedAt" is null and a."ownerId" = {immich_db.literal(me['id'])} and ({pred});""")]
        album_id = existing.get(name)
        if not album_id:
            if not ids:
                print(f'{name}: nothing to add')
                continue
            album_id = api(args.key, 'POST', '/albums', {
                'albumName': name,
                'description': 'Read by immich-3d-vr-viewer. Safe to curate by hand.',
            })['id']
            print(f'{name}: created album')
        added = 0
        for i in range(0, len(ids), BATCH):
            res = api(args.key, 'PUT', f'/albums/{album_id}/assets', {'ids': ids[i:i + BATCH]})
            added += sum(1 for r in (res or []) if r.get('success'))
        # Adding is idempotent: assets already present come back as duplicates.
        print(f'{name}: {len(ids)} match, {added} newly added')


if __name__ == '__main__':
    main()
