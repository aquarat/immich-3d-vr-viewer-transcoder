#!/usr/bin/env python3
"""Scan directory trees for stereoscopic 3D video by inspecting the bitstream.

Detects, without relying on file metadata or extensions:
  * H.264 MVC (Annex H): an MPEG-TS stream of type 0x20, subset SPS / coded slice
    extension NAL units (15/20) in any H.264 stream, or mvcC / mvc1 in MP4 and
    Matroska.
  * Frame packed 3D: H.264 frame packing arrangement SEI, Matroska StereoMode,
    or an st3d box.
  * MV-HEVC: lhvC / vexu boxes.

It also decodes the MDPM maker metadata SEI that most consumer camcorders write
(Sony, Panasonic, Canon, JVC), which gives the camera model and the recording
date straight from the video.

Only the first few MiB of each file are read (plus the moov box of MP4/MOV).
Results are appended to a JSONL file, so an interrupted scan can be resumed.
"""
import argparse
import hashlib
import json
import os
import re
import struct
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

READ_BYTES = 8 << 20          # how much of a file to look at
PID_BUDGET = 4 << 20          # PES payload collected per TS video PID
MDPM_UUID = bytes.fromhex('17ee8c60f84d11d98cd60800200c9a66')
MDPM_MAKES = {0x0103: 'Panasonic', 0x0108: 'Sony', 0x1011: 'Canon', 0x1104: 'JVC'}
FPA_TYPES = {0: 'checkerboard', 1: 'column', 2: 'row', 3: 'side-by-side',
             4: 'top-bottom', 5: 'frame-alternation', 6: '2d', 7: 'tile'}
MKV_STEREO = {1: 'side-by-side (left first)', 2: 'top-bottom (right first)',
              3: 'top-bottom (left first)', 4: 'checkboard (right first)',
              5: 'checkboard (left first)', 6: 'row interleaved (right first)',
              7: 'row interleaved (left first)', 8: 'column interleaved (right first)',
              9: 'column interleaved (left first)', 10: 'anaglyph (cyan/red)',
              11: 'side-by-side (right first)', 12: 'anaglyph (green/magenta)',
              13: 'both eyes laced (left first)', 14: 'both eyes laced (right first)'}
DEFAULT_EXTS = ('mts m2ts m2t ts tod ssif mp4 m4v mov 3gp mkv mk3d webm '
                '264 h264 avc 26l jsv jvt mvc').split()
DEFAULT_EXCLUDES = ['snapshots', '.snapshots', 'node_modules', '.git',
                    'thumbs', 'encoded-video', '.cache', '.Trash-1000', 'lost+found']
START = re.compile(b'\x00\x00\x01')


# --------------------------------------------------------------------------- bits

def unescape(b):
    """Remove H.264 emulation prevention bytes."""
    return b.replace(b'\x00\x00\x03', b'\x00\x00') if b'\x00\x00\x03' in b else b


class Bits:
    def __init__(self, data):
        self.d = data
        self.p = 0

    def u(self, n):
        v = 0
        for _ in range(n):
            byte = self.d[self.p >> 3] if (self.p >> 3) < len(self.d) else 0
            v = (v << 1) | ((byte >> (7 - (self.p & 7))) & 1)
            self.p += 1
        return v

    def ue(self):
        z = 0
        while self.u(1) == 0:
            z += 1
            if z > 31:
                raise ValueError('bad exp-golomb')
        return (1 << z) - 1 + self.u(z)

    def se(self):
        k = self.ue()
        return (k + 1) // 2 if k & 1 else -(k // 2)


# --------------------------------------------------------------------------- H.264

