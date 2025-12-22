#!/bin/bash

echo "⬇️  Pulling latest code..."
git pull

echo "🧹 Cleaning up old artifacts (fixing ContainerConfig error)..."
# Stop containers and remove the image to prevent legacy compose errors
docker-compose down
docker rmi sorovnoma_bot:latest 2>/dev/null || true

echo "🚀 Rebuilding and restarting..."
docker-compose up -d --build

echo "✅ Update complete. Logs:"
docker-compose logs -f --tail=50
