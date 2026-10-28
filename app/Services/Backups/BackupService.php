<?php

namespace App\Services\Backups;

use App\Models\Device;
use App\Models\Setting;
use App\Services\OidcService;
use Carbon\CarbonInterface;
use Illuminate\Contracts\Cache\Lock;
use Illuminate\Encryption\Encrypter;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Crypt;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Schema;
use PDO;
use PharData;
use RuntimeException;
use Throwable;

/**
 * Backups: one .tar per backup holding the whole database as gzipped JSON
 * lines (one file per table), the settings that live in it, and the files
 * outside it that an install cannot be rebuilt without: the APP_KEY the
 * encrypted settings depend on, the server link secret, and the embedded ID
 * server's key pair and peer database.
 *
 * The dump is written by PHP, not mysqldump, so the same archive restores into
 * MySQL or MariaDB regardless of which produced it and the image needs no
 * client tools. Restore replaces every data table and re-keys encrypted values
 * when the archive came from a different APP_KEY, so an archive from one
 * install restores cleanly into a fresh one.
 *
 * Archive layout (format 1):
 *   manifest.json                  what is inside, versions, row counts
 *   db/<table>.ndjson.gz           one JSON object per row
 *   files/app_key                  config('app.key') at backup time
 *   files/server_secret            when the console-server link is on
 *   files/rustdesk/id_ed25519      the embedded server's key pair and
 *   files/rustdesk/id_ed25519.pub  peer database, when it runs in this
 *   files/rustdesk/db_v2.sqlite3   container (CORTENDESK_RUSTDESK_DIR)
 */
class BackupService
{
    public const FORMAT = 1;

    public const PREFIX = 'cortendesk-backup-';

    /** A backup file name: our prefix, a timestamp, an optional tag. Also what the download route accepts. */
    public const NAME_PATTERN = '/^cortendesk-backup-\d{8}-\d{6}(?:-[a-z0-9]{1,16})?\.tar$/';

    /** Per-process or per-request state, not data: neither backed up nor touched on restore. */
    public const SKIP_TABLES = [
        'cache', 'cache_locks', 'sessions', 'jobs', 'job_batches', 'failed_jobs',
        'oidc_auth_requests', 'password_reset_tokens', 'password_resets',
    ];

    /** In the archive for the record; the live schema owns it on restore. */
    public const KEEP_ON_RESTORE = ['migrations'];

    /**
     * Columns holding Laravel-encrypted payloads. Re-keyed on restore when the
     * archive's APP_KEY differs from this install's.
     *
     * @var array<string, list<string>>
     */
    public const ENCRYPTED_COLUMNS = [
        'settings' => ['value'],
        'users' => ['totp_secret'],
        'address_book_entries' => ['password_enc'],
    ];

    public const RUSTDESK_FILES = ['id_ed25519', 'id_ed25519.pub', 'db_v2.sqlite3'];

    /**
     * Retention tiers, all applied at once: the newest N backups, the first
     * backup of each of the last N weeks, the first of each of the last N
     * months. Defaults: a week of dailies, two months of weeklies, half a year
     * of monthlies. 0 turns a tier off; all three at 0 keeps everything.
     */
    public const DEFAULT_KEEP = ['daily' => 7, 'weekly' => 8, 'monthly' => 6];

    public const MAX_KEEP = 365;

    public const TARGETS = ['none' => 'None', 'ftp' => 'FTP / FTPS', 's3' => 'S3-compatible storage'];

    private const CHUNK = 500;

    // ---- settings ---------------------------------------------------------

    /**
     * @return array{enabled: bool, keep: array{daily: int, weekly: int, monthly: int}, target: string}
     */
    public static function settings(): array
    {
        $keep = [];
        foreach (self::DEFAULT_KEEP as $tier => $default) {
            $stored = Setting::get('backup_keep_'.$tier);
            $keep[$tier] = $stored === null || $stored === '' ? $default : max(0, min(self::MAX_KEEP, (int) $stored));
        }

        $target = (string) Setting::get('backup_target', 'none');

        return [
            'enabled' => Setting::get('backup_enabled', '1') === '1',
            'keep' => $keep,
            'target' => isset(self::TARGETS[$target]) ? $target : 'none',
        ];
    }

