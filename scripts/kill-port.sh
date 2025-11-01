#!/bin/bash

# Script to kill process using port 3000
echo "Killing process on port 3000..."

# Kill process using port 3000
lsof -ti:3000 | xargs kill -9 2>/dev/null

if [ $? -eq 0 ]; then
    echo "✅ Successfully killed process on port 3000"
else
    echo "ℹ️  No process found on port 3000"
fi

# Also kill any Node.js processes that might be hanging
pkill -f "node.*3000" 2>/dev/null

echo "Ready to start server!"
