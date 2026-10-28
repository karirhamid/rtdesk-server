<?php

namespace App\Services\Backups;

use FTP\Connection;
use RuntimeException;

/**
 * Plain FTP or explicit FTPS (AUTH TLS) through PHP's ftp extension, in
 * passive mode, or active mode when the server refuses passive. SFTP is a
 * different protocol and is not supported here, and neither is implicit FTPS
 * (port 990). The extension does not verify the server's certificate.
 *
 * Every public method uses its own connection with at most one transfer
 * after a listing: ProFTPD, which requires data connections to resume the
 * control connection's TLS session, refuses PHP's second one after an upload.
 */
final class FtpTarget implements RemoteTarget
{
    private const TIMEOUT = 15;

    /** How long the server may take to confirm an upload. */
    private const UPLOAD_TIMEOUT = 120;

    /** What a passive data connection that never opened is reported as. */
    private const NO_DATA_CONNECTION = 'the data connection did not open. Check that the server\'s passive port range is open in its firewall';

    private string $path;

    /** @var list<string> warnings from the last ftp_* call; the server's reply ends up here */
    private array $warnings = [];

    /** The server refused PASV on the current connection, so it runs in active mode. */
    private bool $active = false;

    /** Whether data connections use the PASV reply's address, once a listing has shown which works. */
    private ?bool $pasvAddress = null;

    /** The current connection's choice, and what it was made from. */
    private bool $usingPasvAddress = false;

    private ?string $advertised = null;

    private string $hostAddress = '';

    public function __construct(
        private string $host,
        private int $port,
        private string $username,
        private string $password,
        string $path = '',
        private bool $tls = false,
    ) {
        $this->host = trim(trim($host), '[]');
        $this->path = trim($path, '/ ');
        $this->port = $port > 0 ? $port : 21;
    }

    public function label(): string
    {
        return ($this->tls ? 'FTPS ' : 'FTP ').$this->where().($this->path !== '' ? '/'.$this->path : '');
    }

    /**
     * Lists first. That proves the data connection before any of the archive
     * goes out: if PHP and the server disagree about encrypting it, the
     * listing fails and nothing is sent in clear.
     */
    public function put(string $localPath, string $name): void
    {
        $conn = $this->connect();
        try {
            $existed = in_array($name, $this->names($conn), true);
            if ($existed) {
                $remote = $this->sizeOf($conn, $name);
                if ($remote === (int) filesize($localPath)) {
                    return;
                }
                // A copy known to be short goes first: a server that refuses
                // overwrites, or stores a clashing upload under another name,
                // would otherwise keep it.
                if ($remote !== null && $this->quietly(fn () => ftp_delete($conn, $name))) {
                    $existed = false;
                }
            }
            $this->upload($conn, $localPath, $name, $existed, self::UPLOAD_TIMEOUT);
        } finally {
            $this->close($conn);
        }
    }

    /** Sizes are asked for files named like backups only; null where the server will not say. */
    public function list(): array
    {
        $conn = $this->connect();
        try {
            $files = [];
            foreach ($this->names($conn) as $name) {
                $files[$name] = preg_match(BackupService::NAME_PATTERN, $name) ? $this->sizeOf($conn, $name) : null;
            }

            return $files;
        } finally {
            $this->close($conn);
        }
    }

    public function delete(string $name): void
    {
        $conn = $this->connect();
        try {
            if (! $this->quietly(fn () => ftp_delete($conn, $name))) {
                throw $this->failure("FTP delete of {$name} failed");
            }
        } finally {
            $this->close($conn);
        }
    }

