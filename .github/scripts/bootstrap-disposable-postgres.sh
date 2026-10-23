#!/bin/sh
# Disposable PostgreSQL 18 for the manual Gate 2 regression workflow.
# The cluster is loopback-only and matches the identity the payment tests
# already require. It does not use a service container, Neon, or production.
set -eu

. /etc/os-release
if [ -z "${VERSION_CODENAME:-}" ]; then
  echo "Ubuntu codename is unavailable." >&2
  exit 1
fi

sudo install -d /usr/share/postgresql-common/pgdg
sudo curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
  https://www.postgresql.org/media/keys/ACCC4CF8.asc
sudo tee /etc/apt/sources.list.d/pgdg.sources >/dev/null <<EOF
Types: deb
URIs: https://apt.postgresql.org/pub/repos/apt
Suites: ${VERSION_CODENAME}-pgdg
Architectures: $(dpkg --print-architecture)
Components: main
Signed-By: /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc
EOF

sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-common ca-certificates
if [ -f /etc/postgresql-common/createcluster.conf ]; then
  sudo sed -i 's/^#\?create_main_cluster.*/create_main_cluster = false/' /etc/postgresql-common/createcluster.conf
  if ! sudo grep -q '^create_main_cluster = false$' /etc/postgresql-common/createcluster.conf; then
    echo 'create_main_cluster = false' | sudo tee -a /etc/postgresql-common/createcluster.conf >/dev/null
  fi
else
  echo 'create_main_cluster = false' | sudo tee /etc/postgresql-common/createcluster.conf >/dev/null
fi
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql-18 postgresql-client-18

if [ -d /var/lib/postgresql/18/main ]; then
  echo "The PostgreSQL package created a default cluster. Refusing to continue." >&2
  exit 1
fi

BIN=/usr/lib/postgresql/18/bin
VERSION=$("$BIN/postgres" -V)
echo "$VERSION"
printf '%s\n' "$VERSION" | grep -q 'PostgreSQL) 18\.'

rm -rf /tmp/s1pg
mkdir -p /tmp/s1pg
"$BIN/initdb" \
  -D /tmp/s1pg/data \
  --username=postgres \
  --auth-local=trust \
  --auth-host=trust \
  --encoding=UTF8 \
  --locale=C
cat >> /tmp/s1pg/data/postgresql.conf <<'EOF'
listen_addresses = '127.0.0.1'
port = 54329
unix_socket_directories = '/tmp/s1pg'
EOF
"$BIN/pg_ctl" -D /tmp/s1pg/data -l /tmp/s1pg/postgres.log -w start

"$BIN/psql" "postgresql://postgres@127.0.0.1:54329/postgres" -v ON_ERROR_STOP=1 <<'SQL'
do $$
begin
  if current_setting('data_directory') is distinct from '/tmp/s1pg/data' then
    raise exception 'disposable data directory was not used';
  end if;
  if current_setting('listen_addresses') is distinct from '127.0.0.1' then
    raise exception 'PostgreSQL is not loopback-only';
  end if;
  if inet_server_addr() <> '127.0.0.1'::inet then
    raise exception 'server address is not loopback';
  end if;
  if current_setting('port') is distinct from '54329' then
    raise exception 'PostgreSQL is not listening on 54329';
  end if;
  if pg_is_in_recovery() then
    raise exception 'cluster is in recovery';
  end if;
end
$$;
SQL
