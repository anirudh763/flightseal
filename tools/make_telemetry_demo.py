"""Build the synthetic ULog fixture used by the local import/map/telemetry demo."""
import hashlib
import math
from pathlib import Path
import struct


def message(kind, data):
    return struct.pack('<HB', len(data), ord(kind)) + data


root = Path(__file__).resolve().parents[1] / 'docs/samples'
parts = [b'ULog\x01\x12\x35' + bytes([1]) + struct.pack('<Q', 1000000),
         message('B', bytes(40)),
         message('F', b'vehicle_global_position:uint64_t timestamp;double lat;double lon;float alt;float vel_n;float vel_e;'),
         message('F', b'battery_status:uint64_t timestamp;float voltage_v;'),
         message('A', bytes([0]) + struct.pack('<H', 0) + b'vehicle_global_position'),
         message('A', bytes([0]) + struct.pack('<H', 1) + b'battery_status')]
for i in range(128):
    timestamp = 1000000 + i * 100000
    angle = i * math.pi * 2 / 127
    parts.append(message('D', struct.pack('<HQddfff', 0, timestamp,
        33.21 + math.sin(angle) * .001, -97.13 + math.cos(angle) * .001,
        220 + math.sin(angle) * 18, 6 + math.cos(angle) * 2, math.sin(angle))))
    parts.append(message('D', struct.pack('<HQf', 1, timestamp, 16.8 - i * .008)))
data = b''.join(parts)
(root / 'telemetry-demo.ulg').write_bytes(data)
(root / 'telemetry-demo.md').write_text(
    '# Synthetic ULog telemetry fixture\n\n'
    'Generated with `python3 tools/make_telemetry_demo.py` from published ULog framing '
    'and supported topic-field conventions. This is a synthetic circular track, not '
    'a recorded flight or proof of sensor truth. It contains 128 global-position '
    'samples and 128 battery samples; timestamps are microseconds from an arbitrary '
    'boot clock. Latitude/longitude use degrees, altitude metres, north/east velocity '
    'metres/second, voltage volts. The native importer reads these bytes and produces '
    'ordinary FLTSEAL1 records and signed receipts.\n\n'
    f'SHA-256: `{hashlib.sha256(data).hexdigest()}`\n')
print(f'Synthetic telemetry fixture: {len(data)} bytes')
