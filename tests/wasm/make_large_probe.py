"""Generate a valid 500 MiB log without allocating the file in memory."""
import hashlib
import struct
import sys
import zlib
from pathlib import Path

path = Path(sys.argv[1])
size = 500 * 1024 * 1024
head = bytes(32)
with path.open('wb') as out:
    out.write(b'FLTSEAL1')
    remaining = size - 8
    for seq in range(500):
        length = min(1024 * 1024, remaining - (500 - seq) * 56)
        payload = b'x' * length
        header = struct.pack('<IQQ', length, seq, seq * 1000)
        head = hashlib.sha256(head + struct.pack('<QQI', seq, seq * 1000, length) + payload).digest()
        record = header + payload + head
        out.write(record)
        out.write(struct.pack('<I', zlib.crc32(record)))
        remaining -= len(record) + 4
assert path.stat().st_size == size
print(path, size, '500 records', head.hex())
