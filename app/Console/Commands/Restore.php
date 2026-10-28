<?php

namespace App\Console\Commands;

use App\Services\Backups\BackupService;
use Illuminate\Console\Command;
use Throwable;

/**
 * Restore an archive written by cortendesk:backup. Replaces every data table
 * and stages the server files for the next container start.
 */
class Restore extends Command
{
    protected $signature = 'cortendesk:restore
        {backup : A file name in the backup directory, or a path to an archive}
        {--force : Do not ask for confirmation}';

    protected $description = 'Restore the database, settings and server files from a backup archive';

    public function handle(BackupService $backups): int
    {
        $arg = (string) $this->argument('backup');
        $path = is_file($arg) ? realpath($arg) : $backups->path(basename($arg));

        if (! $path) {
            $this->error("No backup found at {$arg}.");

            return self::FAILURE;
        }

        try {
            $manifest = $backups->readManifest($path);
        } catch (Throwable $e) {
            $this->error($e->getMessage());

            return self::FAILURE;
        }

        $this->line('Backup from '.($manifest['created_at'] ?? '?').', RTDesk '.($manifest['app_version'] ?? '?').', '.array_sum((array) ($manifest['tables'] ?? [])).' rows.');

        if (! $this->option('force') && ! $this->confirm('This replaces every setting, user, device and log in this install. Continue?')) {
            return self::SUCCESS;
        }

        try {
            $result = $backups->restore($path);
        } catch (Throwable $e) {
            $this->error('Restore failed, nothing was changed: '.$e->getMessage());

            return self::FAILURE;
        }

        $this->info("Restored {$result['rows']} rows across {$result['tables']} tables.");
        if ($result['rekeyed']) {
            $this->line('Encrypted values were re-keyed to this install\'s APP_KEY.');
        }
        foreach ($result['dropped_columns'] as $table => $columns) {
            $this->warn("{$table}: ignored columns this version does not have (".implode(', ', $columns).')');
        }
        if ($result['restart_needed']) {
            $this->warn('Server files staged ('.implode(', ', $result['files']).'). Restart the container to adopt them.');
        }

        return self::SUCCESS;
    }
}
