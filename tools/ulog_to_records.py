"""Turns a PX4 ULog flight log into FlightSeal input: one line per logged sample,
timestamp_us<TAB>{"topic": ..., field: value, ...}, oldest first.

  python tools/ulog_to_records.py flight.ulg | fseal append flight.fseal --key k.pem --receipts flight.receipts
"""
import json
import sys

from pyulog import ULog


def convert(path):
    rows = []
    for d in ULog(str(path)).data_list:
        names = [n for n in d.data if n != "timestamp"]
        columns = [d.data[n] for n in names]
        for i, ts in enumerate(d.data["timestamp"]):
            sample = {"topic": d.name, "instance": d.multi_id}
            sample.update({n: c[i].item() for n, c in zip(names, columns)})
            rows.append((int(ts), json.dumps(sample, separators=(",", ":"))))
    rows.sort(key=lambda row: row[0])  # stable: samples with the same timestamp keep their order
    for ts, payload in rows:
        yield f"{ts}\t{payload}"


if __name__ == "__main__":
    for line in convert(sys.argv[1]):
        print(line)
