#!/usr/bin/env python3
"""Transcode camcorder 3D recordings into side-by-side HEVC MP4s.

Inputs come from mvcscan.py results: stereoscopic files with camcorder
metadata, one copy per recording.

  * H.264 MVC (Sony HDR-TD10 .mts, JVC GS-TD1 .mp4, and others): both views
    deinterlaced to full field rate and stacked into a full-width frame —
    3840x1080 for 1080i — with the suffix _LR.
  * Frame packed side-by-side (JVC GS-TD1 AVCHD 3D .MTS): deinterlaced, kept at
    its native half width, with the suffix _3DH.

Decoding the dependent MVC view needs the patched FFmpeg in ../ffmpeg; stock
FFmpeg decodes only one eye. Video is encoded with x265 (default) or on the GPU
with VAAPI. AAC audio is copied; anything else becomes AAC (5.1 at 384k, stereo
at 192k), because the Meta Quest's default player plays no Opus in MP4.

The recording date comes from the camera's own MDPM metadata in the stream,
which carries its time zone, falling back to the container's creation time;
the GPS position comes from MDPM too, where the camera recorded one. With
--immich-metadata, Immich's database fills the gaps: its date where MDPM has
none, and its GPS position in preference to the camera's, so a location set by
hand in Immich survives. Both are written as QuickTime metadata, which Immich
reads.

Each file is written under a temporary name, verified, then renamed, so an
interrupted run can simply be restarted: finished outputs are skipped.

    ./mvcscan.py /media/camcorder -o scan.jsonl
    ./mvc2sbs.py --scan scan.jsonl --out-root /media/3d-sbs --dry-run
    ./mvc2sbs.py --scan scan.jsonl --out-root /media/3d-sbs
"""
import argparse
import collections
import datetime
import importlib.util
import json
import os
import re
import shlex
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
BUNDLED_FFMPEG = os.path.join(REPO, 'ffmpeg', 'bin', 'ffmpeg')
JVC_3D_MODEL = 'GS-TD1'      # the only JVC 3D camcorder; its MP4s record no model name

spec = importlib.util.spec_from_file_location('mvcscan', os.path.join(HERE, 'mvcscan.py'))
mvcscan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mvcscan)


# --------------------------------------------------------------------------- inputs

def load_recordings(scan_files, prefer_root=None):
    """One copy of each stereoscopic camcorder recording in the scan results."""
    rows = {}
    for fn in scan_files:
        with open(fn) as f:
            for line in f:
                r = json.loads(line)
                rows[r['path']] = r          # later files override earlier ones
    groups = collections.defaultdict(list)
    for r in rows.values():
        cam = r.get('camera') or {}
        if not r.get('stereo3d') or r.get('mv_hevc') or not cam.get('make'):
            continue
        if not os.path.exists(r['path']):
            continue
        groups[(r['size'], r.get('head_sha1'))].append(r)
    recs = []
    for copies in groups.values():
        if prefer_root:
            copies.sort(key=lambda r: (not r['path'].startswith(prefer_root.rstrip('/') + '/'), r['path']))
        else:
            copies.sort(key=lambda r: r['path'])
        recs.append(copies[0])
    return sorted(recs, key=lambda r: r['path'])


def immich_metadata(path_maps):
    """Local path -> date, GPS and camera, from Immich's database.

    Uses the same settings as viewer/tools/immich_db.py: IMMICH_DB_CONTAINER,
    DB_USERNAME and DB_DATABASE_NAME, defaulting to Immich's official compose
    names. path_maps translate paths as Immich stores them to local ones.
    """
    sql = ('select a."originalPath", e."dateTimeOriginal", e.latitude, e.longitude, e.make, e.model '
           'from asset a left join asset_exif e on e."assetId" = a.id where a."deletedAt" is null')
    container = os.environ.get('IMMICH_DB_CONTAINER', 'immich_postgres')
    out = subprocess.run(
        ['docker', 'exec', '-i', container, 'psql', '-U', os.environ.get('DB_USERNAME', 'postgres'),
         '-d', os.environ.get('DB_DATABASE_NAME', 'immich'), '-At', '-F', '\t'],
        input=sql, capture_output=True, text=True)
    if out.returncode:
        sys.exit(f'Immich query in {container!r} failed: {out.stderr.strip()}')
    meta = {}
    for line in out.stdout.splitlines():
        path, dto, lat, lon, make, model = (line.split('\t') + [''] * 6)[:6]
        for src, dst in path_maps:
            if path.startswith(src):
                path = dst + path[len(src):]
                break
        meta[path] = {'date': dto or None, 'lat': float(lat) if lat else None,
                      'lon': float(lon) if lon else None, 'make': make or None, 'model': model or None}
    return meta


