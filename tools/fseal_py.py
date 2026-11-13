"""Independent reader for FlightSeal logs.

Written from the format description and sharing no code with the C++ implementation, so the two
can check each other. Also used by the tamper simulator to build attacked copies of a log.
"""
import hashlib
import struct
import zlib
from dataclasses import dataclass, field

MAGIC = b"FLTSEAL1"
HEADER = struct.Struct("<IQQ")  # payload length, sequence number, timestamp_us
TRAILER = 32 + 4  # link, crc32
MAX_PAYLOAD = 1 << 20


def link(prev: bytes, seq: int, timestamp_us: int, payload: bytes) -> bytes:
    return hashlib.sha256(prev + struct.pack("<QQI", seq, timestamp_us, len(payload)) + payload).digest()


@dataclass
class Record:
    seq: int
    timestamp_us: int
    payload: bytes
    link: bytes
    crc: int | None = None  # None: compute a correct checksum when encoding

    def encode(self) -> bytes:
        body = HEADER.pack(len(self.payload), self.seq, self.timestamp_us) + self.payload + self.link
        return body + struct.pack("<I", zlib.crc32(body) if self.crc is None else self.crc)


@dataclass
class Scan:
    records: int = 0
    problem: str | None = None  # same tokens the CLI prints: torn-tail, bad-crc, bad-seq, bad-link, ...
    head: bytes = bytes(32)
    items: list = field(default_factory=list)


def _record_follows(data, start, seq) -> bool:
    """True if a complete record with this sequence number and a valid CRC starts after `start`, within one
    maximum-size record."""
    last = min(len(data), start + HEADER.size + MAX_PAYLOAD + TRAILER)
    for p in range(start + 1, min(last, len(data) - HEADER.size - TRAILER) + 1):
        length, rseq, _ = HEADER.unpack_from(data, p)
        if rseq != seq or length > MAX_PAYLOAD:
            continue
        end = p + HEADER.size + length + TRAILER
        if end <= len(data) and zlib.crc32(data[p : end - 4]) == struct.unpack_from("<I", data, end - 4)[0]:
            return True
    return False


def scan(path) -> Scan:
    data = open(path, "rb").read()
    s = Scan()
    if data[: len(MAGIC)] != MAGIC:
        if data:
            s.problem = "torn-tail" if MAGIC.startswith(data) else "bad-header"
        return s
    off = len(MAGIC)
    while off < len(data):
        if len(data) - off < HEADER.size:
            s.problem = "torn-tail"
            break
        length, seq, ts = HEADER.unpack_from(data, off)
        if length > MAX_PAYLOAD:
            s.problem = "bad-length"
            break
        end = off + HEADER.size + length + TRAILER
        if end > len(data):
            # A crash leaves a torn tail; a corrupted length with intact records after it is corruption.
            s.problem = "bad-length" if _record_follows(data, off, s.records + 1) else "torn-tail"
            break
        (crc,) = struct.unpack_from("<I", data, end - 4)
        if zlib.crc32(data[off : end - 4]) != crc:
            s.problem = "bad-crc"
            break
        if seq != s.records:
            s.problem = "bad-seq"
            break
        payload = data[off + HEADER.size : off + HEADER.size + length]
        stored = data[end - TRAILER : end - 4]
        if link(s.head, seq, ts, payload) != stored:
            s.problem = "bad-link"
            break
        s.items.append(Record(seq, ts, payload, stored, crc))
        s.head = stored
        s.records += 1
        off = end
    return s
