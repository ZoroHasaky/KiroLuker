#!/usr/bin/env python3
"""把满幅的 mac 图标缩放并居中到带透明留白的画布，符合 macOS 图标规范。

macOS 的应用图标约定：1024x1024 画布里图形本体只占约 824x824，四周留透明边距。
满幅铺开的图标在 Dock 里会明显比系统与其它规范图标更大。

用法：python3 scripts/pad-mac-icon.py 输入.png 输出.png [画布边长] [内容边长]
只依赖标准库，不引入图像处理依赖。
"""
import sys
import zlib
import struct
import pathlib


def read_rgba(path):
    data = pathlib.Path(path).read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "不是 PNG 文件"
    pos, idat, meta = 8, b"", None
    while pos < len(data):
        length, ctype = struct.unpack(">I4s", data[pos : pos + 8])
        chunk = data[pos + 8 : pos + 8 + length]
        if ctype == b"IHDR":
            meta = struct.unpack(">IIBBBBB", chunk)
        elif ctype == b"IDAT":
            idat += chunk
        pos += 12 + length
    w, h, depth, color = meta[0], meta[1], meta[2], meta[3]
    assert depth == 8 and color == 6, f"只支持 8 位 RGBA，当前 depth={depth} color={color}"

    raw = zlib.decompress(idat)
    stride = w * 4
    prev = bytearray(stride)
    rows = []
    p = 0
    for _ in range(h):
        f = raw[p]
        p += 1
        line = bytearray(raw[p : p + stride])
        p += stride
        if f == 1:
            for i in range(4, stride):
                line[i] = (line[i] + line[i - 4]) & 255
        elif f == 2:
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 255
        elif f == 3:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255
        elif f == 4:
            for i in range(stride):
                a = line[i - 4] if i >= 4 else 0
                b = prev[i]
                c = prev[i - 4] if i >= 4 else 0
                pp = a + b - c
                pa, pb, pc = abs(pp - a), abs(pp - b), abs(pp - c)
                pr = a if (pa <= pb and pa <= pc) else (b if pb <= pc else c)
                line[i] = (line[i] + pr) & 255
        rows.append(bytes(line))
        prev = line
    return w, h, rows


def resize_box(w, h, rows, size):
    """区域平均缩放：缩小场景下比双线性更干净，且对 alpha 做预乘避免边缘发灰。"""
    out = []
    for oy in range(size):
        y0, y1 = oy * h // size, max(oy * h // size + 1, (oy + 1) * h // size)
        line = bytearray(size * 4)
        for ox in range(size):
            x0, x1 = ox * w // size, max(ox * w // size + 1, (ox + 1) * w // size)
            ar = ag = ab = aa = n = 0
            for y in range(y0, y1):
                row = rows[y]
                for x in range(x0, x1):
                    i = x * 4
                    a = row[i + 3]
                    ar += row[i] * a
                    ag += row[i + 1] * a
                    ab += row[i + 2] * a
                    aa += a
                    n += 1
            o = ox * 4
            if aa:
                line[o] = min(255, ar // aa)
                line[o + 1] = min(255, ag // aa)
                line[o + 2] = min(255, ab // aa)
                line[o + 3] = aa // n
        out.append(bytes(line))
    return out


def write_rgba(path, size, rows):
    raw = bytearray()
    for row in rows:
        raw.append(0)  # filter type: none
        raw += row
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)

    def chunk(ctype, payload):
        return (
            struct.pack(">I", len(payload))
            + ctype
            + payload
            + struct.pack(">I", zlib.crc32(ctype + payload) & 0xFFFFFFFF)
        )

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", ihdr)
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")
    pathlib.Path(path).write_bytes(png)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    canvas = int(sys.argv[3]) if len(sys.argv) > 3 else 1024
    content = int(sys.argv[4]) if len(sys.argv) > 4 else 824

    w, h, rows = read_rgba(src)
    scaled = resize_box(w, h, rows, content)

    offset = (canvas - content) // 2
    blank = bytes(canvas * 4)
    out = [blank] * canvas
    for i, row in enumerate(scaled):
        line = bytearray(blank)
        line[offset * 4 : offset * 4 + len(row)] = row
        out[offset + i] = bytes(line)

    write_rgba(dst, canvas, out)
    print(f"{dst}: {canvas}x{canvas}，内容 {content}x{content}（占比 {content / canvas:.1%}）")


if __name__ == "__main__":
    main()