def mdpm_tags(path):
    """Raw MDPM tags of the first MDPM SEI in the file's first few MiB."""
    with open(path, 'rb') as f:
        d = f.read(8 << 20)
    i = d.find(mvcscan.MDPM_UUID + b'MDPM')
    if i < 0:
        return {}
    raw = mvcscan.unescape(d[i + 20:i + 20 + 1 + 5 * 255])
    tags = {}
    for k in range(raw[0]):
        e = raw[1 + 5 * k:6 + 5 * k]
        if len(e) == 5:
            tags.setdefault(e[0], e[1:])
    return tags


def mdpm_datetime(tags):
    """Recording time as an aware datetime (naive if no zone was recorded)."""
    if 0x18 not in tags or 0x19 not in tags:
        return None
    a, b = tags[0x18], tags[0x19]
    bcd = mvcscan.bcd
    try:
        dt = datetime.datetime(bcd(a[1]) * 100 + bcd(a[2]), bcd(a[3]), bcd(b[0]),
                               bcd(b[1]), bcd(b[2]), bcd(b[3]))
    except ValueError:
        return None
    tz = a[0]
    if tz:
        # bit 5: west of UTC, bits 4-1: hours, bit 0: half hour
        offset = datetime.timedelta(hours=(tz >> 1) & 0x0f, minutes=30 * (tz & 1))
        dt = dt.replace(tzinfo=datetime.timezone(-offset if tz & 0x20 else offset))
    return dt


def mdpm_gps(tags):
    def rational(t):
        return int.from_bytes(tags[t][:2], 'big') / max(1, int.from_bytes(tags[t][2:], 'big'))
    try:
        lat = rational(0xb2) + rational(0xb3) / 60 + rational(0xb4) / 3600
        lon = rational(0xb6) + rational(0xb7) / 60 + rational(0xb8) / 3600
    except KeyError:
        return None
    if tags.get(0xb1, b'N')[:1] == b'S':
        lat = -lat
    if tags.get(0xb5, b'E')[:1] == b'W':
        lon = -lon
    return (lat, lon) if lat or lon else None


# --------------------------------------------------------------------------- ffmpeg

class FFmpeg:
    """The ffmpeg and ffprobe to run.

    The bundled ones are wrappers around a container. They bind-mount the
    directories named in MVC_MOUNTS, so each call says which directories it
    reads and writes; a natively installed ffmpeg simply ignores that.
    """

    def __init__(self, ffmpeg, ffprobe=None):
        self.ffmpeg = ffmpeg
        if ffprobe:
            self.ffprobe = ffprobe
        elif os.sep in ffmpeg:
            self.ffprobe = os.path.join(os.path.dirname(ffmpeg), 'ffprobe')
        else:
            self.ffprobe = 'ffprobe'

    @staticmethod
    def env(read, write):
        lines = [f'{os.path.abspath(d)}:ro' for d in read] + [os.path.abspath(d) for d in write]
        return {**os.environ, 'MVC_MOUNTS': '\n'.join(lines)}

    def probe(self, path, write_dir=None):
        out = subprocess.run(
            [self.ffprobe, '-v', 'error', '-show_entries',
             'format=duration:format_tags=creation_time:stream=index,codec_type,codec_name,channels,'
             'channel_layout,nb_frames,duration,start_time,r_frame_rate',
             '-of', 'json', path],
            capture_output=True, text=True,
            env=self.env([os.path.dirname(path)], [write_dir] if write_dir else []))
        if out.returncode:
            raise RuntimeError(out.stderr.strip())
        return json.loads(out.stdout)


def audio_lead(ff, path, info):
    """Seconds of audio before the first video frame, 0 unless it is a real gap.

    A video stream's start_time is its first packet in decode order, which comes
    after the first displayed frame in these open GOP streams, so only a gap well
    beyond that is looked at, and then measured on the decoded frames.
    """
    starts = {s['codec_type']: float(s['start_time']) for s in reversed(info['streams'])
              if s.get('start_time') not in (None, 'N/A') and s['codec_type'] in ('audio', 'video')}
    if 'audio' not in starts or 'video' not in starts or starts['video'] - starts['audio'] < 0.2:
        return 0.0
    out = subprocess.run([ff.ffmpeg, '-hide_banner', '-nostats', '-copyts', '-i', path, '-map', '0:v:0',
                          '-vf', 'showinfo', '-frames:v', '12', '-f', 'null', '-'],
                         capture_output=True, text=True, env=ff.env([os.path.dirname(path)], []))
    pts = [float(m) for m in re.findall(r'pts_time:(-?[0-9.]+)', out.stderr)]
    return max(0.0, min(pts) - starts['audio']) if pts else 0.0


