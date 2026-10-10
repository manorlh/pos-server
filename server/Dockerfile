FROM python:3.11-slim

WORKDIR /app

RUN pip install poetry==1.8.4

COPY pyproject.toml poetry.lock ./
RUN poetry config virtualenvs.create false \
    && poetry install --only main --no-interaction --no-ansi

COPY alembic.ini ./
COPY alembic/ ./alembic/
COPY app/ ./app/

# Two worker processes (WEB_CONCURRENCY): one Python process is one core at most (the GIL),
# and a slow request no longer holds up every till. Each worker has its own pool and its own
# copy of the background workers (all safe across processes: leases, advisory locks, unique
# keys). The schema is alembic's (fly.toml release_command); DB_CREATE_ALL stays off here.
ENV WEB_CONCURRENCY=2 DB_CREATE_ALL=false

CMD ["sh", "-c", "exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY:-2}"]