def parse_sps(rbsp):
    b = Bits(rbsp)
    r = {'profile': b.u(8)}
    b.u(8)
    r['level'] = b.u(8)
    b.ue()
    if r['profile'] in (100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135):
        chroma = b.ue()
        if chroma == 3:
            b.u(1)
        r['bit_depth'] = b.ue() + 8
        b.ue()
        b.u(1)
        if b.u(1):
            for i in range(8 if chroma != 3 else 12):
                if b.u(1):
                    last = nxt = 8
                    for _ in range(16 if i < 6 else 64):
                        if nxt:
                            nxt = (last + b.se()) % 256
                        last = nxt or last
    else:
        chroma = 1
    b.ue()
    poc_type = b.ue()
    if poc_type == 0:
        b.ue()
    elif poc_type == 1:
        b.u(1)
        b.se()
        b.se()
        for _ in range(b.ue()):
            b.se()
    b.ue()
    b.u(1)
    mbw = b.ue() + 1
    mbh = b.ue() + 1
    frame_mbs_only = b.u(1)
    if not frame_mbs_only:
        b.u(1)
    b.u(1)
    w, h = mbw * 16, mbh * 16 * (2 - frame_mbs_only)
    if b.u(1):
        cx = 2 if chroma in (1, 2) else 1
        cy = (2 if chroma == 1 else 1) * (2 - frame_mbs_only)
        cl, cr, ct, cb = b.ue(), b.ue(), b.ue(), b.ue()
        w -= (cl + cr) * cx
        h -= (ct + cb) * cy
    r['width'], r['height'] = w, h
    r['interlaced'] = not frame_mbs_only
    return r


def parse_sei(rbsp, info):
    i = 0
    n = len(rbsp)
    while i < n - 1:
        ptype = 0
        while i < n and rbsp[i] == 0xff:
            ptype += 255
            i += 1
        if i >= n:
            return
        ptype += rbsp[i]
        i += 1
        psize = 0
        while i < n and rbsp[i] == 0xff:
            psize += 255
            i += 1
        if i >= n:
            return
        psize += rbsp[i]
        i += 1
        payload = rbsp[i:i + psize]
        i += psize
        if ptype == 5 and payload[:16] == MDPM_UUID and payload[16:20] == b'MDPM':
            parse_mdpm(payload[20:], info)
        elif ptype == 45:
            try:
                b = Bits(payload)
                b.ue()
                if not b.u(1):
                    fpa = b.u(7)
                    if fpa in FPA_TYPES and fpa != 6:     # 6: 2D
                        info['frame_packing'] = FPA_TYPES[fpa]
            except (ValueError, IndexError):
                pass
        elif ptype == 37:
            info['mvc_evidence'].add('mvc_scalable_nesting_sei')
        if n - i <= 1:      # rbsp trailing bits
            return


def bcd(x):
    return (x >> 4) * 10 + (x & 15)


def parse_mdpm(d, info):
    if 'camera' in info or not d:
        return
    count = d[0]
    tags = {}
    for k in range(count):
        e = d[1 + 5 * k:6 + 5 * k]
        if len(e) == 5:
            tags.setdefault(e[0], e[1:])
    cam = {}
    if 0xe0 in tags:
        make = struct.unpack('>H', tags[0xe0][:2])[0]
        cam['make'] = MDPM_MAKES.get(make, f'0x{make:04x}')
        cam['model_code'] = tags[0xe0][2:].hex()
    model = b''.join(tags[t] for t in range(0xe4, 0xef) if t in tags)
    model = model.split(b'\x00')[0].decode('ascii', 'replace').strip()
    if model:
        cam['model'] = model
    if 0x18 in tags and 0x19 in tags:
        a, b = tags[0x18], tags[0x19]
        try:
            cam['recorded'] = (f'{bcd(a[1]):02d}{bcd(a[2]):02d}-{bcd(a[3]):02d}-{bcd(b[0]):02d} '
                               f'{bcd(b[1]):02d}:{bcd(b[2]):02d}:{bcd(b[3]):02d}')
        except IndexError:
            pass
    if cam:
        info['camera'] = cam


def new_h264_info():
    return {'nal_types': set(), 'mvc_evidence': set()}