def rate(s):
    """An ffprobe rational such as 60000/1001, as a float (0 if unknown)."""
    try:
        n, d = (s or '0/1').split('/')
        return float(n) / float(d) if float(d) else 0.0
    except ValueError:
        return 0.0


def container_date(ff, path):
    """The container's creation time, which JVC's MP4s use for the recording time."""
    try:
        created = (ff.probe(path).get('format', {}).get('tags') or {}).get('creation_time')
    except RuntimeError:
        return None
    return datetime.datetime.fromisoformat(created.replace('Z', '+00:00')) if created else None


def plan(rec, immich, args, ff):
    path = rec['path']
    cam = dict(rec.get('camera') or {})
    mvc = rec['mvc']
    stem = os.path.splitext(os.path.basename(path))[0]
    tags = mdpm_tags(path)
    meta = immich.get(path, {})

    date = mdpm_datetime(tags)
    if date is None and meta.get('date'):
        date = datetime.datetime.fromisoformat(meta['date'])
    if date is None:
        # Before the file's mtime, which records when it was last copied, not
        # when it was filmed — and decides which folder the output lands in.
        date = container_date(ff, path)
    gps = (meta['lat'], meta['lon']) if meta.get('lat') is not None else mdpm_gps(tags)
    make = cam.get('make') or meta.get('make')
    model = cam.get('model') or meta.get('model') or (JVC_3D_MODEL if make == 'JVC' else None)

    suffix = '_LR' if mvc else '_3DH'
    keep = args.keep_layout.rstrip('/') + '/' if args.keep_layout else None
    if keep and path.startswith(keep):
        rel = os.path.dirname(os.path.relpath(path, keep))
        name = stem + suffix + '.mp4'
    else:
        when = date or datetime.datetime.fromtimestamp(rec['mtime'])
        rel = when.strftime('%Y/%m')
        name = f"{when.strftime('%Y%m%d_%H%M%S')}_{make}_{stem}{suffix}.mp4"
    return {'input': path, 'output': os.path.join(args.out_root, rel, name), 'mvc': mvc,
            'date': date, 'gps': gps, 'make': make, 'model': model}


