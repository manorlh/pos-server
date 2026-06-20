FROM python:3.11-slim

WORKDIR /app

RUN pip install poetry==1.8.4

COPY pyproject.toml poetry.lock ./
RUN poetry config virtualenvs.create false \
    && poetry install --only main --no-interaction --no-ansi

COPY alembic.ini ./
COPY alembic/ ./alembic/
COPY app/ ./app/

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
