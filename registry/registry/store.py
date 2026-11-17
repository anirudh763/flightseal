"""The one-table store: a small Table protocol, a DynamoDB adapter and an in-memory test double.

Conditions are a tiny language both adapters understand, so tests exercise the same conditions DynamoDB gets:
a list of clauses, all of which must hold:
  ("exists",) / ("not_exists",)        the item itself
  ("missing", attr)                     attribute absent
  ("eq"|"lt"|"gt", attr, value)         compare; a missing attribute never matches
  ("or", clause, clause)
Updates take `set` (dict), `remove` (list) and `add` (dict of numeric increments).
Every read is strongly consistent.
"""
import copy
from typing import Protocol


class ConditionFailed(Exception):
    pass


class TransactionCanceled(Exception):
    def __init__(self, reasons):
        super().__init__(reasons)
        self.reasons = reasons  # one entry per op: "ConditionalCheckFailed" or None


class StoreUnavailable(Exception):
    """Any store error that is not a condition result. Callers fail closed on it."""


class Table(Protocol):
    def get(self, pk, sk): ...
    def put(self, item, cond=None): ...
    def update(self, pk, sk, set=None, remove=None, add=None, cond=None): ...
    def delete(self, pk, sk, cond=None): ...
    def query(self, pk, prefix, limit, start=None): ...
    def scan(self, pk_prefix): ...
    def transact(self, ops): ...


# ---------------------------------------------------------------- in memory

def _clause_ok(item, c):
    kind = c[0]
    if kind == "exists":
        return item is not None
    if kind == "not_exists":
        return item is None
    if kind == "or":
        return _clause_ok(item, c[1]) or _clause_ok(item, c[2])
    if kind == "missing":
        return item is None or c[1] not in item
    if item is None or c[1] not in item:
        return False
    a, v = item[c[1]], c[2]
    return {"eq": a == v, "lt": a < v, "gt": a > v}[kind]


def _cond_ok(item, cond):
    return all(_clause_ok(item, c) for c in (cond or []))


def _apply_update(item, key, set=None, remove=None, add=None):
    out = dict(item) if item else {"PK": key[0], "SK": key[1]}
    out.update(copy.deepcopy(set or {}))
    for a in remove or []:
        out.pop(a, None)
    for a, n in (add or {}).items():
        out[a] = out.get(a, 0) + n
    return out


class MemoryTable:
    """Test double. `fail` is an optional predicate (op, pk, sk) -> bool that simulates a store outage."""

    def __init__(self, fail=None):
        self.items = {}
        self.fail = fail

    def _check(self, op, pk, sk):
        if self.fail and self.fail(op, pk, sk):
            raise StoreUnavailable(f"simulated {op} failure")

    def get(self, pk, sk):
        self._check("get", pk, sk)
        item = self.items.get((pk, sk))
        return copy.deepcopy(item)

    def put(self, item, cond=None):
        key = (item["PK"], item["SK"])
        self._check("put", *key)
        if not _cond_ok(self.items.get(key), cond):
            raise ConditionFailed()
        self.items[key] = copy.deepcopy(item)

    def update(self, pk, sk, set=None, remove=None, add=None, cond=None):
        self._check("update", pk, sk)
        cur = self.items.get((pk, sk))
        if not _cond_ok(cur, cond):
            raise ConditionFailed()
        self.items[(pk, sk)] = _apply_update(cur, (pk, sk), set, remove, add)
        return copy.deepcopy(self.items[(pk, sk)])

    def delete(self, pk, sk, cond=None):
        self._check("delete", pk, sk)
        if not _cond_ok(self.items.get((pk, sk)), cond):
            raise ConditionFailed()
        self.items.pop((pk, sk), None)

    def query(self, pk, prefix, limit, start=None):
        self._check("query", pk, prefix)
        sks = sorted(sk for p, sk in self.items if p == pk and sk.startswith(prefix) and (start is None or sk > start))
        page = sks[:limit]
        last = page[-1] if len(page) == limit else None  # like DynamoDB: a full page always returns a cursor
        return [copy.deepcopy(self.items[(pk, sk)]) for sk in page], last

    def scan(self, pk_prefix):
        self._check("scan", pk_prefix, "")
        return [copy.deepcopy(v) for (pk, _), v in sorted(self.items.items()) if pk.startswith(pk_prefix)]

    def transact(self, ops):
        for op in ops:
            self._check("transact", *_op_key(op))
        reasons = [None if _cond_ok(self.items.get(_op_key(op)), op.get("cond")) else "ConditionalCheckFailed"
                   for op in ops]
        if any(reasons):
            raise TransactionCanceled(reasons)  # nothing applied: all or none
        for op in ops:
            key = _op_key(op)
            if op["op"] == "put":
                self.items[key] = copy.deepcopy(op["item"])
            elif op["op"] == "update":
                self.items[key] = _apply_update(self.items.get(key), key, op.get("set"), op.get("remove"), op.get("add"))
            elif op["op"] == "delete":
                self.items.pop(key, None)