def build_command(ff, job, info, tmp_out, args, lead=0.0):
    audio = [s for s in info['streams'] if s['codec_type'] == 'audio']
    deint = 'bwdif=mode=send_field:parity=auto:deint=all'
    # Audio that starts before the picture is trimmed, so that both tracks start
    # at zero rather than relying on players honouring an MP4 edit list.
    trim = lead > 0.1 and audio and audio[0]['codec_name'] != 'aac'
    if trim:
        deint += ',setpts=PTS-STARTPTS'

    vaapi = args.encoder == 'vaapi'
    tail = ',format=nv12,hwupload' if vaapi else ',format=yuv420p'
    if job['mvc']:
        vf = f'[0:v:view:0]{deint}[l];[0:v:view:1]{deint}[r];[l][r]hstack=inputs=2{tail}[v]'
        bitrate = ['-b:v', '20M', '-maxrate', '30M', '-bufsize', '40M']
    else:
        vf = f'[0:v:0]{deint}{tail}[v]'
        bitrate = ['-b:v', '12M', '-maxrate', '18M', '-bufsize', '24M']

    cmd = [ff.ffmpeg, '-hide_banner', '-nostdin', '-v', 'warning', '-stats_period', '10']
    if vaapi:
        cmd += ['-init_hw_device', f'vaapi=va:{args.vaapi_device}', '-filter_hw_device', 'va']
    cmd += ['-i', job['input'], '-filter_complex', vf, '-map', '[v]', '-fps_mode', 'passthrough']
    if vaapi:
        # Quality-targeted VBR on Intel's low-power encoder: what the reference
        # library was made with, at about 1.3x realtime on an N150.
        cmd += ['-c:v', 'hevc_vaapi', '-low_power', '1', '-rc_mode', 'QVBR',
                '-global_quality:v', str(args.quality), *bitrate]
    else:
        cmd += ['-c:v', 'libx265', '-preset', args.preset, '-crf', str(args.crf),
                '-x265-params', 'log-level=warning']
    cmd += ['-g', '120', '-tag:v', 'hvc1',
            '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709']
    if audio:
        a = audio[0]
        cmd += ['-map', f"0:{a['index']}"]
        if a['codec_name'] == 'aac':
            cmd += ['-c:a', 'copy']
        else:
            af = [f'atrim=start={lead:.6f}', 'asetpts=PTS-STARTPTS'] if trim else []
            if (a.get('channels') or 2) > 2:
                af.append('aformat=channel_layouts=5.1')
            if af:
                cmd += ['-af', ','.join(af)]
            cmd += ['-c:a', 'aac', '-b:a', '384k' if (a.get('channels') or 2) > 2 else '192k']

    cmd += ['-map_metadata', '-1', '-movflags', '+faststart+use_metadata_tags']
    date = job['date']
    if date:
        utc = date.astimezone(datetime.timezone.utc) if date.tzinfo else date
        cmd += ['-metadata', f"creation_time={utc.strftime('%Y-%m-%dT%H:%M:%S')}Z",
                '-metadata', 'com.apple.quicktime.creationdate=' +
                (date.strftime('%Y-%m-%dT%H:%M:%S%z') if date.tzinfo else date.strftime('%Y-%m-%dT%H:%M:%SZ'))]
    if job['make']:
        cmd += ['-metadata', f"com.apple.quicktime.make={job['make']}"]
    if job['model']:
        cmd += ['-metadata', f"com.apple.quicktime.model={job['model']}"]
    if job['gps']:
        cmd += ['-metadata', 'com.apple.quicktime.location.ISO6709=%+09.5f%+010.5f/' % job['gps']]
    cmd += ['-metadata', 'comment=Stereoscopic 3D, side-by-side (' +
            ('full width, left eye first' if job['mvc'] else 'half width, left eye first') + ')',
            '-f', 'mp4', '-y', tmp_out]
    return cmd


def verify(src_info, out_info):
    # The video stream's own duration: audio may run longer than the picture.
    vdur = [float(s['duration']) for s in src_info['streams']
            if s['codec_type'] == 'video' and s.get('duration') not in (None, 'N/A')]
    dur_in = max(vdur) if vdur else float(src_info['format']['duration'])
    dur_out = float(out_info['format']['duration'])
    v = [s for s in out_info['streams'] if s['codec_type'] == 'video']
    if not v or abs(dur_in - dur_out) > 1.5:
        return f'duration {dur_out:.2f}s vs source {dur_in:.2f}s'
    # Deinterlacing emits a frame per field, so expect the source's field rate —
    # 59.94 from NTSC 1080i, 50 from PAL — which ffprobe reports as r_frame_rate
    # for these streams. Taken from the source, not the output: an MP4's own
    # rate is derived from its frame count, so checking against it proves nothing.
    src_v = [s for s in src_info['streams'] if s['codec_type'] == 'video']
    fps = rate(src_v[0].get('r_frame_rate')) if src_v else 0.0
    frames = int(v[0].get('nb_frames') or 0)
    if fps and frames < dur_in * fps * 0.97:
        return f'{frames} frames, expected about {dur_in * fps:.0f} at {fps:.2f} fps'
    return None


