#!/bin/sh
set -e

# Wait for the database to be ready
# (Optional: we can rely on Docker Compose healthcheck, but a quick check here is good)

echo "Starting Supabase Multitenant..."

if [ -z "$DATABASE_URL" ]; then
  echo "Error: DATABASE_URL is not set."
  exit 1
fi

# Bring the control-plane schema in line with prisma/schema.prisma.
# NEVER pass --accept-data-loss: it lets a routine redeploy silently drop a column or table that
# holds real data. Without it, prisma refuses the push instead. A refused push must not take the
# panel down either (a crash-loop made every project unmanageable, issue #75) - the panel keeps
# running on the schema it has, and the refusal is logged loudly for an operator to resolve.
echo "Syncing database schema..."
if ! npx prisma db push --skip-generate; then
  echo "WARNING: schema sync was refused (it would lose data or conflicts with existing rows)." >&2
  echo "WARNING: starting on the existing schema. Resolve the change by hand, then redeploy." >&2
fi

# Execute the main command
echo "Starting application..."
exec "$@"
