"""Central stdout logging setup, shared by api.py (web) and sync.py (cron).

stdout is the only sink: JSON lines on Render (RENDER env set) or LOG_FORMAT=json,
human-readable text otherwise. Render captures stdout. LOG_LEVEL controls verbosity.

Call setup_logging() once, before creating the FastAPI app.
"""

import datetime
import json
import logging
import os
import sys

_RESERVED = {
    'name', 'msg', 'args', 'levelname', 'levelno', 'pathname', 'filename',
    'module', 'exc_info', 'exc_text', 'stack_info', 'lineno', 'funcName',
    'created', 'msecs', 'relativeCreated', 'thread', 'threadName',
    'processName', 'process', 'taskName', 'message',
}


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {
            'ts': datetime.datetime.now(datetime.UTC).isoformat(),
            'level': record.levelname,
            'logger': record.name,
            'message': record.getMessage(),
        }
        for key, value in record.__dict__.items():
            if key not in _RESERVED and not key.startswith('_'):
                entry[key] = value
        if record.exc_info:
            entry['exception'] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


def setup_logging():
    from dotenv import load_dotenv
    load_dotenv()  # runs before plaid_client/supabase_client imports do it
    root = logging.getLogger()
    root.setLevel(os.environ.get('LOG_LEVEL', 'INFO').upper())
    handler = logging.StreamHandler(sys.stdout)
    use_json = os.environ.get('LOG_FORMAT', 'json' if os.environ.get('RENDER') else 'text') == 'json'
    if use_json:
        handler.setFormatter(JsonFormatter())
    else:
        handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)-7s %(name)s: %(message)s'))
    root.addHandler(handler)
