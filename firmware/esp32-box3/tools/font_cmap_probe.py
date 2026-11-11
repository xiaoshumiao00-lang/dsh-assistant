#!/usr/bin/env python3
"""Minimal TrueType cmap probe: which code points does a font actually cover?

Usage: python tools/font_cmap_probe.py <font> <text-or-hex-list>

Only formats 4 (BMP) and 12 (UCS-4) are supported, which is what simhei/msyh use.
"""
import struct
import sys


def load_table(font_path, tag):
    with open(font_path, 'rb') as fh:
        data = fh.read()
    num_tables = struct.unpack('>H', data[4:6])[0]
    for i in range(num_tables):
        off = 12 + i * 16
        t = data[off:off + 4]
        if t == tag:
            offset, length = struct.unpack('>II', data[off + 8:off + 16])
            return data[offset:offset + length]
    raise SystemExit('no %s table' % tag)


def cmap_set(font_path):
    cmap = load_table(font_path, b'cmap')
    num = struct.unpack('>H', cmap[2:4])[0]
    best = None
    for i in range(num):
        rec = 4 + i * 8
        pid, eid, off = struct.unpack('>HHI', cmap[rec:rec + 8])
        sub = cmap[off:]
        fmt = struct.unpack('>H', sub[0:2])[0]
        if fmt in (4, 12):
            if best is None or fmt == 12:
                best = (fmt, sub)
    if best is None:
        raise SystemExit('no usable cmap subtable')
    fmt, sub = best
    cps = set()
    if fmt == 4:
        segx2 = struct.unpack('>H', sub[6:8])[0]
        seg = segx2 // 2
        ends = struct.unpack('>%dH' % seg, sub[14:14 + segx2])
        starts = struct.unpack('>%dH' % seg, sub[16 + segx2:16 + 2 * segx2])
        deltas = struct.unpack('>%dh' % seg, sub[16 + 2 * segx2:16 + 3 * segx2])
        roff_pos = 16 + 3 * segx2
        roffs = struct.unpack('>%dH' % seg, sub[roff_pos:roff_pos + segx2])
        for idx in range(seg):
            start, end = starts[idx], ends[idx]
            for cp in range(start, end + 1):
                if roffs[idx] == 0:
                    # glyph = (cp + idDelta) & 0xFFFF; the code point is cp itself.
                    cps.add(cp)
                else:
                    addr = roff_pos + idx * 2 + roffs[idx] + (cp - start) * 2
                    gid = struct.unpack('>H', sub[addr:addr + 2])[0]
                    if gid:
                        cps.add(cp)
    else:
        n = struct.unpack('>I', sub[12:16])[0]
        for i in range(n):
            rec = 16 + i * 12
            s, e, gid = struct.unpack('>III', sub[rec:rec + 12])
            cps.update(range(s, e + 1))
    cps.discard(0xFFFF)
    return cps


if __name__ == '__main__':
    path = sys.argv[1]
    text = sys.argv[2]
    cps = cmap_set(path)
    for ch in text:
        print('%s U+%04X %s' % (ch, ord(ch), 'yes' if ord(ch) in cps else 'NO'))
    print('glyph-codepoints:', len(cps))
