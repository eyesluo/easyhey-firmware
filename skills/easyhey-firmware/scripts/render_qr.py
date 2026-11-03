"""Render an API login QR locally; never send its content to an external QR service.

Usage: python render_qr.py --output /absolute/temp/login.png
Supply qrCodeContent on stdin. Requires reportlab (bundled desktop Python has it).
"""
import argparse
import json
import struct
import sys
import zlib
from pathlib import Path


def render(content, target):
    from reportlab.graphics.barcode.qrencoder import QRCode, QRErrorCorrectLevel

    qr = QRCode(None, QRErrorCorrectLevel.M)
    qr.addData(content)
    qr.make()
    scale, border = 8, 4
    count = qr.getModuleCount()
    width = (count + 2 * border) * scale
    rows = bytearray()
    for y in range(count + 2 * border):
        row = bytearray()
        for x in range(count + 2 * border):
            dark = border <= x < count + border and border <= y < count + border and qr.isDark(y - border, x - border)
            row.extend(bytes([0 if dark else 255]) * scale)
        for _ in range(scale):
            rows.extend(b'\0' + row)

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', width, width, 8, 0, 0, 0, 0))
    png += chunk(b'IDAT', zlib.compress(rows)) + chunk(b'IEND', b'')
    target = Path(target)
    target.parent.mkdir(parents=True, exist_ok=True)
    # The caller supplies a unique path. Exclusive creation avoids overwriting
    # an older login image and works where Windows denies temporary-file rename.
    # The caller only displays the PNG after this process closes and validates it.
    with target.open('xb') as stream:
        stream.write(png)
    return {'path': str(target.resolve()), 'width': width, 'height': width, 'size': len(png)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--output')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    try:
        from reportlab.graphics.barcode.qrencoder import QRCode, QRErrorCorrectLevel
    except ImportError:
        print('QR_DEPENDENCY_MISSING', file=sys.stderr)
        sys.exit(2)
    if args.check:
        print(json.dumps({'ready': True}))
        sys.exit(0)
    content = sys.stdin.read(8193).strip()
    if not content or len(content) > 8192 or not args.output or not Path(args.output).is_absolute():
        print('QR_INPUT_INVALID', file=sys.stderr)
        sys.exit(2)
    try:
        result = render(content, args.output)
    except OSError:
        print('QR_WRITE_FAILED', file=sys.stderr)
        sys.exit(3)
    except Exception:
        # Do not expose QR contents through provider tracebacks.
        print('QR_ENCODING_FAILED', file=sys.stderr)
        sys.exit(4)
    print(json.dumps(result, ensure_ascii=True))
