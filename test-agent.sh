#!/bin/bash
# Test script for daydreams-news-agent

AGENT_URL="https://daydreams-agent-kit-production.up.railway.app"
ENDPOINT="$AGENT_URL/entrypoints/latest-daydreams-news/invoke"

echo "Testing daydreams-news-agent..."
echo "URL: $ENDPOINT"
echo ""

curl -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "limit": 5
    }
  }' | jq '.' 2>/dev/null || curl -X POST "$ENDPOINT" \
  -H "Content-Type: application/json" \
  -d '{
    "input": {
      "limit": 5
    }
  }'

echo ""
