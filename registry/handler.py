"""Lambda entry point: handler.handler."""
import os

from registry.app import App
from registry.store import DynamoTable

_app = None


def handler(event, _context):
    global _app
    if _app is None:
        _app = App(DynamoTable(os.environ["TABLE_NAME"]), os.environ)
    return _app.handle(event)