    /** The configured off-site target, or null when copies are off. */
    public static function target(): ?RemoteTarget
    {
        return match (self::settings()['target']) {
            'ftp' => new FtpTarget(
                host: (string) Setting::get('backup_ftp_host', ''),
                port: (int) Setting::get('backup_ftp_port', '21'),
                username: (string) Setting::get('backup_ftp_username', ''),
                password: self::secret('backup_ftp_password'),
                path: (string) Setting::get('backup_ftp_path', ''),
                tls: Setting::get('backup_ftp_tls', '0') === '1',
            ),
            's3' => new S3Target(
                bucket: (string) Setting::get('backup_s3_bucket', ''),
                region: (string) Setting::get('backup_s3_region', ''),
                accessKey: (string) Setting::get('backup_s3_access_key', ''),
                secretKey: self::secret('backup_s3_secret_key'),
                endpoint: (string) Setting::get('backup_s3_endpoint', ''),
                prefix: (string) Setting::get('backup_s3_prefix', ''),
                pathStyle: Setting::get('backup_s3_path_style', '0') === '1',
            ),
            default => null,
        };
    }

    public static function secret(string $key): string
    {
        $stored = (string) Setting::get($key, '');
        if ($stored === '') {
            return '';
        }

        try {
            return Crypt::decryptString($stored);
        } catch (Throwable) {
            return '';
        }
    }

    /**
     * Whether the daily run is owed: nothing scheduled since midnight. Calendar
     * based, so a box that was off at 03:30 catches up the next time the
     * scheduler runs.
     */
    public static function due(?CarbonInterface $lastScheduled, ?CarbonInterface $now = null): bool
    {
        return $lastScheduled === null || $lastScheduled->lt(($now ?? now())->copy()->startOfDay());
    }

    /**
     * Which of these backups the retention tiers do not cover.
     *
     * Every backup is a daily point; the oldest backup inside a week or a
     * month is that period's weekly or monthly point. Periods are counted from
     * the newest backup, so a gap in the run does not silently widen what is
     * kept.
     *
     * @param  list<array{name: string, created_at: CarbonInterface}>  $entries
     * @param  array{daily: int, weekly: int, monthly: int}  $keep
     * @return list<string> names to delete, oldest first
     */
    public static function prunable(array $entries, array $keep): array
    {
        $keep = array_map(fn ($n) => max(0, (int) $n), $keep + self::DEFAULT_KEEP);
        if (array_sum($keep) <= 0) {
            return [];
        }

        usort($entries, fn ($a, $b) => $b['created_at'] <=> $a['created_at'] ?: strcmp($b['name'], $a['name']));

        $kept = [];
        foreach (array_slice($entries, 0, $keep['daily']) as $entry) {
            $kept[$entry['name']] = true;
        }

        foreach (['weekly' => 'o-W', 'monthly' => 'Y-m'] as $tier => $format) {
            if ($keep[$tier] === 0) {
                continue;
            }
            // Newest first, so the last write per period is the oldest backup
            // in it, and the keys arrive newest period first.
            $firstOfPeriod = [];
            foreach ($entries as $entry) {
                $firstOfPeriod[$entry['created_at']->format($format)] = $entry['name'];
            }
            foreach (array_slice($firstOfPeriod, 0, $keep[$tier], true) as $name) {
                $kept[$name] = true;
            }
        }

        $delete = [];
        foreach (array_reverse($entries) as $entry) {
            if (! isset($kept[$entry['name']])) {
                $delete[] = $entry['name'];
            }
        }

        return $delete;
    }

    /** The timestamp baked into one of our file names, or null for anything else. */
    public static function createdAtFromName(string $name): ?Carbon
    {
        if (! preg_match('/^cortendesk-backup-(\d{8}-\d{6})/', $name, $m)) {
            return null;
        }
        try {
            return Carbon::createFromFormat('Ymd-His', $m[1]) ?: null;
        } catch (Throwable) {
            return null;
        }
    }

    // ---- storage ----------------------------------------------------------