    /**
     * List, upload a small file and delete it again: what a backup run does.
     * A login alone proves nothing about the data connection, which is where
     * passive mode and TLS go wrong. The name is new each time, so a file an
     * earlier test could not delete does not change the result.
     */
    public function test(): string
    {
        $conn = $this->connect();
        try {
            $pwd = $this->quietly(fn () => ftp_pwd($conn));
            $this->names($conn);

            $name = 'cortendesk-write-test-'.bin2hex(random_bytes(3)).'.tmp';
            $file = tempnam(sys_get_temp_dir(), 'ftp-test');
            try {
                file_put_contents($file, "RTDesk connection test. Safe to delete.\n");
                if (! $this->upload($conn, $file, $name, false, self::TIMEOUT)) {
                    // The server confirmed late and the connection was closed.
                    $conn = $this->connect();
                }
            } finally {
                @unlink($file);
            }
            if (! $this->quietly(fn () => ftp_delete($conn, $name))) {
                throw $this->failure(
                    "Listing and upload work, but deleting {$name} failed",
                    'Remove it by hand. The off-site copy needs delete permission to drop pruned backups',
                );
            }

            return 'Connected to '.$this->label().(is_string($pwd) ? " (directory {$pwd})" : '').'. Listing, upload and delete work.'
                .($this->active ? ' The server refused passive mode, so active mode is used.' : '');
        } finally {
            $this->close($conn);
        }
    }

    /**
     * Whether data connections should go to the address in the server's PASV
     * reply rather than to the host entered: only when both are public and
     * differ. A server behind NAT or in a container advertises a private
     * address, and a NAS on the LAN may advertise its WAN address; both are
     * reached through the host entered. When the choice is wrong, the first
     * listing tries the other one.
     */
    public static function usePasvAddress(string $advertised, string $host): bool
    {
        $public = fn (string $ip) => filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4 | FILTER_FLAG_GLOBAL_RANGE) !== false;

