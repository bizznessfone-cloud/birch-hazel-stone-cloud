#!/bin/sh
# Disposable PostgreSQL 18 for the manual Gate 2 regression workflow.
# The cluster is loopback-only and matches the identity the payment tests
# already require. It does not use a service container, Neon, or production.
set -eu

BIN=/usr/lib/postgresql/18/bin
DISPOSABLE_URL="postgresql://postgres@127.0.0.1:54329/postgres"

assert_disposable_cluster() {
  if [ ! -f /tmp/s1pg/data/global/pg_control ]; then
    echo "Disposable control file is missing." >&2
    exit 1
  fi
  file_id=$(node -e 'const fs=require("node:fs"); const fd=fs.openSync("/tmp/s1pg/data/global/pg_control","r"); const buf=Buffer.alloc(8); if (fs.readSync(fd, buf, 0, 8, 0)!==8) process.exit(2); fs.closeSync(fd); process.stdout.write(buf.readBigUInt64LE(0).toString());')
  db_id=$("$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -Atqc "select case when current_setting('data_directory') = '/tmp/s1pg/data' and current_setting('listen_addresses') = '127.0.0.1' and inet_server_addr() = '127.0.0.1'::inet and current_setting('port') = '54329' and pg_is_in_recovery() = false then system_identifier::text else '' end from pg_control_system()")
  if [ -z "$file_id" ] || [ "$file_id" != "$db_id" ]; then
    echo "Disposable cluster identity check failed." >&2
    exit 1
  fi
}

cleanup_disposable_databases() {
  assert_disposable_cluster
  databases=$("$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -Atqc "select datname from pg_database where datallowconn and datname not in ('postgres', 'template0', 'template1') order by 1")
  for database in $databases; do
    case "$database" in
      *[!a-z0-9_]*)
        echo "Refusing to drop an unexpected database name." >&2
        exit 1
        ;;
    esac
    "$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '${database}' and pid <> pg_backend_pid()" >/dev/null
    "$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -c "drop database if exists \"${database}\"" >/dev/null
  done
  for role in \
    sbg_fleet_writer \
    aether_payment_gateway \
    aether_expiry_runner \
    aether_expiry \
    aether_app \
    aether_runtime \
    aether_webhook \
    aether_mailer \
    sbg_capacity_writer
  do
    case "$role" in
      sbg_fleet_writer|aether_payment_gateway|aether_expiry_runner|aether_expiry|aether_app|aether_runtime|aether_webhook|aether_mailer|sbg_capacity_writer) ;;
      *)
        echo "Refusing to drop a role outside the disposable allowlist." >&2
        exit 1
        ;;
    esac
    exists=$("$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -Atqc "select 1 from pg_roles where rolname = '${role}'")
    if [ "$exists" != "1" ]; then
      continue
    fi
    members=$("$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -Atqc "select member.rolname from pg_auth_members membership join pg_roles granted on granted.oid = membership.roleid join pg_roles member on member.oid = membership.member where granted.rolname = '${role}' order by 1")
    for member in $members; do
      case "$member" in
        postgres|sbg_fleet_writer|aether_payment_gateway|aether_expiry_runner|aether_expiry|aether_app|aether_runtime|aether_webhook|aether_mailer|sbg_capacity_writer) ;;
        *)
          echo "Refusing to revoke an unexpected role membership." >&2
          exit 1
          ;;
      esac
      "$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -c "revoke \"${role}\" from \"${member}\"" >/dev/null
    done
    "$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -c "drop owned by \"${role}\"" >/dev/null
    remaining=$("$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -Atqc "select count(*) from pg_shdepend where refclassid = 'pg_authid'::regclass and refobjid = (select oid from pg_roles where rolname = '${role}') and deptype in ('a', 'o')")
    if [ "$remaining" != "0" ]; then
      echo "Refusing to drop a role that still owns shared objects." >&2
      exit 1
    fi
    "$BIN/psql" "$DISPOSABLE_URL" -v ON_ERROR_STOP=1 -c "drop role \"${role}\"" >/dev/null
  done
}

if [ "${1:-}" = "identify" ]; then
  if [ "$#" -ne 1 ]; then
    echo "Identify accepts no further arguments." >&2
    exit 1
  fi
  assert_disposable_cluster
  exit 0
fi
if [ "${1:-}" = "cleanup" ]; then
  if [ "$#" -ne 1 ]; then
    echo "Cleanup accepts no further arguments." >&2
    exit 1
  fi
  cleanup_disposable_databases
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo "Unexpected bootstrap argument." >&2
  exit 1
fi

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
assert_disposable_cluster