    public function directory(): string
    {
        $dir = rtrim((string) config('cortendesk.backups_path'), '/');
        if ($dir === '') {
            throw new RuntimeException('No backup directory is configured (CORTENDESK_BACKUPS_PATH).');
        }
        if (! is_dir($dir) && ! @mkdir($dir, 0700, true) && ! is_dir($dir)) {
            throw new RuntimeException("Cannot create the backup directory {$dir}.");
        }
        if (! is_writable($dir)) {
            throw new RuntimeException("The backup directory {$dir} is not writable.");
        }

        return $dir;
    }

    /**
     * Local backups, newest first.
     *
     * @return list<array{name: string, path: string, size: int, created_at: Carbon, manifest: ?array}>
     */
    public function list(): array
    {
        $dir = $this->directory();
        $rows = [];

        foreach (glob($dir.'/'.self::PREFIX.'*.tar') ?: [] as $path) {
            $name = basename($path);
            if (! preg_match(self::NAME_PATTERN, $name)) {
                continue;
            }

            // A sidecar another user wrote (artisan run as root) is skipped,
            // not fatal; the row then shows the file's own time.
            $manifest = null;
            if (is_readable($path.'.json')) {
                $decoded = json_decode((string) @file_get_contents($path.'.json'), true);
                $manifest = is_array($decoded) ? $decoded : null;
            }

            $created = null;
            if (is_string($manifest['created_at'] ?? null)) {
                try {
                    $created = Carbon::parse($manifest['created_at']);
                } catch (Throwable) {
                    $created = null;
                }
            }

            $rows[] = [
                'name' => $name,
                'path' => $path,
                'size' => (int) filesize($path),
                'created_at' => $created ?? Carbon::createFromTimestamp((int) filemtime($path)),
                'manifest' => $manifest,
            ];
        }

        // The timestamp is in the name, so a name sort is a time sort.
        usort($rows, fn ($a, $b) => strcmp($b['name'], $a['name']));

        return $rows;
    }

    /** Absolute path of a named local backup, or null when there is no such file. */
    public function path(string $name): ?string
    {
        if (! preg_match(self::NAME_PATTERN, $name)) {
            return null;
        }
        $path = $this->directory().'/'.$name;

        return is_file($path) ? $path : null;
    }

    public function delete(string $name): void
    {
        $path = $this->path($name);
        if ($path === null) {
            throw new RuntimeException("No backup named {$name}.");
        }
        @unlink($path.'.json');
        if (! @unlink($path)) {
            throw new RuntimeException("Could not delete {$name}.");
        }
    }

    /**
     * Apply the retention tiers to the local backups.
     *
     * @param  array{daily: int, weekly: int, monthly: int}  $keep
     * @return list<string> names deleted
     */
    public function applyRetention(array $keep): array
    {
        $entries = array_map(fn ($row) => ['name' => $row['name'], 'created_at' => $row['created_at']], $this->list());

        $deleted = [];
        foreach (self::prunable($entries, $keep) as $name) {
            $this->delete($name);
            $deleted[] = $name;
        }

        return $deleted;
    }

    /**
     * Make the off-site target mirror the local list: upload what it lacks,
     * delete what the server no longer has. Only files named like ours are
     * touched, so the directory or prefix can be shared.
     *
     * @return array{uploaded: list<string>, deleted: list<string>}
     */
    public function syncRemote(RemoteTarget $target): array
    {
        // Two runs copying the same file at once (Back up now during the
        // scheduled run) can leave a copy that is full size but wrong, which
        // no size check catches. The second one leaves the target alone.
        // flock rather than a cache lock: the kernel lets go when a run dies,
        // so a killed run cannot hold it.
        $handle = false;
        foreach ([storage_path('framework/backup-copy.lock'), sys_get_temp_dir().'/cortendesk-backup-copy.lock'] as $path) {
            if ($handle = @fopen($path, 'c') ?: @fopen($path, 'r')) {
                break;
            }
        }
        if ($handle === false) {
            Log::warning('Backup off-site copy runs without its lock: no lock file could be opened.');
        }
        if ($handle !== false && ! flock($handle, LOCK_EX | LOCK_NB)) {
            fclose($handle);
            throw new RuntimeException('Another run is copying to the off-site target right now, so this one left it alone. Its backup goes up with the next run.');
        }

        try {
            return $this->mirror($target);
        } finally {
            if ($handle !== false) {
                flock($handle, LOCK_UN);
                fclose($handle);
            }
        }
    }

