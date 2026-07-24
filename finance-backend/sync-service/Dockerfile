# PocketLens sync service — FastAPI web API and the sync/reconcile/digest jobs.
# Build context: finance-backend/sync-service/
#
# Runs the web API by default:
#   docker build -t pocketlens-api finance-backend/sync-service
#   docker run -p 8000:8000 --env-file finance-backend/sync-service/.env pocketlens-api
#
# The same image runs the scheduled jobs — override the command:
#   docker run --env-file .env pocketlens-api \
#     sh -c "python sync.py && python reconcile.py && python digests.py"
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000

CMD ["uvicorn", "api:app", "--host", "0.0.0.0", "--port", "8000"]
