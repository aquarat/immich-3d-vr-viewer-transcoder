#!/usr/bin/env python3
"""List the Apple spatial (MV-HEVC) videos in an Immich library.

Spatial video carries a `vexu` box. In iPhone .MOV files it sits in a moov
atom written at the END of the file, so a scan of the first few megabytes finds
nothing — this reads the tail instead.

Candidates come from Immich's database (see immich_db.py for the connection
settings), limited by camera model so a large library is not read end to end.
Immich stores paths as its container sees them; --path-map translates them to
where the same files are on this machine.

    tools/find-spatial-videos.py \\
        --path-map /usr/src/app/upload=/srv/immich/upload \\
        --path-map /originals=/srv/media/originals > spatial.txt

Each file is dropped from the page cache after reading, which matters when this
runs on the same machine as Immich's database: thousands of files left in cache
can push a memory-tight host into swap.

With --cache, a file already checked is not read again unless its size or
modification time has changed, so a nightly run reads only what is new. The
first run with a fresh cache reads everything.
"""
import argparse
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import immich_db  # noqa: E402

# Devices that record spatial video: iPhone 15 Pro and later with two rear
# cameras, and the Vision Pro. 'iPhone 16%' also catches the single-camera 16e,
# which only costs a wasted read.
DEFAULT_MODELS = ['iPhone 15 Pro%', 'iPhone 16%', 'iPhone 17%', 'Apple Vision Pro%']


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--path-map', action='append', default=[], metavar='IMMICH=HOST',
                    help='translate a path prefix as Immich stores it to where it is here (repeatable)')
    ap.add_argument('--model', action='append', metavar='PATTERN',
                    help='camera model LIKE pattern to consider (repeatable; default: spatial-capable Apple devices)')
    ap.add_argument('--all-videos', action='store_true', help='consider every video, whatever the camera')
    ap.add_argument('--tail', type=int, default=1_500_000, help='bytes read from the end of each file')
    ap.add_argument('--limit', type=int, help='stop after this many candidates (for a trial run)')
    ap.add_argument('--cache', help='remember results here (TSV) and skip unchanged files next time')
    args = ap.parse_args()

    maps = []
    for m in args.path_map:
        if '=' not in m:
            ap.error(f'--path-map needs IMMICH=HOST, got {m!r}')
        src, dst = m.split('=', 1)
        maps.append((src.rstrip('/') + '/', dst.rstrip('/') + '/'))

    def local(p):
        for src, dst in maps:
            if p.startswith(src):
                return dst + p[len(src):]
        return p

    where = ["a.\"deletedAt\" is null", "a.type = 'VIDEO'"]
    if not args.all_videos:
        models = args.model or DEFAULT_MODELS
        where.append('(' + ' or '.join(f'e.model like {immich_db.literal(m)}' for m in models) + ')')
    rows = immich_db.query(f"""
select a."originalPath" from asset a left join asset_exif e on e."assetId" = a.id
where {' and '.join(where)} order by a."fileCreatedAt" desc;""")
    paths = [r[0] for r in rows][:args.limit]
    print(f'scanning {len(paths)} candidate videos', file=sys.stderr)

    # path -> (size, mtime_ns, spatial): a file is only read again if it changed.
    cache = {}
    if args.cache and os.path.exists(args.cache):
        with open(args.cache) as f:
            for line in f:
                parts = line.rstrip('\n').split('\t')
                if len(parts) == 4:
                    cache[parts[0]] = (int(parts[1]), int(parts[2]), parts[3] == '1')

    t0 = time.time()
    found = missing = read = 0
    fresh = {}
    for i, p in enumerate(paths, 1):
        try:
            fd = os.open(local(p), os.O_RDONLY)
        except OSError:
            missing += 1
            if missing == 1:
                print(f'cannot open {local(p)!r} — is a --path-map needed?', file=sys.stderr)
            continue
        try:
            st = os.fstat(fd)
            known = cache.get(p)
            if known and known[:2] == (st.st_size, st.st_mtime_ns):
                spatial = known[2]
            else:
                os.lseek(fd, max(0, st.st_size - args.tail), os.SEEK_SET)
                spatial = b'vexu' in os.read(fd, args.tail)
                os.posix_fadvise(fd, 0, 0, os.POSIX_FADV_DONTNEED)
                read += 1
        finally:
            os.close(fd)
        fresh[p] = (st.st_size, st.st_mtime_ns, spatial)
        if spatial:
            found += 1
            print(p, flush=True)        # Immich's own path, as backfill-albums.py expects
        if i % 500 == 0:
            print(f'  {i}/{len(paths)} · {read} read · {found} spatial · {time.time() - t0:.0f}s',
                  file=sys.stderr, flush=True)

    if args.cache and not args.limit:
        # Only what still exists is kept; written whole, then moved into place.
        tmp = args.cache + '.tmp'
        with open(tmp, 'w') as f:
            for p, (size, mtime, spatial) in fresh.items():
                f.write(f'{p}\t{size}\t{mtime}\t{int(spatial)}\n')
        os.replace(tmp, args.cache)
    print(f'done: {found} spatial of {len(paths)}, {read} read, {len(paths) - read - missing} unchanged, '
          f'{missing} unreadable, in {time.time() - t0:.0f}s', file=sys.stderr)


if __name__ == '__main__':
    main()