def analyze_nal(nal, info):
    if not nal:
        return
    t = nal[0] & 0x1f
    info['nal_types'].add(t)
    try:
        if t == 7 and 'sps' not in info:
            info['sps'] = parse_sps(unescape(nal[1:60]))
        elif t == 15:
            sub = parse_sps(unescape(nal[1:60]))
            if sub['profile'] in (118, 128, 134, 135, 138, 139):
                info['mvc_evidence'].add('subset_sps')
                info.setdefault('subset_sps', sub)
        elif t == 20:
            info['mvc_evidence'].add('slice_extension')
        elif t == 6:
            parse_sei(unescape(nal[1:]), info)
    except (ValueError, IndexError):
        pass


def scan_annexb(buf, info):
    starts = [m.end() for m in START.finditer(buf)]
    for i, s in enumerate(starts):
        e = starts[i + 1] - 3 if i + 1 < len(starts) else len(buf)
        analyze_nal(buf[s:e], info)


def scan_length_prefixed(buf, size_len, info):
    i = 0
    while i + size_len <= len(buf):
        n = int.from_bytes(buf[i:i + size_len], 'big')
        i += size_len
        if n == 0 or n > len(buf) - i:
            break
        analyze_nal(buf[i:i + n], info)
        i += n


def finish_h264(info):
    out = {k: v for k, v in info.items() if k not in ('nal_types', 'mvc_evidence')}
    out['mvc_evidence'] = sorted(info['mvc_evidence'])
    return out


# --------------------------------------------------------------------------- MPEG-TS

def ts_packet_size(buf):
    for size, off in ((188, 0), (192, 4), (204, 0)):
        if len(buf) >= off + size * 4 and all(buf[off + k * size] == 0x47 for k in range(4)):
            return size, off
    # tolerate a leading partial packet
    for size, off in ((188, 0), (192, 4), (204, 0)):
        for skip in range(size):
            if len(buf) > skip + off + size * 4 and all(
                    buf[skip + off + k * size] == 0x47 for k in range(4)):
                return size, off + skip
    return None


def scan_ts(buf, res):
    ps = ts_packet_size(buf)
    if not ps:
        return False
    size, off = ps
    res['container'] = 'mpegts' if size == 188 else f'mpegts-{size}'
    pmt_pids, streams, pes = set(), {}, {}
    sections = {}

    def section(pid, p, a):
        if p[1] & 0x40:
            ptr = p[a]
            sections[pid] = bytearray(p[a + 1 + ptr:])
        elif pid in sections:
            sections[pid] += p[a:]
        else:
            return None
        s = sections[pid]
        if len(s) >= 3:
            ln = ((s[1] & 0xf) << 8) | s[2]
            if len(s) >= 3 + ln:
                del sections[pid]
                return bytes(s[:3 + ln])
        return None

    for i in range(off, len(buf) - 187, size):
        p = buf[i:i + 188]
        if p[0] != 0x47:
            continue
        pid = ((p[1] & 0x1f) << 8) | p[2]
        afc = (p[3] >> 4) & 3
        a = 4
        if afc & 2:
            a += 1 + p[4]
        if not afc & 1 or a >= 188:
            continue
        if pid == 0:
            s = section(pid, p, a)
            if s and s[0] == 0:
                for j in range(8, len(s) - 4, 4):
                    prog = (s[j] << 8) | s[j + 1]
                    if prog:
                        pmt_pids.add(((s[j + 2] & 0x1f) << 8) | s[j + 3])
        elif pid in pmt_pids:
            s = section(pid, p, a)
            if s and s[0] == 2:
                pil = ((s[10] & 0xf) << 8) | s[11]
                j = 12 + pil
                while j + 5 <= len(s) - 4:
                    st = s[j]
                    epid = ((s[j + 1] & 0x1f) << 8) | s[j + 2]
                    el = ((s[j + 3] & 0xf) << 8) | s[j + 4]
                    desc = s[j + 5:j + 5 + el]
                    reg = None
                    k = 0
                    while k + 2 <= len(desc):
                        if desc[k] == 5 and desc[k + 1] >= 4:
                            reg = desc[k + 2:k + 6].decode('ascii', 'replace')
                        k += 2 + desc[k + 1]
                    streams.setdefault(epid, {'pid': f'0x{epid:04x}', 'stream_type': f'0x{st:02x}',
                                              'registration': reg})
                    if st in (0x1b, 0x20) and epid not in pes:
                        pes[epid] = bytearray()
                    j += 5 + el
        elif pid in pes and len(pes[pid]) < PID_BUDGET:
            d = p[a:]
            if p[1] & 0x40 and d[:3] == b'\x00\x00\x01' and len(d) > 9:
                d = d[9 + d[8]:]
            pes[pid] += d

    res['ts_streams'] = list(streams.values())
    videos = []
    for pid, data in pes.items():
        info = new_h264_info()
        scan_annexb(bytes(data), info)
        v = finish_h264(info)
        v['pid'] = f'0x{pid:04x}'
        v['stream_type'] = streams[pid]['stream_type']
        if streams[pid]['stream_type'] == '0x20':
            v['mvc_evidence'] = sorted(set(v['mvc_evidence']) | {'ts_stream_type_0x20'})
        videos.append(v)
    res['h264'] = videos
    return True


