"""Read-only access to Immich's Postgres for the maintenance tools.

The tools query Immich's database directly for the selections its API cannot
express — file paths and projection type. They go through `docker exec` into
the database container, so the database never needs to be exposed.

Configuration comes from the environment, using Immich's own .env names where
they exist:

  IMMICH_DB_CONTAINER   database container      (default: immich_postgres)
  DB_USERNAME           database user           (default: postgres)
  DB_DATABASE_NAME      database name           (default: immich)

The defaults match Immich's official docker-compose.yml.
"""
import os
import subprocess
import sys

CONTAINER = os.environ.get('IMMICH_DB_CONTAINER', 'immich_postgres')
USER = os.environ.get('DB_USERNAME', 'postgres')
DATABASE = os.environ.get('DB_DATABASE_NAME', 'immich')


def query(sql):
    """Rows of a query, each a list of strings."""
    r = subprocess.run(
        ['docker', 'exec', '-i', CONTAINER, 'psql', '-U', USER, '-d', DATABASE,
         '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-F', '\t'],
        input=sql, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'query in container {CONTAINER!r} failed: {r.stderr.strip()}\n'
                 'Set IMMICH_DB_CONTAINER, DB_USERNAME and DB_DATABASE_NAME to match your install.')
    return [line.split('\t') for line in r.stdout.splitlines() if line]


def literal(s):
    """A string as an SQL literal."""
    return "'" + s.replace("'", "''") + "'"
