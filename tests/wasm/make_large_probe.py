"""Generate a valid 500 MiB (or --mib 1024) log with bounded memory."""
import argparse
import hashlib
import struct
import zlib
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('path', type=Path)
parser.add_argument('--mib', type=int, default=500, choices=range(1, 1025))
args = parser.parse_args()
path = args.path
size = args.mib * 1024 * 1024
records = args.mib
head = bytes(32)
with path.open('wb') as out:
    out.write(b'FLTSEAL1')
    remaining = size - 8
    for seq in range(records):
        length = min(1024 * 1024, remaining - (records - seq) * 56)
        payload = b'x' * length
        header = struct.pack('<IQQ', length, seq, seq * 1000)
        head = hashlib.sha256(head + struct.pack('<QQI', seq, seq * 1000, length) + payload).digest()
        record = header + payload + head
        out.write(record)
        out.write(struct.pack('<I', zlib.crc32(record)))
        remaining -= len(record) + 4
assert path.stat().st_size == size
print(path, size, f'{records} records', head.hex())