# --------------------------------------------------------------------------- MP4 / MOV

CONTAINER_BOXES = {b'moov', b'trak', b'mdia', b'minf', b'stbl', b'edts', b'udta', b'sv3d', b'vexu'}
VISUAL_ENTRIES = {b'avc1', b'avc2', b'avc3', b'avc4', b'mvc1', b'mvc2', b'mvc3', b'mvc4',
                  b'hvc1', b'hev1', b'dvh1', b'dvhe', b'encv'}


def walk_boxes(f, start, end, found, depth=0):
    pos = start
    while pos + 8 <= end and depth < 12:
        f.seek(pos)
        hdr = f.read(16)
        if len(hdr) < 8:
            return
        size, typ = struct.unpack('>I4s', hdr[:8])
        hl = 8
        if size == 1:
            size = struct.unpack('>Q', hdr[8:16])[0]
            hl = 16
        elif size == 0:
            size = end - pos
        if size < hl:
            return
        found.setdefault('boxes', set()).add(typ.decode('latin-1'))
        if typ == b'hdlr' and size < 512:
            f.seek(pos + hl + 24)
            name = f.read(size - hl - 24).strip(b'\x00').decode('latin-1', 'replace').strip()
            if name:
                found.setdefault('handler_names', set()).add(name)
        elif typ in CONTAINER_BOXES:
            walk_boxes(f, pos + hl, pos + size, found, depth + 1)
        elif typ == b'stsd':
            walk_boxes(f, pos + hl + 8, pos + size, found, depth + 1)
        elif typ in VISUAL_ENTRIES:
            found.setdefault('sample_entries', set()).add(typ.decode('latin-1'))
            f.seek(pos + hl + 24)
            wh = f.read(4)
            if len(wh) == 4:
                found.setdefault('dimensions', set()).add('%dx%d' % struct.unpack('>HH', wh))
            walk_boxes(f, pos + hl + 78, pos + size, found, depth + 1)
        elif typ == b'avcC' and size < 1 << 16:
            f.seek(pos + hl)
            c = f.read(size - hl)
            if len(c) > 6:
                found['nal_length_size'] = (c[4] & 3) + 1
                nsps = c[5] & 0x1f
                if nsps and len(c) > 8:
                    ln = struct.unpack('>H', c[6:8])[0]
                    try:
                        found['sps'] = parse_sps(unescape(c[9:8 + ln]))
                    except (ValueError, IndexError):
                        pass
        elif typ == b'mdat' and 'mdat_head' not in found:
            found['mdat_head'] = (pos + hl, min(size - hl, READ_BYTES))
        pos += size