def run_job(ff, job, args):
    out = job['output']
    out_dir = os.path.dirname(out)
    os.makedirs(out_dir, exist_ok=True)
    tmp = os.path.join(out_dir, '.' + os.path.basename(out) + '.part')
    log_path = os.path.join(args.log_dir, os.path.basename(out) + '.log')
    t0 = time.time()
    src = ff.probe(job['input'])
    lead = audio_lead(ff, job['input'], src)
    cmd = build_command(ff, job, src, tmp, args, lead)
    with open(log_path, 'w') as log:
        log.write(' '.join(shlex.quote(c) for c in cmd) + '\n\n')
        log.flush()
        rc = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT,
                            env=ff.env([os.path.dirname(job['input'])], [out_dir])).returncode
    if rc:
        if os.path.exists(tmp):
            os.remove(tmp)
        return {'status': 'failed', 'error': f'ffmpeg exit {rc}, see {log_path}'}
    problem = verify(src, ff.probe(tmp, out_dir))
    if problem:
        os.remove(tmp)
        return {'status': 'failed', 'error': problem}
    os.rename(tmp, out)
    dur = float(src['format']['duration'])
    took = time.time() - t0
    return {'status': 'done', 'audio_trimmed': round(lead, 3) if lead > 0.1 else 0,
            'seconds': round(took, 1), 'speed': round(dur / took, 2),
            'in_mb': round(os.path.getsize(job['input']) / 1e6), 'out_mb': round(os.path.getsize(out) / 1e6)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--scan', nargs='+', required=True, help='mvcscan.py results (JSONL)')
    ap.add_argument('--out-root', required=True, help='where the side-by-side files go')
    ap.add_argument('--keep-layout', metavar='ROOT',
                    help='inputs under ROOT keep their relative folders and file names; '
                         'anything else is filed by recording date as YYYY/MM/<date>_<make>_<name>')
    ap.add_argument('--encoder', choices=['x265', 'vaapi'], default='x265',
                    help='x265 runs anywhere; vaapi encodes on an Intel or AMD GPU (default: %(default)s)')
    ap.add_argument('--crf', type=float, default=20, help='x265 quality, lower is better (default: %(default)s)')
    ap.add_argument('--preset', default='slow', help='x265 speed/efficiency preset (default: %(default)s)')
    ap.add_argument('--quality', type=int, default=25, help='VAAPI QVBR quality (default: %(default)s)')
    ap.add_argument('--vaapi-device', default='/dev/dri/renderD128')
    ap.add_argument('--ffmpeg', help='ffmpeg with MVC decoding (default: the bundled one, if built)')
    ap.add_argument('--ffprobe', help='matching ffprobe (default: beside --ffmpeg)')
    ap.add_argument('--immich-metadata', action='store_true',
                    help="take dates, GPS and camera names from Immich's database where it has the file")
    ap.add_argument('--immich-path-map', action='append', default=[], metavar='IMMICH=LOCAL',
                    help='translate a path prefix as Immich stores it to the local one (repeatable)')
    ap.add_argument('--log-dir', default='mvc2sbs-logs', help='per-file ffmpeg logs and summary.jsonl')
    ap.add_argument('--only', nargs='*', help='process only these input paths')
    ap.add_argument('--limit', type=int, help='stop after this many conversions')
    ap.add_argument('--dry-run', action='store_true', help='list what would be done')
    args = ap.parse_args()

    ffmpeg = args.ffmpeg or (BUNDLED_FFMPEG if os.path.exists(os.path.join(REPO, 'ffmpeg', 'build', 'ffmpeg'))
                             else 'ffmpeg')
    ff = FFmpeg(ffmpeg, args.ffprobe)

    recs = load_recordings(args.scan, args.keep_layout)
    if args.only:
        wanted = {os.path.abspath(p) for p in args.only}
        recs = [r for r in recs if r['path'] in wanted]
    maps = []
    for m in args.immich_path_map:
        if '=' not in m:
            ap.error(f'--immich-path-map needs IMMICH=LOCAL, got {m!r}')
        src, dst = m.split('=', 1)
        maps.append((src.rstrip('/') + '/', dst.rstrip('/') + '/'))
    immich = immich_metadata(maps) if args.immich_metadata else {}
    jobs = [plan(r, immich, args, ff) for r in recs]
    todo = [j for j in jobs if not os.path.exists(j['output'])]
    print(f'{len(jobs)} recordings, {len(jobs) - len(todo)} already converted, {len(todo)} to do'
          f' — {args.encoder} via {ff.ffmpeg}', flush=True)

    os.makedirs(args.log_dir, exist_ok=True)
    summary = open(os.path.join(args.log_dir, 'summary.jsonl'), 'a')
    for n, job in enumerate(todo[:args.limit] if args.limit else todo, 1):
        print(f"[{n}/{len(todo)}] {job['input']} -> {job['output']} "
              f"({job['make']} {job['model']}, {job['date']}, gps {job['gps']})", flush=True)
        if args.dry_run:
            continue
        try:
            res = run_job(ff, job, args)
        except Exception as e:      # keep going with the next recording
            res = {'status': 'failed', 'error': repr(e)}
        print(f'    {res}', flush=True)
        summary.write(json.dumps({'input': job['input'], 'output': job['output'], **res,
                                  'finished': datetime.datetime.now().isoformat(timespec='seconds')}) + '\n')
        summary.flush()


if __name__ == '__main__':
    main()
