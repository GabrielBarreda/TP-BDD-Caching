#!/bin/bash
# Attendre que le primary soit prêt
echo 'Waiting for primary database...'
until pg_isready -h db-primary -p 5432 -U app; do
  sleep 2
done

# Nettoyer le répertoire data si existant
rm -rf /var/lib/postgresql/data/*

# Créer la réplication
echo 'Creating base backup from primary...'
PGPASSWORD=app_pwd pg_basebackup -h db-primary -p 5432 -U app -D /var/lib/postgresql/data -R -X stream -P -v

# Démarrer PostgreSQL en mode standby
echo 'Starting PostgreSQL in standby mode...'
exec postgres -c hot_standby=on