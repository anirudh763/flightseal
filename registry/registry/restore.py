"""Re-apply withdrawals and deletions after a backup restore.

A point-in-time or on-demand restore brings back shares and registrations that were withdrawn or deleted after the
backup was taken. Tombstones (TOMB# items, never TTL'd) record every withdrawal, deletion, key-state change and
epoch bump. `apply_tombstones` copies each one from the source (the table the function serves right now) into the
restored target and applies it, scrubs actor IDs older than 90 days (registry.scrub), then writes the SYSTEM/RESTORE
marker last, naming the source, the target and the restore ID. The app
refuses every route while RESTORED_FROM is set and no marker names its own TABLE_NAME and RESTORE_ID.

  python -m registry.restore --source SERVED_TABLE --served SERVED_TABLE --target RESTORED_TABLE --restore-id ID
"""
import argparse
import time

from . import scrub

RANK = ("active", "rotated", "retired", "compromised")  # most revoked wins (AD-20)


def _is_pilot(item, kind_field):
    return item.get(kind_field) == "pilot" or "company_fp" in item or "not_after" in item


def apply_tombstones(source, target, source_name, target_name, restore_id, served, clock=time.time):
    """Replay `source`'s tombstones into `target`, then write the marker naming this target and restore.

    `served` is the table the function serves right now. Only it holds every tombstone written since its own
    restore, so any other source (for example the table an earlier restore came from) is refused.
    """
    if not restore_id:
        raise ValueError("restore_id is required")
    if source_name != served:
        raise ValueError(f"source {source_name!r} is not the served table {served!r}; its tombstones may be stale")
    if target_name in (source_name, served):
        raise ValueError("the target must be the new restored table")
    tombs = source.scan("TOMB#")  # raises if unreadable: no marker is written, the app stays closed
    now = int(clock())
    key_orgs = set()
    for t in tombs:
        target.put(t)
        if t["kind"] == "registration":
            key = (f"ORG#{t['org']}", "REG#" + t["ref"])
            if target.get(*key) is not None:
                target.update(*key, set={"state": "deleted", "deleted_at": t["at"]}, remove=["received_at"])
            else:  # registered after the backup: a deleted stub keeps the id claimed, so a fresh retry gets 410
                target.put({"PK": key[0], "SK": key[1], "state": "deleted", "deleted_at": t["at"]})
        elif t["kind"] == "share":
            key = ("SHARE#" + t["ref"], "SHARE")
            if target.get(*key) is not None:
                target.update(*key, set={"state": "withdrawn", "withdrawn_at": t["at"]})
            else:  # created after the backup: a withdrawn record keeps its hash claimed, so no retry reopens it
                stub = {"PK": key[0], "SK": key[1], "org": t["org"], "state": "withdrawn", "withdrawn_at": t["at"]}
                if t.get("rid"):
                    stub["rid"] = t["rid"]
                target.put(stub)
                # The list index (GET /v1/shares), dated by the withdrawal: the backup has none for this share.
                index = {"PK": f"ORG#{t['org']}", "SK": f"SHARE#{t['at']:012d}#{t['ref']}"}
                if t.get("rid"):
                    index["rid"] = t["rid"]
                target.put(index)
        elif t["kind"] == "key":
            # The key's own kind is `key_kind` on a tombstone (`kind` is the tombstone's); missing means company.
            pk, state = f"ORG#{t['org']}", t.get("state", "compromised")
            key_orgs.add(pk)
            pilot = _is_pilot(t, "key_kind")
            fields = {"kind": "pilot" if pilot else "company"}
            fields.update({f: t[f] for f in ("company_fp", "not_after") if f in t})
            cur = target.get(pk, "KEY#" + t["ref"])
            if cur is not None:
                if _is_pilot(cur, "kind") != pilot:  # raises before the marker: the app stays closed
                    raise ValueError(f"key {t['ref']} in {t['org']}: tombstone and key item disagree on kind")
                if RANK.index(state) >= RANK.index(cur.get("state", "active")):
                    target.update(pk, "KEY#" + t["ref"], set={**fields, "state": state, "changed_at": t["at"]})
                else:  # the restored item is already more revoked: keep its state and date
                    target.update(pk, "KEY#" + t["ref"], set=fields)
            else:  # enrolled after the backup: bring it back in its latest state
                target.put({"PK": pk, "SK": "KEY#" + t["ref"], **fields, "state": state,
                            "enrolled_at": t.get("enrolled_at", t["at"]), "enrolled_by": t.get("enrolled_by", "restore"),
                            "changed_at": t["at"]})
        elif t["kind"] == "epoch":
            pk = f"ORG#{t['org']}"
            cur = (target.get(pk, "EPOCH") or {}).get("epoch", 0)
            target.put({"PK": pk, "SK": "EPOCH", "epoch": max(cur, t["value"])})
    for pk in key_orgs:
        _recompute_active_key(target, pk)
    scrub.scrub(target, now)  # R52: the backup may hold actor IDs already past 90 days; raises before the marker
    target.put({"PK": "SYSTEM", "SK": "RESTORE", "source": source_name, "target": target_name,
                "restore_id": restore_id, "applied_at": now, "tombstones": len(tombs)})
    return len(tombs)


def _recompute_active_key(table, pk):
    """ACTIVE_KEY follows the replayed company key states: the most recently changed active company key, or none.
    Pilot keys never become ACTIVE_KEY and are never demoted here; PILOT_COUNT is recounted from the active ones."""
    keys, cursor = [], None
    while True:
        page, cursor = table.query(pk, "KEY#", 50, cursor)
        keys += page
        if not cursor:
            break
    pilots = [k for k in keys if _is_pilot(k, "kind")]
    table.put({"PK": pk, "SK": "PILOT_COUNT", "n": sum(1 for k in pilots if k.get("state") == "active")})
    active = sorted((k for k in keys if k.get("state") == "active" and not _is_pilot(k, "kind")),
                    key=lambda k: k["changed_at"])
    for k in active[:-1]:  # more than one can only come from inconsistent history: keep only the newest
        table.update(pk, k["SK"], set={"state": "rotated"})
    if active:
        table.put({"PK": pk, "SK": "ACTIVE_KEY", "fp": active[-1]["SK"][4:]})
    elif table.get(pk, "ACTIVE_KEY") is not None:
        table.delete(pk, "ACTIVE_KEY")


def main(argv=None):
    from .store import DynamoTable

    p = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    p.add_argument("--source", required=True, help="table to read tombstones from: the table served right now")
    p.add_argument("--target", required=True, help="new restored table to apply them to")
    p.add_argument("--served", required=True, help="TABLE_NAME of the function right now (must equal --source)")
    p.add_argument("--restore-id", required=True, help="the restoreId passed to cdk deploy for this restore")
    a = p.parse_args(argv)
    n = apply_tombstones(DynamoTable(a.source), DynamoTable(a.target), source_name=a.source, target_name=a.target,
                         restore_id=a.restore_id, served=a.served)
    print(f"applied {n} tombstones to {a.target} (restore {a.restore_id})")

if __name__ == "__main__":
    main()