        return $advertised !== $host && $public($advertised) && $public($host);
    }

    private function connect(): Connection
    {
        if (! function_exists('ftp_connect')) {
            throw new RuntimeException('PHP\'s ftp extension is not installed on this server.');
        }
        if ($this->tls && ! function_exists('ftp_ssl_connect')) {
            throw new RuntimeException('PHP\'s ftp extension was built without TLS support (--with-ftp-ssl), so FTPS is not available on this server.');
        }
        if ($this->host === '') {
            throw new RuntimeException('The FTP host is empty.');
        }

        $this->active = false;
        $started = microtime(true);
        $conn = $this->quietly(fn () => $this->tls
            ? ftp_ssl_connect($this->host, $this->port, self::TIMEOUT)
            : ftp_connect($this->host, $this->port, self::TIMEOUT));

        if ($conn === false) {
            throw $this->unreachable(microtime(true) - $started);
        }

        // With TLS on, AUTH TLS, the handshake and PROT P happen inside ftp_login.
        if (! $this->quietly(fn () => ftp_login($conn, $this->username, $this->password))) {
            $reply = $this->detail();
            // Closed before anything else, so a one-connection-per-address
            // server lets the AUTH TLS check below in.
            $this->close($conn);
            throw $this->loginFailure($reply);
        }

        // ftp_login asks for encrypted data connections (PROT P) before USER
        // and carries on in clear text if the server says no. The archive
        // holds the app key, so ask again after login, as other clients do,
        // and stop on a refusal. A server that only takes PROT P after login
        // says yes here while PHP still sends in clear; the listing before
        // every upload catches that.
        if ($this->tls) {
            $this->quietly(fn () => ftp_raw($conn, 'PBSZ 0'));
            $reply = $this->quietly(fn () => ftp_raw($conn, 'PROT P'));
            $last = is_array($reply) ? (string) end($reply) : '';
            if (! preg_match('/^2\d\d(\s|$)/', $last)) {
                $this->close($conn);
                $last = rtrim($last, '. ');
                throw new RuntimeException('The FTP server did not accept PROT P'.($last !== '' ? " ({$last})" : '').', so data connections would not be encrypted. Nothing was sent. If the server only accepts PROT P after login, PHP\'s FTP client cannot encrypt for it: change the server, or turn TLS off and accept plain FTP.');
            }
        }

        $this->usingPasvAddress = $this->pasvAddress ?? $this->trustPasvAddress($conn);
        $this->quietly(fn () => ftp_set_option($conn, FTP_USEPASVADDRESS, $this->usingPasvAddress));
        if (! $this->quietly(fn () => ftp_pasv($conn, true))) {
            // Some servers only do active mode. That needs the server to
            // reach this host, so it is the fallback, not the default.
            $this->quietly(fn () => ftp_pasv($conn, false));
            $this->active = true;
        }

        // Walk the path one directory at a time, creating what is missing, so
        // a fresh server needs no preparation.
        $walked = [];
        foreach (array_filter(explode('/', $this->path), fn ($s) => $s !== '') as $segment) {
            $walked[] = $segment;
            if ($this->quietly(fn () => ftp_chdir($conn, $segment))) {
                continue;
            }
            $refused = $this->warnings;
            if (! $this->quietly(fn () => ftp_mkdir($conn, $segment)) || ! $this->quietly(fn () => ftp_chdir($conn, $segment))) {
                $this->warnings = [...$refused, ...$this->warnings];
                $e = $this->failure('Cannot enter or create the FTP directory '.implode('/', $walked));
                $this->close($conn);
                throw $e;
            }
        }

        return $conn;
    }

    /** Why ftp_connect gave up, from the warning it left, how long it took, or a second look. */
    private function unreachable(float $seconds): RuntimeException
    {
        $where = $this->where();
        $detail = $this->detail();

        if (str_contains($detail, 'timed out')) {
            // Connected, but no "220" greeting. An SSH server greets with
            // something else straight away; an implicit FTPS one waits.
            if (str_starts_with($this->firstLine(3), 'SSH-')) {
                return new RuntimeException("{$where} is an SSH server. SFTP is not supported; use FTP or explicit FTPS (AUTH TLS), usually on port 21.");
            }

            return new RuntimeException("{$where} accepted the connection but sent no FTP greeting within ".self::TIMEOUT.' seconds. If it expects implicit FTPS (usually port 990), that is not supported: use explicit FTPS (AUTH TLS), usually on port 21.');
        }
        if ($detail !== '') {
            return new RuntimeException("Cannot reach {$where}: {$detail}.");
        }
        if ($seconds >= self::TIMEOUT - 1) {
            return new RuntimeException("Cannot reach {$where}: no answer within ".self::TIMEOUT.' seconds. Check the host, the port and any firewall in between.');
        }

        // A fast failure without a warning is a refused connection, or a
        // server that answered with something other than its 220 greeting
        // (421 too many connections, say). Look again to tell which.
        $error = '';
        $greeting = $this->firstLine(5, $error);
        if ($greeting === '' && $error !== '') {
            return new RuntimeException("Cannot reach {$where}: {$error}. Check the host and the port.");
        }

        return new RuntimeException($greeting !== ''
            ? "{$where} turned the connection away: {$greeting}."
            : "{$where} closed the connection straight away.");
    }

    /** The first line the server sends on a raw connection; $error says why there was none. */
    private function firstLine(int $wait, string &$error = ''): string
    {
        $socket = $this->quietly(function () use (&$error) {
            return stream_socket_client('tcp://'.$this->where(), $errno, $error, self::TIMEOUT);
        });
        if ($socket === false) {
            $error = $error !== '' ? $error : 'connection refused';

            return '';
        }
        stream_set_timeout($socket, $wait);
        $line = rtrim((string) $this->quietly(fn () => fgets($socket)), "\r\n. ");
        fclose($socket);

        return $line;
    }

    /** host:port, with an IPv6 address in brackets. */
    private function where(): string
    {
        $host = filter_var($this->host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) ? "[{$this->host}]" : $this->host;

        return "{$host}:{$this->port}";
    }

    private function loginFailure(string $reply): RuntimeException
    {
        $where = $this->where();

        if ($this->tls) {
            if (str_contains($reply, 'handshake failed')) {
                return new RuntimeException("The TLS handshake with {$where} failed. RTDesk needs TLS 1.2 or later; check that the FTP server offers it.");
            }
            if (preg_match('/SSL (read|write) failed/', $reply)) {
                return new RuntimeException("{$where} closed the TLS session during login ({$reply}). Two common causes: the server failing right after login, such as vsftpd refusing a writable chroot directory (\"500 OOPS\"), or a server that requires a client certificate, which is not supported.");
            }
            // PHP shows the reply to its AUTH SSL retry, which says nothing
            // useful. Ask the question again over a plain connection.
            $auth = $this->authTlsRefusal();
            if ($auth !== null) {
                return new RuntimeException("{$where} does not offer explicit FTPS (AUTH TLS answered: {$auth}). Turn TLS off to use plain FTP, which sends the password in clear.");
            }
        }

        if ($reply === '') {
            return new RuntimeException('FTP login failed. Check the username and password.');
        }

        return new RuntimeException("FTP login failed: {$reply}.".(! $this->tls && preg_match('/\b(TLS|SSL|encrypt)/i', $reply) ? ' Turn TLS on.' : ''));
    }

    /** The server's refusal of AUTH TLS, or null when it accepts it or cannot be asked. */
    private function authTlsRefusal(): ?string
    {
        $conn = $this->quietly(fn () => ftp_connect($this->host, $this->port, self::TIMEOUT));
        if ($conn === false) {
            return null;
        }
        $reply = $this->quietly(fn () => ftp_raw($conn, 'AUTH TLS'));
        // Dropped rather than closed: after a 234 the server expects a TLS
        // handshake, not a plain-text QUIT.
        unset($conn);
        $line = is_array($reply) ? rtrim((string) end($reply), '. ') : '';

        return $line === '' || str_starts_with($line, '234') ? null : $line;
    }

    /** Ask for a passive address once, to decide which address data connections use. */
    private function trustPasvAddress(Connection $conn): bool
    {
        $this->advertised = null;
        $this->hostAddress = filter_var($this->host, FILTER_VALIDATE_IP) ? $this->host : gethostbyname($this->host);

        $reply = $this->quietly(fn () => ftp_raw($conn, 'PASV'));
        $line = is_array($reply) ? (string) end($reply) : '';
        if (! preg_match('/(\d{1,3}),(\d{1,3}),(\d{1,3}),(\d{1,3}),\d{1,3},\d{1,3}/', $line, $m)) {
            return false;
        }
        $this->advertised = "{$m[1]}.{$m[2]}.{$m[3]}.{$m[4]}";

        return self::usePasvAddress($this->advertised, $this->hostAddress);
    }

    /** @return list<string> */
    private function names(Connection $conn): array
    {
        $entries = $this->quietly(fn () => ftp_nlist($conn, '.'));

        // The first listing settles which address data connections use. When
        // the one picked does not open and the server named another, try
        // that: behind something that forwards only port 21, the server's
        // own address is the right one even when it is private.
        if ($entries === false && $this->pasvAddress === null && ! $this->active
            && in_array(self::NO_DATA_CONNECTION, $this->warnings, true)
            && $this->advertised !== null && $this->advertised !== $this->hostAddress) {
            $this->usingPasvAddress = ! $this->usingPasvAddress;
            $this->quietly(fn () => ftp_set_option($conn, FTP_USEPASVADDRESS, $this->usingPasvAddress));
            $this->quietly(fn () => ftp_pasv($conn, true));
            $entries = $this->quietly(fn () => ftp_nlist($conn, '.'));
        }
        if (! in_array(self::NO_DATA_CONNECTION, $this->warnings, true)) {
            $this->pasvAddress ??= $this->usingPasvAddress;
        }

        if ($entries === false && $this->warnings === []) {
            // PHP turns any error reply to NLST into a bare false, and some
            // servers answer NLST that way for an empty directory. LIST
            // tells an empty directory from a refusal.
            $raw = $this->quietly(fn () => ftp_rawlist($conn, '.'));
            $rest = is_array($raw)
                ? array_filter($raw, fn ($line) => ! preg_match('/^total \d+$|\s\.\.?$/i', trim((string) $line)))
                : null;
            if ($rest === []) {
                return [];
            }
            throw $this->failure('FTP directory listing failed', $this->active
                ? $this->activeHint().'. If that works, check that the account may list the directory'
                : 'Check that the account may list the directory');
        }
        if ($entries === false) {
            $timedOut = $this->tls && preg_match('/timed out|handshake failed/i', $this->detail());

            throw $this->failure('FTP directory listing failed', $this->active ? $this->activeHint() : ($timedOut
                ? 'With FTPS this can mean the server accepts PROT P only after login, which PHP\'s FTP client cannot work with'
                : ''));
        }

        // Servers differ on whether NLST returns bare names or paths.
        return array_values(array_filter(
            array_map(fn ($e) => basename((string) $e), $entries),
            fn ($n) => $n !== '' && $n !== '.' && $n !== '..',
        ));
    }

    /** The size the server reports, or null when it will not say plainly (no SIZE, or an odd reply). */
    private function sizeOf(Connection $conn, string $name): ?int
    {
        // SIZE only counts bytes in binary mode; vsftpd refuses it in ASCII
        // mode, which a listing leaves the connection in.
        $this->quietly(fn () => ftp_raw($conn, 'TYPE I'));
        $reply = $this->quietly(fn () => ftp_raw($conn, "SIZE {$name}"));

        return is_array($reply) && preg_match('/^213 (\d+)\s*$/', (string) end($reply), $m) ? (int) $m[1] : null;
    }

    /**
     * Upload, then compare the size the server reports, so a short file does
     * not pass for a finished copy. Whatever a failed upload left behind is
     * removed, but never a file that was there before. Returns false when the
     * upload succeeded only on a second look and $conn has been closed.
     */
    private function upload(Connection $conn, string $localPath, string $name, bool $existed, int $timeout): bool
    {
        $size = (int) filesize($localPath);

        $this->quietly(fn () => ftp_set_option($conn, FTP_TIMEOUT_SEC, $timeout));
        $sent = $this->quietly(fn () => ftp_put($conn, $name, $localPath, FTP_BINARY));
        if (! $sent && count($this->warnings) > 1) {
            // ftp_put ends by repeating the last reply it read, which after a
            // transport error is an old one ("Switching to Binary mode").
            array_pop($this->warnings);
        }
        $transport = $this->detail() === '' || preg_match('/timed out|did not open|accept|establish|data connection|n\'t connect|not connect/i', $this->detail());
        $timedOut = str_contains($this->detail(), 'timed out');
        $e = $sent ? null : $this->failure("FTP upload of {$name} failed", $this->active && $transport ? $this->activeHint() : '');
        $this->quietly(fn () => ftp_set_option($conn, FTP_TIMEOUT_SEC, self::TIMEOUT));

        if ($e !== null) {
            // When a transfer breaks off, PHP stops before the server's final
            // reply. Read the real one; a 500 or 502 is the server not
            // knowing NOOP, not news about the upload.
            $late = $this->quietly(fn () => ftp_raw($conn, 'NOOP'));
            $first = is_array($late) ? (string) ($late[0] ?? '') : '';
            $refused = (bool) preg_match('/^(?!50[02])[45]\d\d[ -](.+)$/', $first, $m);
            if ($refused) {
                $e = new RuntimeException("FTP upload of {$name} failed: ".rtrim($m[1], '. ').'.');
            }
            // Only a confirmation that came late, or none at all, can mean
            // the server has the file after all. A refusal stands, however
            // late it came.
            $mayBeComplete = ! $refused && ($timedOut || preg_match('/^2(26|50)[ -]/', $first));
            // The connection may be a reply behind now; nothing else runs on
            // it, and it is closed first so a server allowing one connection
            // per address lets the cleanup in. Closing again later is harmless.
            $this->close($conn);
            if (! $existed) {
                $state = $this->settle($name, $size, (bool) $mayBeComplete);
                if ($state === 'done') {
                    return false;
                }
                $e = match ($state) {
                    'short' => new RuntimeException(rtrim($e->getMessage(), '.').'. A partial copy is left on the server; the next run replaces it.'),
                    'kept' => new RuntimeException(rtrim($e->getMessage(), '.')."; the server kept a full-size {$name} that could not be removed. The next run counts it as copied, so remove it by hand."),
                    'unknown' => new RuntimeException(rtrim($e->getMessage(), '.')."; a partial {$name} may remain on the server. If the server does not report file sizes, remove it by hand, or the next run counts it as copied."),
                    default => $e,
                };
            }
            throw $e;
        }

        $remote = $this->sizeOf($conn, $name);
        if ($remote !== null && $remote !== $size) {
            $removed = $this->quietly(fn () => ftp_delete($conn, $name));

            throw new RuntimeException("FTP upload of {$name}: the server reports {$remote} bytes instead of {$size}; ".($removed ? 'it was removed.' : 'the next run replaces it.'));
        }

        return true;
    }

    /**
     * After a failed upload, look again over a fresh connection. When the
     * failure may have been only a late confirmation, the full size there
     * means the server finished after all. Anything else is removed. Returns
     * done, removed, short (left, shorter), kept (left, full size but
     * refused) or unknown.
     */
    private function settle(string $name, int $size, bool $mayBeComplete): string
    {
        try {
            $conn = $this->connect();
        } catch (RuntimeException) {
            return 'unknown';
        }
        try {
            if (! in_array($name, $this->names($conn), true)) {
                return 'removed';
            }
            $remote = $this->sizeOf($conn, $name);
            if ($mayBeComplete && $remote === $size) {
                return 'done';
            }
            if ($this->quietly(fn () => ftp_delete($conn, $name))) {
                return 'removed';
            }

            return match (true) {
                $remote === null => 'unknown',
                $remote === $size => 'kept',
                default => 'short',
            };
        } catch (RuntimeException) {
            return 'unknown';
        } finally {
            $this->close($conn);
        }
    }

    private function activeHint(): string
    {
        return 'The server refused passive mode, so active mode was tried; that needs the server to accept PORT and to connect back to this host';
    }

    /**
     * Many servers drop the TLS connection after QUIT without a close_notify,
     * which OpenSSL 3 reports as an error inside ftp_close(). The work is done
     * or has already failed by then, so nothing from the close may surface.
     */
    private function close(Connection $conn): void
    {
        $this->quietly(fn () => ftp_close($conn));
    }

    /**
     * Run a call with its warnings collected instead of thrown. The ftp
     * extension reports the server's reply to a failed command as a warning,
     * and that text is what the operator needs to see. html_errors (on under
     * php-fpm) would escape it before it gets here.
     */
    private function quietly(callable $call): mixed
    {
        $this->warnings = [];
        $html = ini_set('html_errors', '0');
        set_error_handler(function (int $level, string $message): bool {
            $this->warnings[] = self::tidy($message);

            return true;
        });
        try {
            return $call();
        } finally {
            restore_error_handler();
            if ($html !== false) {
                ini_set('html_errors', $html);
            }
        }
    }

    private static function tidy(string $message): string
    {
        $message = preg_replace('/^(ftp_\w+|stream_socket_client|fgets)\(\):\s*/', '', $message);
        $message = preg_replace('/^php_network_getaddresses: getaddrinfo for \S* failed:\s*/', '', $message);

        // A passive data connection that never opened; errno 115 reads as
        // if something were still running.
        if (str_starts_with($message, 'php_connect_nonb() failed')) {
            return self::NO_DATA_CONNECTION;
        }

        return $message;
    }

    private function detail(): string
    {
        return implode('; ', array_unique(array_filter(array_map(fn ($m) => rtrim(trim($m), '. '), $this->warnings))));
    }

    /** The hint is for what the server's own reply does not say. */
    private function failure(string $what, string $hint = ''): RuntimeException
    {
        $detail = $this->detail();

        return new RuntimeException($what.($detail !== '' ? ": {$detail}" : '').'.'.($hint !== '' ? ' '.rtrim($hint, '.').'.' : ''));
    }
}