def _op_key(op):
    if op["op"] == "put":
        return (op["item"]["PK"], op["item"]["SK"])
    return tuple(op["key"])


# ---------------------------------------------------------------- DynamoDB

class _Expr:
    def __init__(self):
        self.names, self.values = {}, {}

    def name(self, a):
        tag = f"#n{len(self.names)}"
        self.names[tag] = a
        return tag

    def value(self, v):
        tag = f":v{len(self.values)}"
        self.values[tag] = v
        return tag

    def clause(self, c):
        kind = c[0]
        if kind == "exists":
            return f"attribute_exists({self.name('PK')})"
        if kind == "not_exists":
            return f"attribute_not_exists({self.name('PK')})"
        if kind == "missing":
            return f"attribute_not_exists({self.name(c[1])})"
        if kind == "or":
            return f"({self.clause(c[1])} OR {self.clause(c[2])})"
        op = {"eq": "=", "lt": "<", "gt": ">"}[kind]
        return f"{self.name(c[1])} {op} {self.value(c[2])}"

    def cond(self, cond):
        return " AND ".join(self.clause(c) for c in cond) if cond else None


def _update_expr(e, set=None, remove=None, add=None):
    parts = []
    if set:
        parts.append("SET " + ", ".join(f"{e.name(a)} = {e.value(v)}" for a, v in set.items()))
    if remove:
        parts.append("REMOVE " + ", ".join(e.name(a) for a in remove))
    if add:
        parts.append("ADD " + ", ".join(f"{e.name(a)} {e.value(v)}" for a, v in add.items()))
    return " ".join(parts)