def scan_mp4(path, head, res):
    if head[4:8] not in (b'ftyp', b'moov', b'mdat', b'wide', b'free', b'skip', b'pnot'):
        return False
    res['container'] = 'mp4/mov'
    found = {}
    with open(path, 'rb') as f:
        walk_boxes(f, 0, os.fstat(f.fileno()).st_size, found)
        boxes = found.get('boxes', set())
        entries = found.get('sample_entries', set())
        mp4 = {'sample_entries': sorted(entries), 'dimensions': sorted(found.get('dimensions', ()))}
        ev = set()
        if 'mvcC' in boxes:
            ev.add('mvcC_box')
        if entries & {'mvc1', 'mvc2', 'mvc3', 'mvc4'}:
            ev.add('mvc_sample_entry')
        if 'lhvC' in boxes:
            mp4['mv_hevc'] = True
        if 'vexu' in boxes or 'st3d' in boxes:
            mp4['stereo_boxes'] = sorted(boxes & {'vexu', 'st3d', 'sv3d', 'eyes', 'stri', 'hero'})
        if 'sps' in found:
            mp4['sps'] = found['sps']
        if found.get('handler_names'):
            mp4['handler_names'] = sorted(found['handler_names'])
            for n in mp4['handler_names']:
                for make in MDPM_MAKES.values():
                    if n.upper().startswith(make.upper()):
                        mp4['camera'] = {'make': make, 'source': 'mp4 handler name'}
        # MVC may also be carried in band in an avc1 track
        if entries & {'avc1', 'avc3'} and 'mdat_head' in found and 'nal_length_size' in found:
            f.seek(found['mdat_head'][0])
            info = new_h264_info()
            scan_length_prefixed(f.read(found['mdat_head'][1]), found['nal_length_size'], info)
            h = finish_h264(info)
            ev |= set(h.pop('mvc_evidence'))
            for k in ('camera', 'frame_packing', 'subset_sps'):
                if k in h:
                    mp4[k] = h[k]
        mp4['mvc_evidence'] = sorted(ev)
    res['mp4'] = mp4
    return True


# --------------------------------------------------------------------------- Matroska

def ebml_vint(b, i, strip=True):
    if i >= len(b) or b[i] == 0:
        raise ValueError
    n = 8 - b[i].bit_length() + 1
    v = b[i] & ((1 << (8 - n)) - 1) if strip else b[i]
    for k in range(1, n):
        v = (v << 8) | b[i + k]
    return v, i + n


def ebml_elements(b, i, end):
    while i < end:
        try:
            eid, j = ebml_vint(b, i, strip=False)
            size, k = ebml_vint(b, j)
        except (ValueError, IndexError):
            return
        yield eid, k, min(k + size, end)
        if k + size > end + (1 << 40):
            return
        i = k + size


def scan_mkv(buf, res):
    if buf[:4] != b'\x1a\x45\xdf\xa3':
        return False
    res['container'] = 'matroska'
    tracks = []
    for eid, s, e in ebml_elements(buf, 0, len(buf)):
        if eid != 0x18538067:           # Segment
            continue
        for cid, cs, ce in ebml_elements(buf, s, e):
            if cid != 0x1654AE6B:       # Tracks
                continue
            for tid, ts, te in ebml_elements(buf, cs, ce):
                if tid != 0xAE:
                    continue
                t = {}
                for fid, fs, fe in ebml_elements(buf, ts, te):
                    if fid == 0x86:
                        t['codec'] = buf[fs:fe].decode('ascii', 'replace')
                    elif fid == 0x53B8:
                        t['stereo_mode'] = MKV_STEREO.get(int.from_bytes(buf[fs:fe], 'big'),
                                                          str(int.from_bytes(buf[fs:fe], 'big')))
                    elif fid == 0xE0:     # Video
                        for vid, vs, ve in ebml_elements(buf, fs, fe):
                            if vid == 0x53B8:
                                v = int.from_bytes(buf[vs:ve], 'big')
                                t['stereo_mode'] = MKV_STEREO.get(v, str(v))
                            elif vid == 0xB0:
                                t['width'] = int.from_bytes(buf[vs:ve], 'big')
                            elif vid == 0xBA:
                                t['height'] = int.from_bytes(buf[vs:ve], 'big')
                    elif fid == 0x41E4:   # BlockAdditionMapping
                        for bid, bs, be in ebml_elements(buf, fs, fe):
                            if bid == 0x41E7:
                                t.setdefault('block_additions', []).append(
                                    buf[bs:be].rjust(4, b'\0').decode('latin-1'))
                    elif fid == 0x63A2 and b'mvcC' in buf[fs:fe]:
                        t['mvcC_in_codec_private'] = True
                ev = []
                if 'MVC' in t.get('codec', ''):
                    ev.append('mvc_codec_id')
                if 'mvcC' in t.get('block_additions', []) or t.get('mvcC_in_codec_private'):
                    ev.append('mvcC')
                t['mvc_evidence'] = ev
                tracks.append(t)
            break
        break
    res['mkv_tracks'] = tracks
    return True


