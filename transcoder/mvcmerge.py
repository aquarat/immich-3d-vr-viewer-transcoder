#!/usr/bin/env python3
"""Merge the base (0x1011) and dependent (0x1012) MVC views of an AVCHD/Blu-ray
M2TS file into a single Annex B H.264 MVC elementary stream.

The patched FFmpeg in ../ffmpeg pairs the two PIDs itself, so mvc2sbs.py does
not need this. It is kept for feeding standalone MVC decoders that want a single
Annex B stream, such as edge264.

Each PES carries one frame; for field-coded streams that is two access units,
delimited by an AUD (type 9) in the base view and an MVC delimiter (type 24) in
the dependent view. Access units are emitted as base view component followed by
the dependent view component, with the (non-standard) type 24 NALs dropped.
"""
import argparse
import re
import sys

START = re.compile(b'\x00\x00\x01')


def pes_payloads(path, pid_want):
    """Yield (pts, payload) for each PES on pid_want. Handles 188/192-byte packets."""
    with open(path, 'rb') as f:
        head = f.read(400)
        off = 4 if head[4] == 0x47 and head[196] == 0x47 else 0
        size = 188 + off
        f.seek(0)
        pes, pts = None, None
        while True:
            pkt = f.read(size)
            if len(pkt) < size:
                break
            p = pkt[off:]
            if p[0] != 0x47:
                continue
            pid = ((p[1] & 0x1f) << 8) | p[2]
            if pid != pid_want or not p[3] & 0x10:
                continue
            a = 4 + (1 + p[4] if p[3] & 0x20 else 0)
            if p[1] & 0x40:
                if pes:
                    yield pts, bytes(pes)
                d = p[a:]
                hl = d[8]
                pts = None
                if d[7] & 0x80:
                    pts = (((d[9] & 0x0e) << 29) | (d[10] << 22) | ((d[11] & 0xfe) << 14)
                           | (d[12] << 7) | (d[13] >> 1))
                pes = bytearray(d[9 + hl:])
            elif pes is not None:
                pes += p[a:]
        if pes:
            yield pts, bytes(pes)


def split_nals(buf):
    starts = [m.end() for m in START.finditer(buf)]
    out = []
    for i, s in enumerate(starts):
        e = starts[i + 1] - 3 if i + 1 < len(starts) else len(buf)
        nal = buf[s:e].rstrip(b'\x00')  # trailing zeros belong to the next start code
        if nal:
            out.append(nal)
    return out


def split_units(nals, delim):
    """Group NALs into access units / view components starting at a delimiter type."""
    units = []
    for n in nals:
        if (n[0] & 0x1f) == delim or not units:
            units.append([])
        units[-1].append(n)
    return units


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('input')
    ap.add_argument('output')
    ap.add_argument('--base-pid', type=lambda x: int(x, 0), default=0x1011)
    ap.add_argument('--dep-pid', type=lambda x: int(x, 0), default=0x1012)
    ap.add_argument('--base-only', action='store_true', help='write only the base view')
    args = ap.parse_args()

    base = pes_payloads(args.input, args.base_pid)
    dep = pes_payloads(args.input, args.dep_pid)
    n_frames = n_aus = 0
    with open(args.output, 'wb') as out:
        for (bpts, bpay), (dpts, dpay) in zip(base, dep):
            if bpts != dpts:
                sys.exit(f'PTS mismatch at frame {n_frames}: base {bpts} dep {dpts}')
            baus = split_units(split_nals(bpay), 9)
            daus = split_units(split_nals(dpay), 24)
            if len(baus) != len(daus):
                sys.exit(f'frame {n_frames}: {len(baus)} base AUs vs {len(daus)} dependent')
            for bau, dau in zip(baus, daus):
                for n in bau:
                    out.write(b'\x00\x00\x00\x01' + n)
                if not args.base_only:
                    for n in dau:
                        if (n[0] & 0x1f) != 24:
                            out.write(b'\x00\x00\x01' + n)
                n_aus += 1
            n_frames += 1
    print(f'{n_frames} frames, {n_aus} access units', file=sys.stderr)


if __name__ == '__main__':
    main()
