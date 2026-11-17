"""Re-apply withdrawals and deletions after a backup restore.

A point-in-time or on-demand restore brings back shares and registrations that were withdrawn or deleted after the
backup was taken. Tombstones (TOMB# items, never TTL'd) record every withdrawal and deletion. `apply_tombstones`
copies each one from the source (the table the backup came from, still readable) into the restored target and
applies it, then writes the SYSTEM/RESTORE marker last. The app refuses every route while RESTORED_FROM is set and
the marker is missing.

  python -m registry.restore --source LIVE_TABLE --target RESTORED_TABLE
"""
import argparse
import time


def apply_tombstones(source, target, source_name="source", clock=time.time):
    tombs = source.scan("TOMB#")  # raises if unreadable: no marker is written, the app stays closed
    now = int(clock())
    for t in tombs:
        target.put(t)
        if t["kind"] == "registration":
            key = (f"ORG#{t['org']}", "REG#" + t["ref"])
            if target.get(*key) is not None:
                target.update(*key, set={"state": "deleted", "deleted_at": t["at"]}, remove=["received_at"])
        elif t["kind"] == "share":
            key = ("SHARE#" + t["ref"], "SHARE")
            if target.get(*key) is not None:
                target.update(*key, set={"state": "withdrawn", "withdrawn_at": t["at"]})
        elif t["kind"] == "key":
            pk = f"ORG#{t['org']}"
            if target.get(pk, "KEY#" + t["ref"]) is not None:
                target.update(pk, "KEY#" + t["ref"], set={"state": "compromised", "changed_at": t["at"]})
            else:  # enrolled after the backup: keep it compromised so it cannot be re-enrolled
                target.put({"PK": pk, "SK": "KEY#" + t["ref"], "state": "compromised", "enrolled_at": t["at"],
                            "enrolled_by": "restore", "changed_at": t["at"]})
            if (target.get(pk, "ACTIVE_KEY") or {}).get("fp") == t["ref"]:
                target.delete(pk, "ACTIVE_KEY")
        elif t["kind"] == "epoch":
            pk = f"ORG#{t['org']}"
            cur = (target.get(pk, "EPOCH") or {}).get("epoch", 0)
            target.put({"PK": pk, "SK": "EPOCH", "epoch": max(cur, t["value"])})
    target.put({"PK": "SYSTEM", "SK": "RESTORE", "source": source_name, "applied_at": now, "tombstones": len(tombs)})
    return len(tombs)


def main(argv=None):
    from .store import DynamoTable

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--source", required=True, help="table to read tombstones from")
    p.add_argument("--target", required=True, help="restored table to apply them to")
    a = p.parse_args(argv)
    n = apply_tombstones(DynamoTable(a.source), DynamoTable(a.target), source_name=a.source)
    print(f"applied {n} tombstones; set RESTORED_FROM={a.source} on the function that serves {a.target}")


if __name__ == "__main__":
    main()