# --------------------------------------------------------------------------- driver

def scan_file(path, st):
    res = {'path': path, 'size': st.st_size, 'mtime': int(st.st_mtime)}
    try:
        with open(path, 'rb') as f:
            head = f.read(READ_BYTES)
        res['head_sha1'] = hashlib.sha1(head[:1 << 20]).hexdigest()
        if not (scan_ts(head, res) or scan_mkv(head, res) or scan_mp4(path, head, res)):
            if head[:3] == b'\x00\x00\x01' or head[:4] == b'\x00\x00\x00\x01':
                res['container'] = 'h264-annexb'
                info = new_h264_info()
                scan_annexb(head, info)
                h = finish_h264(info)
                if h.get('sps', {}).get('profile') in (66, 77, 88, 100, 110, 122, 244, 44) and h['sps']['width'] >= 128:
                    res['h264'] = [h]
                else:
                    res['container'] = 'unknown'
            else:
                res['container'] = 'unknown'
    except OSError as e:
        res['error'] = str(e)
    summarize(res)
    return res


STRONG_MVC = {'ts_stream_type_0x20', 'mvcC_box', 'mvc_sample_entry', 'mvc_codec_id', 'mvcC'}


def summarize(res):
    ev, fp, cam, video = set(), None, None, None
    for v in res.get('h264', []):
        ev |= set(v.get('mvc_evidence', ()))
        fp = fp or v.get('frame_packing')
        cam = cam or v.get('camera')
        if 'sps' in v and not video:
            s = v['sps']
            video = f"{s['width']}x{s['height']}{'i' if s['interlaced'] else 'p'} h264 profile {s['profile']}"
    if 'mp4' in res:
        m = res['mp4']
        ev |= set(m.get('mvc_evidence', ()))
        fp = fp or m.get('frame_packing') or ('vexu/st3d' if m.get('stereo_boxes') else None)
        cam = cam or m.get('camera')
        if m.get('mv_hevc'):
            res['mv_hevc'] = True
        if m.get('sps') and not video:
            s = m['sps']
            video = f"{s['width']}x{s['height']}{'i' if s['interlaced'] else 'p'} h264 profile {s['profile']}"
    for t in res.get('mkv_tracks', []):
        ev |= set(t.get('mvc_evidence', ()))
        fp = fp or t.get('stereo_mode')
    res['mvc'] = bool(ev & STRONG_MVC or {'subset_sps', 'slice_extension'} <= ev)
    if ev:
        res['mvc_evidence'] = sorted(ev)
    if fp:
        res['frame_packing'] = fp
    if cam:
        res['camera'] = cam
    if video:
        res['video'] = video
    res['stereo3d'] = bool(res['mvc'] or fp or res.get('mv_hevc'))


