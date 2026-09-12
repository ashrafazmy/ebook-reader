"""Generate the project's simple book mark as PNGs without imaging dependencies."""
import struct
import zlib
from pathlib import Path


def png(size: int) -> bytes:
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            u, v = x / size, y / size
            color = (39, 60, 54)
            if .23 < u < .77 and .29 < v < .72:
                color = (245, 242, 235)
                if abs(u - .5) < .012 or any(abs(v - line) < .008 and (.27 < u < .45 or .55 < u < .73) for line in [.39, .47, .55, .63]):
                    color = (66, 116, 83)
            rows.extend(color)
    def chunk(kind: bytes, data: bytes) -> bytes:
        return struct.pack('!I', len(data)) + kind + data + struct.pack('!I', zlib.crc32(kind + data))
    return b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('!IIBBBBB', size, size, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')


for name, size in [('icon-192.png', 192), ('icon-512.png', 512), ('apple-touch-icon.png', 180)]:
    (Path(__file__).resolve().parents[1] / 'public' / name).write_bytes(png(size))
