"""R52: drop actor IDs after 90 days, and expired challenges and envelopes.

`enrolled_by` (a Cognito sub) on KEY items and key tombstones becomes "scrubbed" once the key was enrolled 90 days
ago or more (a missing `enrolled_at` counts as 0, so it is scrubbed). Nothing else on those items changes: state,
dates, kind, fingerprint and pilot fields stay. CHAL# and ENV# items past `expires_at` are deleted (TTL removes them
too, but only within days, and not at all on a restored table until its TTL is on).

Run daily by its own Lambda (`registry.scrub.handler`, Scan/UpdateItem/DeleteItem only) and by `registry.restore`
before it writes the marker. Every write is conditional, so a race never creates an item; a lost race is skipped.
"""
import json
import os
import time

from .store import ConditionFailed

PLACEHOLDERS = frozenset({"scrubbed", "restore", "unknown"})
RETAIN = 90 * 86400


def _scrub_actor(table, item, now):
    old = item.get("enrolled_by")
    if old is None or old in PLACEHOLDERS or now - item.get("enrolled_at", 0) < RETAIN:
        return 0
    try:
        table.update(item["PK"], item["SK"], set={"enrolled_by": "scrubbed"},
                     cond=[("exists",), ("eq", "enrolled_by", old)])
    except ConditionFailed:
        return 0
    return 1


def scrub(table, now):
    """Returns how many items it wrote: actor IDs scrubbed plus expired CHAL/ENV items deleted."""
    n = 0
    # ponytail: two full scans a day (O(table)); fine at pilot scale, a sparse index if the table grows large.
    for item in table.scan("ORG#"):
        sk = item["SK"]
        if sk.startswith("KEY#"):
            n += _scrub_actor(table, item, now)
        elif sk.startswith(("CHAL#", "ENV#")) and item.get("expires_at", 0) <= now:
            try:
                table.delete(item["PK"], sk, cond=[("lt", "expires_at", now + 1)])
                n += 1
            except ConditionFailed:
                pass
    for item in table.scan("TOMB#"):
        if item.get("kind") == "key":
            n += _scrub_actor(table, item, now)
    return n


def handler(event, context):
    from .store import DynamoTable

    n = scrub(DynamoTable(os.environ["TABLE_NAME"]), int(time.time()))
    print(json.dumps({"scrubbed": n}))
    return {"scrubbed": n}