def walk(roots, exts, excludes, all_files):
    stack = list(roots)
    while stack:
        d = stack.pop()
        try:
            with os.scandir(d) as it:
                entries = list(it)
        except OSError as e:
            print(f'warning: {d}: {e}', file=sys.stderr)
            continue
        for e in entries:
            try:
                if e.is_dir(follow_symlinks=False):
                    if e.name not in excludes:
                        stack.append(e.path)
                elif e.is_file(follow_symlinks=False):
                    ext = e.name.rsplit('.', 1)[-1].lower() if '.' in e.name else ''
                    if all_files or ext in exts:
                        yield e.path, e.stat(follow_symlinks=False)
            except OSError:
                continue


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('roots', nargs='+', help='files or directories to scan')
    ap.add_argument('-o', '--output', default='mvcscan.jsonl',
                    help='JSONL results file; existing entries are reused (default: %(default)s)')
    ap.add_argument('-j', '--jobs', type=int, default=4, help='parallel readers (default: %(default)s)')
    ap.add_argument('--exclude', action='append', default=[],
                    help='directory name to skip (repeatable); defaults: ' + ', '.join(DEFAULT_EXCLUDES))
    ap.add_argument('--no-default-excludes', action='store_true')
    ap.add_argument('--ext', action='append', default=[], help='extra file extension to consider')
    ap.add_argument('--all-files', action='store_true', help='sniff every file regardless of extension')
    ap.add_argument('--min-size', type=int, default=1 << 20, help='skip smaller files (bytes, default 1 MiB)')
    ap.add_argument('--rescan', action='store_true', help='ignore previous results')
    args = ap.parse_args()

    excludes = set(args.exclude) | (set() if args.no_default_excludes else set(DEFAULT_EXCLUDES))
    exts = set(DEFAULT_EXTS) | {e.lower().lstrip('.') for e in args.ext}

    done = {}
    if os.path.exists(args.output) and not args.rescan:
        with open(args.output) as f:
            for line in f:
                try:
                    r = json.loads(line)
                    done[r['path']] = (r['size'], r['mtime'])
                except (ValueError, KeyError):
                    pass

    def files():
        for root in args.roots:
            if os.path.isfile(root):
                yield os.path.abspath(root), os.stat(root)
            else:
                yield from walk([os.path.abspath(root)], exts, excludes, args.all_files)

    lock = threading.Lock()
    stats = {'seen': 0, 'scanned': 0, 'skipped': 0, 'stereo': 0}
    t0 = time.time()
    out = open(args.output, 'a')

    def work(item):
        path, st = item
        res = scan_file(path, st)
        line = json.dumps(res, default=lambda o: sorted(o) if isinstance(o, set) else str(o))
        with lock:
            out.write(line + '\n')
            out.flush()
            stats['scanned'] += 1
            if res['stereo3d']:
                stats['stereo'] += 1
                cam = res.get('camera', {})
                what = 'MVC' if res['mvc'] else ('MV-HEVC' if res.get('mv_hevc') else res.get('frame_packing'))
                print(f"3D [{what}] {cam.get('make', '?')} {cam.get('model', '')} "
                      f"{cam.get('recorded', '')}  {path}", flush=True)

    with ThreadPoolExecutor(args.jobs) as pool:
        pending = set()
        for path, st in files():
            stats['seen'] += 1
            if st.st_size < args.min_size or done.get(path) == (st.st_size, int(st.st_mtime)):
                stats['skipped'] += 1
                continue
            pending.add(pool.submit(work, (path, st)))
            if len(pending) >= args.jobs * 4:
                finished = {p for p in pending if p.done()}
                for p in finished:
                    p.result()
                pending -= finished
                if not finished:
                    next(iter(pending)).result()
            if stats['seen'] % 500 == 0:
                print(f"... {stats['seen']} candidates, {stats['scanned']} scanned, "
                      f"{stats['stereo']} 3D, {time.time() - t0:.0f}s", file=sys.stderr, flush=True)
        for p in pending:
            p.result()
    out.close()
    print(f"done: {stats['seen']} candidates, {stats['scanned']} scanned, {stats['skipped']} skipped "
          f"(small or unchanged), {stats['stereo']} 3D, {time.time() - t0:.0f}s", file=sys.stderr)


if __name__ == '__main__':
    main()