class DynamoTable:
    """boto3 adapter, imported lazily so the tests run without boto3. The endpoint comes from the environment."""

    def __init__(self, name, client=None):
        import boto3
        from boto3.dynamodb.types import TypeDeserializer, TypeSerializer
        from botocore.exceptions import BotoCoreError, ClientError

        self.name = name
        self.client = client or boto3.client("dynamodb")
        self._ser, self._de = TypeSerializer(), TypeDeserializer()
        self._errors = (BotoCoreError, ClientError)
        self._client_error = ClientError

    def _to(self, item):
        return {k: self._ser.serialize(v) for k, v in item.items()}

    def _from(self, raw):
        from decimal import Decimal

        def plain(v):
            if isinstance(v, Decimal):
                return int(v)
            if isinstance(v, list):
                return [plain(x) for x in v]
            return v
        return {k: plain(self._de.deserialize(v)) for k, v in raw.items()}

    def _key(self, pk, sk):
        return {"PK": {"S": pk}, "SK": {"S": sk}}

    def _call(self, fn, **kw):
        try:
            return fn(**kw)
        except self._client_error as err:
            code = err.response.get("Error", {}).get("Code", "")
            if code == "ConditionalCheckFailedException":
                raise ConditionFailed() from None
            if code == "TransactionCanceledException":
                reasons = [r.get("Code") for r in err.response.get("CancellationReasons", [])]
                if reasons and all(r in ("None", None, "ConditionalCheckFailed") for r in reasons):
                    raise TransactionCanceled([None if r in ("None", None) else r for r in reasons]) from None
            raise StoreUnavailable(code or "client error") from None
        except self._errors as err:
            raise StoreUnavailable(type(err).__name__) from None

    def _with(self, kw, e, cond):
        expr = e.cond(cond)
        if expr:
            kw["ConditionExpression"] = expr
        if e.names:
            kw["ExpressionAttributeNames"] = e.names
        if e.values:
            kw["ExpressionAttributeValues"] = self._to(e.values)
        return kw

    def get(self, pk, sk):
        r = self._call(self.client.get_item, TableName=self.name, Key=self._key(pk, sk), ConsistentRead=True)
        return self._from(r["Item"]) if "Item" in r else None

    def put(self, item, cond=None):
        self._call(self.client.put_item, **self._put_kw(item, cond))

    def _put_kw(self, item, cond):
        return self._with({"TableName": self.name, "Item": self._to(item)}, _Expr(), cond)

    def _update_kw(self, pk, sk, set=None, remove=None, add=None, cond=None):
        e = _Expr()
        kw = {"TableName": self.name, "Key": self._key(pk, sk), "UpdateExpression": _update_expr(e, set, remove, add)}
        return self._with(kw, e, cond)

    def update(self, pk, sk, set=None, remove=None, add=None, cond=None):
        r = self._call(self.client.update_item, ReturnValues="ALL_NEW", **self._update_kw(pk, sk, set, remove, add, cond))
        return self._from(r.get("Attributes", {}))

    def _delete_kw(self, pk, sk, cond):
        return self._with({"TableName": self.name, "Key": self._key(pk, sk)}, _Expr(), cond)

    def delete(self, pk, sk, cond=None):
        self._call(self.client.delete_item, **self._delete_kw(pk, sk, cond))

    def query(self, pk, prefix, limit, start=None):
        kw = {"TableName": self.name, "ConsistentRead": True, "Limit": limit,
              "KeyConditionExpression": "#p = :p AND begins_with(#s, :s)",
              "ExpressionAttributeNames": {"#p": "PK", "#s": "SK"},
              "ExpressionAttributeValues": {":p": {"S": pk}, ":s": {"S": prefix}}}
        if start:
            kw["ExclusiveStartKey"] = self._key(pk, start)
        r = self._call(self.client.query, **kw)
        last = r.get("LastEvaluatedKey")
        return [self._from(i) for i in r.get("Items", [])], (last["SK"]["S"] if last else None)

    def scan(self, pk_prefix):
        kw = {"TableName": self.name, "ConsistentRead": True, "FilterExpression": "begins_with(#p, :p)",
              "ExpressionAttributeNames": {"#p": "PK"}, "ExpressionAttributeValues": {":p": {"S": pk_prefix}}}
        out = []
        while True:
            r = self._call(self.client.scan, **kw)
            out += [self._from(i) for i in r.get("Items", [])]
            if "LastEvaluatedKey" not in r:
                return out
            kw["ExclusiveStartKey"] = r["LastEvaluatedKey"]

    def transact(self, ops):
        items = []
        for op in ops:
            if op["op"] == "put":
                items.append({"Put": self._put_kw(op["item"], op.get("cond"))})
            elif op["op"] == "update":
                items.append({"Update": self._update_kw(*op["key"], op.get("set"), op.get("remove"), op.get("add"),
                                                        op.get("cond"))})
            elif op["op"] == "delete":
                items.append({"Delete": self._delete_kw(*op["key"], op.get("cond"))})
            elif op["op"] == "check":
                kw = self._delete_kw(*op["key"], op.get("cond"))
                items.append({"ConditionCheck": kw})
        self._call(self.client.transact_write_items, TransactItems=items)
