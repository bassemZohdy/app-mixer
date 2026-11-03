$ErrorActionPreference = 'Stop'
$primary = 'app-mixer-ha-recovery-primary'
$standby = 'app-mixer-ha-recovery-standby'
$network = 'app-mixer-ha-recovery-test'
$createdPrimary = $false
$createdStandby = $false
$createdNetwork = $false

function Invoke-Docker([string[]] $Arguments) {
    & docker @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Docker operation failed: $($Arguments[0])" }
}

foreach ($name in @($primary, $standby)) {
    & docker inspect $name *> $null
    if ($LASTEXITCODE -eq 0) { throw "Refusing to use existing container: $name" }
}
& docker network inspect $network *> $null
if ($LASTEXITCODE -eq 0) { throw "Refusing to use existing network: $network" }

try {
    Invoke-Docker @('network', 'create', $network)
    $createdNetwork = $true
    Invoke-Docker @('run', '-d', '--name', $primary, '--label', 'app-mixer.test=ha-recovery', '--network', $network, '--network-alias', 'primary', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-p', '127.0.0.1:56367:5432', 'postgres:17-alpine', '-c', 'wal_level=replica', '-c', 'max_wal_senders=5', '-c', 'hot_standby=on')
    $createdPrimary = $true
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        & docker exec $primary pg_isready -U postgres *> $null
        if ($LASTEXITCODE -eq 0) { $ready = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw 'Primary did not become ready' }
    Invoke-Docker @('run', '-d', '--name', $standby, '--label', 'app-mixer.test=ha-recovery', '--network', $network, '-p', '127.0.0.1:56368:5432', '--entrypoint', 'sh', 'postgres:17-alpine', '-c', 'sleep infinity')
    $createdStandby = $true
    Invoke-Docker @('exec', $primary, 'sh', '-c', 'echo "host replication all 0.0.0.0/0 trust" >> /var/lib/postgresql/data/pg_hba.conf')
    Invoke-Docker @('exec', '-u', 'postgres', $primary, 'pg_ctl', '-D', '/var/lib/postgresql/data', 'reload')
    Invoke-Docker @('exec', '-u', 'postgres', $standby, 'pg_basebackup', '-h', 'primary', '-U', 'postgres', '-D', '/var/lib/postgresql/data', '-Fp', '-Xs', '-R')
    Invoke-Docker @('exec', $standby, 'chmod', '700', '/var/lib/postgresql/data')
    Invoke-Docker @('exec', '-u', 'postgres', $standby, 'pg_ctl', '-D', '/var/lib/postgresql/data', '-l', '/tmp/standby.log', '-o', '-c listen_addresses=*', 'start')
    Invoke-Docker @('exec', $primary, 'psql', '-U', 'postgres', '-c', "ALTER SYSTEM SET synchronous_standby_names = '*'")
    Invoke-Docker @('exec', $primary, 'psql', '-U', 'postgres', '-c', "ALTER SYSTEM SET synchronous_commit = 'remote_apply'")
    Invoke-Docker @('exec', '-u', 'postgres', $primary, 'pg_ctl', '-D', '/var/lib/postgresql/data', 'reload')
    $replicated = $false
    for ($i = 0; $i -lt 60; $i++) {
        $state = & docker exec $primary psql -U postgres -tAc "SELECT state || ':' || sync_state || ':' || current_setting('synchronous_commit') FROM pg_stat_replication"
        if ($LASTEXITCODE -eq 0 -and $state.Trim() -eq 'streaming:sync:remote_apply') { $replicated = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $replicated) { throw 'Synchronous replication did not become ready' }
    $env:APP_MIXER_TEST_POSTGRES_URL = 'postgresql://postgres@127.0.0.1:56367/postgres'
    $env:APP_MIXER_TEST_HA_STANDBY_URL = 'postgresql://postgres@127.0.0.1:56368/postgres'
    $env:APP_MIXER_TEST_HA_FAILOVER = '1'
    & node --test packages/agent/test/postgres-shared-failover.test.mjs
    if ($LASTEXITCODE -ne 0) { throw 'Failover test failed' }
} finally {
    if ($createdPrimary) { & docker rm -f -v $primary }
    if ($createdStandby) { & docker rm -f -v $standby }
    if ($createdNetwork) { & docker network rm $network }
}