    /** @return array{uploaded: list<string>, deleted: list<string>} */
    private function mirror(RemoteTarget $target): array
    {
        $local = [];
        foreach ($this->list() as $row) {
            $local[$row['name']] = $row['path'];
        }

        $remote = [];
        foreach ($target->list() as $name => $size) {
            if (preg_match(self::NAME_PATTERN, $name)) {
                $remote[$name] = $size;
            }
        }

        $result = ['uploaded' => [], 'deleted' => []];

        // Oldest first, so a run cut short leaves the remote a prefix of the
        // local list rather than holes in it.
        foreach (array_reverse($local, true) as $name => $path) {
            // Missing, or there at another size: a copy cut short by a run
            // that died mid-upload would otherwise count as copied for good.
            if (! array_key_exists($name, $remote) || ($remote[$name] !== null && $remote[$name] !== filesize($path))) {
                $target->put($path, $name);
                $result['uploaded'][] = $name;
            }
        }

        foreach (array_keys($remote) as $name) {
            if (! isset($local[$name])) {
                $target->delete($name);
                $result['deleted'][] = $name;
            }
        }

        return $result;
    }

    /**
     * Bring a file an operator uploaded into the backup directory under a name
     * the rest of this class accepts, and verify it is one of ours.
     *
     * @return string the stored name
     */
    public function import(string $sourcePath, string $originalName): string
    {
        $manifest = $this->readManifest($sourcePath);

        $name = preg_match(self::NAME_PATTERN, $originalName) ? $originalName : null;
        $dir = $this->directory();
        if ($name === null || is_file($dir.'/'.$name)) {
            $name = self::PREFIX.now()->format('Ymd-His').'-upload.tar';
        }

        if (! @copy($sourcePath, $dir.'/'.$name)) {
            throw new RuntimeException('Could not store the uploaded backup.');
        }
        file_put_contents($dir.'/'.$name.'.json', json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
        @chmod($dir.'/'.$name, 0600);
        @chmod($dir.'/'.$name.'.json', 0600);

        return $name;
    }

    // ---- create -----------------------------------------------------------

    /**
     * @return array{name: string, path: string, size: int, manifest: array}
     */
    public function create(string $trigger = 'manual'): array
    {
        $lock = $this->lock();
        $dir = $this->directory();
        $work = $dir.'/.work-'.bin2hex(random_bytes(4));

        try {
            $pkg = $work.'/pkg';
            if (! mkdir($pkg.'/db', 0700, true) || ! mkdir($pkg.'/files/rustdesk', 0700, true)) {
                throw new RuntimeException("Cannot write to {$dir}.");
            }

            $tables = [];
            foreach ($this->tables() as $table) {
                $tables[$table] = $this->dumpTable($table, "{$pkg}/db/{$table}.ndjson.gz");
            }

            $files = $this->collectFiles($pkg.'/files');

            $manifest = [
                'format' => self::FORMAT,
                'app' => 'cortendesk',
                'app_version' => (string) config('cortendesk.api_version'),
                'created_at' => now()->toIso8601String(),
                'trigger' => $trigger,
                'app_url' => (string) config('app.url'),
                'db_driver' => DB::connection()->getDriverName(),
                'tables' => $tables,
                'files' => $files,
            ];
            file_put_contents($pkg.'/manifest.json', json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));

            $name = self::PREFIX.now()->format('Ymd-His').'.tar';
            $path = $dir.'/'.$name;
            for ($i = 2; is_file($path); $i++) {
                $name = self::PREFIX.now()->format('Ymd-His')."-{$i}.tar";
                $path = $dir.'/'.$name;
            }

            // Built beside the package and moved into place in one step, so
            // the listing never shows a half-written archive.
            $tar = $this->openTar($work.'/archive.tar');
            $tar->buildFromDirectory($pkg);
            unset($tar);

            if (! rename($work.'/archive.tar', $path)) {
                throw new RuntimeException("Could not write {$path}.");
            }
            @chmod($path, 0600);
            file_put_contents($path.'.json', json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES));
            @chmod($path.'.json', 0600);

            return ['name' => $name, 'path' => $path, 'size' => (int) filesize($path), 'manifest' => $manifest];
        } finally {
            $this->removeTree($work);
            $lock->release();
        }
    }

    /**
     * Data tables of the live database, sorted. Excludes the transient ones.
     *
     * @return list<string>
     */
    public function tables(): array
    {
        $connection = DB::connection();
        $schema = $connection->getDriverName() === 'sqlite' ? null : $connection->getDatabaseName();

        $names = Schema::getTableListing(schema: $schema, schemaQualified: false);
        $names = array_filter($names, fn ($n) => ! in_array($n, self::SKIP_TABLES, true) && ! str_starts_with($n, 'sqlite_'));
        sort($names);

        return array_values($names);
    }

    private function dumpTable(string $table, string $file): int
    {
        $gz = gzopen($file, 'wb6');
        if ($gz === false) {
            throw new RuntimeException("Cannot write {$file}.");
        }

        $rows = Schema::hasColumn($table, 'id')
            ? DB::table($table)->orderBy('id')->lazyById(1000)
            : DB::table($table)->cursor();

        $count = 0;
        foreach ($rows as $row) {
            gzwrite($gz, json_encode((array) $row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE)."\n");
            $count++;
        }
        gzclose($gz);

        return $count;
    }

    /**
     * @return list<string> archive-relative names of what was collected
     */
    private function collectFiles(string $dir): array
    {
        $files = [];

        file_put_contents($dir.'/app_key', (string) config('app.key'));
        $files[] = 'app_key';

        $secret = (string) config('cortendesk.server_secret');
        if ($secret !== '') {
            file_put_contents($dir.'/server_secret', $secret);
            $files[] = 'server_secret';
        }

        $rd = (string) config('cortendesk.rustdesk_dir');
        if ($rd !== '' && is_dir($rd)) {
            foreach (self::RUSTDESK_FILES as $name) {
                $source = $rd.'/'.$name;
                if (! is_file($source) || ! is_readable($source)) {
                    continue;
                }
                $name === 'db_v2.sqlite3'
                    ? $this->snapshotSqlite($source, $dir.'/rustdesk/'.$name)
                    : copy($source, $dir.'/rustdesk/'.$name);
                $files[] = 'rustdesk/'.$name;
            }
        }

        return $files;
    }

    /**
     * hbbs keeps its peer database open in WAL mode, so a plain copy can miss
     * the last writes. SQLite's own VACUUM INTO produces a consistent snapshot;
     * fall back to a copy when the extension is missing.
     */
    private function snapshotSqlite(string $source, string $dest): void
    {
        try {
            $pdo = new PDO('sqlite:'.$source, null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION, PDO::ATTR_TIMEOUT => 5]);
            $pdo->exec('VACUUM INTO '.$pdo->quote($dest));
            unset($pdo);
            if (is_file($dest)) {
                return;
            }
        } catch (Throwable) {
            // fall through
        }
        @unlink($dest);
        copy($source, $dest);
    }

    // ---- restore ----------------------------------------------------------

    /**
     * Read the manifest out of an archive without extracting the rest.
     *
     * @return array<string, mixed>
     */
    public function readManifest(string $path): array
    {
        try {
            $tar = $this->openTar($path);
            if (! isset($tar['manifest.json'])) {
                throw new RuntimeException('no manifest');
            }
            $manifest = json_decode((string) $tar['manifest.json']->getContent(), true);
        } catch (Throwable) {
            throw new RuntimeException('That file is not a RTDesk backup.');
        }

        if (! is_array($manifest) || ($manifest['app'] ?? null) !== 'cortendesk') {
            throw new RuntimeException('That file is not a RTDesk backup.');
        }
        if ((int) ($manifest['format'] ?? 0) !== self::FORMAT) {
            throw new RuntimeException('That backup was written in a format this version cannot read. Upgrade RTDesk first.');
        }

        return $manifest;
    }

    /**
     * Replace every data table, and stage the server files, from an archive.
     *
     * @return array{
     *   tables: int, rows: int, rekeyed: bool, files: list<string>,
     *   restart_needed: bool, dropped_columns: array<string, list<string>>,
     *   app_version: string
     * }
     */
    public function restore(string $path): array
    {
        $lock = $this->lock();
        $dir = $this->directory();
        $work = $dir.'/.restore-'.bin2hex(random_bytes(4));

        try {
            $manifest = $this->readManifest($path);

            mkdir($work, 0700, true);
            $this->openTar($path)->extractTo($work, null, true);

            $oldKey = trim((string) @file_get_contents($work.'/files/app_key'));
            $rekey = $oldKey !== '' && $oldKey !== (string) config('app.key')
                ? new Encrypter($this->keyBytes($oldKey), (string) config('app.cipher'))
                : null;

            $live = $this->tables();
            $archived = array_keys((array) ($manifest['tables'] ?? []));
            $restore = array_values(array_filter(
                $archived,
                fn ($t) => ! in_array($t, self::KEEP_ON_RESTORE, true) && ! in_array($t, self::SKIP_TABLES, true),
            ));

            $unknown = array_diff($restore, $live);
            if ($unknown !== []) {
                throw new RuntimeException(
                    'The backup was made with RTDesk '.($manifest['app_version'] ?? '?')
                    .' and contains tables this install does not have ('.implode(', ', $unknown).'). Upgrade first, then restore.'
                );
            }

            $result = ['tables' => 0, 'rows' => 0, 'rekeyed' => $rekey !== null, 'files' => [], 'restart_needed' => false, 'dropped_columns' => [], 'app_version' => (string) ($manifest['app_version'] ?? '')];

            $connection = DB::connection();
            Schema::disableForeignKeyConstraints();
            if ($connection->getDriverName() === 'sqlite') {
                // PRAGMA foreign_keys is ignored inside a transaction; this one
                // is honoured and lets parents and children arrive in any order.
                $connection->statement('PRAGMA defer_foreign_keys = ON');
            }

            try {
                $connection->transaction(function () use ($live, $restore, $work, $rekey, &$result) {
                    foreach (array_diff($live, self::KEEP_ON_RESTORE) as $table) {
                        DB::table($table)->delete();
                    }

                    foreach ($restore as $table) {
                        $file = "{$work}/db/{$table}.ndjson.gz";
                        if (! is_file($file)) {
                            continue;
                        }

                        $columns = array_flip(Schema::getColumnListing($table));
                        $dropped = [];
                        $batch = [];
                        $inserted = 0;

                        foreach ($this->readRows($file) as $row) {
                            foreach ($row as $column => $value) {
                                if (! isset($columns[$column])) {
                                    $dropped[$column] = true;
                                    unset($row[$column]);
                                }
                            }
                            if ($rekey !== null && isset(self::ENCRYPTED_COLUMNS[$table])) {
                                foreach (self::ENCRYPTED_COLUMNS[$table] as $column) {
                                    if (array_key_exists($column, $row)) {
                                        $row[$column] = $this->rekey($rekey, $row[$column]);
                                    }
                                }
                            }

                            $batch[] = $row;
                            if (count($batch) >= self::CHUNK) {
                                DB::table($table)->insert($batch);
                                $inserted += count($batch);
                                $batch = [];
                            }
                        }
                        if ($batch !== []) {
                            DB::table($table)->insert($batch);
                            $inserted += count($batch);
                        }

                        $result['tables']++;
                        $result['rows'] += $inserted;
                        if ($dropped !== []) {
                            $result['dropped_columns'][$table] = array_keys($dropped);
                        }
                    }
                });
            } finally {
                Schema::enableForeignKeyConstraints();
            }

            $result['files'] = $this->stageFiles($work.'/files');
            $result['restart_needed'] = $result['files'] !== [];

            // Anything memoised from the old rows is stale now.
            Device::flushOnlineWindowCache();
            app(OidcService::class)->forgetCaches();

            return $result;
        } finally {
            $this->removeTree($work);
            $lock->release();
        }
    }

    /**
     * @return \Generator<int, array<string, mixed>>
     */
    private function readRows(string $file): \Generator
    {
        $gz = gzopen($file, 'rb');
        if ($gz === false) {
            throw new RuntimeException("Cannot read {$file}.");
        }
        try {
            while (($line = gzgets($gz, 1048576 * 16)) !== false) {
                $line = rtrim($line, "\r\n");
                if ($line === '') {
                    continue;
                }
                $row = json_decode($line, true);
                if (! is_array($row)) {
                    throw new RuntimeException('The backup contains a damaged row in '.basename($file).'.');
                }
                yield $row;
            }
        } finally {
            gzclose($gz);
        }
    }

    /**
     * Re-encrypt one value from the archive's key to this install's. Anything
     * that is not a Laravel payload (plain settings, NULLs) passes through.
     */
    private function rekey(Encrypter $old, mixed $value): mixed
    {
        if (! is_string($value) || $value === '') {
            return $value;
        }

        $decoded = json_decode((string) base64_decode($value, true), true);
        if (! is_array($decoded) || ! isset($decoded['iv'], $decoded['value'], $decoded['mac'])) {
            return $value;
        }

        try {
            // Raw in, raw out: the `encrypted` cast serialises before
            // encrypting and encryptString does not, and this keeps either.
            return Crypt::encrypt($old->decrypt($value, false), false);
        } catch (Throwable) {
            return $value;
        }
    }

    private function keyBytes(string $key): string
    {
        if (str_starts_with($key, 'base64:')) {
            $decoded = base64_decode(substr($key, 7), true);
            if ($decoded !== false) {
                return $decoded;
            }
        }

        return $key;
    }

    /**
     * The embedded server's files are not overwritten while hbbs may hold
     * them open. They are staged beside the originals as `<name>.restore`
     * and the container entrypoint swaps them in on the next start.
     *
     * @return list<string> names staged
     */
    private function stageFiles(string $dir): array
    {
        $rd = (string) config('cortendesk.rustdesk_dir');
        if ($rd === '' || ! is_dir($rd) || ! is_writable($rd)) {
            return [];
        }

        $staged = [];
        foreach (self::RUSTDESK_FILES as $name) {
            $source = $dir.'/rustdesk/'.$name;
            if (! is_file($source)) {
                continue;
            }
            if (! @copy($source, $rd.'/'.$name.'.restore')) {
                throw new RuntimeException("Could not stage {$name} into {$rd}.");
            }
            @chmod($rd.'/'.$name.'.restore', $name === 'id_ed25519.pub' ? 0644 : 0600);
            $staged[] = $name;
        }

        return $staged;
    }

    // ---- helpers ----------------------------------------------------------

    /**
     * Open a tar by its bare name from inside its own directory.
     *
     * Given an absolute path, PharData checks each dotted component on the
     * way down ("/var/www/example.com/...") as a possible archive. Under
     * open_basedir each check above the allowed tree warns, Laravel turns
     * the warning into an exception, and backup and restore both failed
     * on such hosts (PR #106). The object keeps the resolved path, so the
     * working directory is only borrowed for the constructor.
     */
    private function openTar(string $path): PharData
    {
        $previous = getcwd();
        if (! @chdir(dirname($path))) {
            throw new RuntimeException('Cannot open '.dirname($path).'.');
        }

        try {
            return new PharData(basename($path));
        } finally {
            if ($previous !== false) {
                @chdir($previous);
            }
        }
    }

    private function lock(): Lock
    {
        $lock = Cache::lock('cortendesk:backup', 3600);
        if (! $lock->get()) {
            throw new RuntimeException('Another backup or restore is still running.');
        }

        return $lock;
    }

    private function removeTree(string $dir): void
    {
        if (! is_dir($dir)) {
            return;
        }
        $items = new \RecursiveIteratorIterator(
            new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS),
            \RecursiveIteratorIterator::CHILD_FIRST,
        );
        foreach ($items as $item) {
            $item->isDir() ? @rmdir($item->getPathname()) : @unlink($item->getPathname());
        }
        @rmdir($dir);
    }

    public static function humanSize(int $bytes): string
    {
        if ($bytes >= 1073741824) {
            return round($bytes / 1073741824, 2).' GB';
        }
        if ($bytes >= 1048576) {
            return round($bytes / 1048576, 1).' MB';
        }
        if ($bytes >= 1024) {
            return round($bytes / 1024).' KB';
        }

        return $bytes.' B';
    }
}
