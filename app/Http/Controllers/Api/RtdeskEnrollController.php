<?php

namespace App\Http\Controllers\Api;

use App\Http\Controllers\Controller;
use App\Models\ConsoleAudit;
use App\Models\Device;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * RTDESK: every RTDESK install approves itself on the server (approved-only mode) with the
 * enrollment key built into its custom.txt. The stock RustDesk client has no key, so it stays
 * pending. Only a registered, pending device is approved: one the administrator disabled stays
 * disabled, and the machine uuid must match the one the device registered with.
 */
class RtdeskEnrollController extends Controller
{
    /** Generated once on the server (like .server_secret); also given to the console's generator. */
    private const KEY_FILE = '/data/.rtdesk_enroll_key';

    public function enroll(Request $request): JsonResponse
    {
        $key = is_readable(self::KEY_FILE) ? trim((string) file_get_contents(self::KEY_FILE)) : '';
        if ($key === '' || ! hash_equals($key, (string) $request->input('key', ''))) {
            return response()->json(['status' => 'refused'], 403);
        }

        $id = (string) $request->input('id', '');
        $uuid = (string) $request->input('uuid', '');
        if (! preg_match('/^[0-9A-Za-z_-]{6,40}$/', $id)) {
            return response()->json(['status' => 'invalid'], 422);
        }

        $device = Device::withTrashed()->where('rustdesk_id', $id)->first();
        if ($device === null) {
            // Not registered yet (its first sysinfo has not arrived): the client tries again.
            return response()->json(['status' => 'unknown'], 202);
        }
        if ($device->trashed()) {
            return response()->json(['status' => 'disabled']);
        }
        if (! $this->uuidMatches((string) $device->uuid, $uuid)) {
            return response()->json(['status' => 'mismatch'], 409);
        }
        if ($device->isPending()) {
            $device->update(['status' => Device::STATUS_ACTIVE]);
            ConsoleAudit::record('device.approve', 'Approved device '.$id.' (RTDESK enrollment)', 'device', $id);
        }

        return response()->json(['status' => 'active']);
    }

    /** Same rule as SyncController::uuidMatches: raw or base64, an empty side matches. */
    private function uuidMatches(string $stored, string $sent): bool
    {
        if ($stored === '' || $sent === '' || hash_equals($stored, $sent)) {
            return true;
        }
        $decoded = base64_decode($sent, true);

        return $decoded !== false && hash_equals($stored, rtrim($decoded, "\0"));
    }
}
