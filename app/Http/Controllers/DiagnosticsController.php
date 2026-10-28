<?php

namespace App\Http\Controllers;

use App\Services\FleetDiagnostics;
use Illuminate\View\View;
use Symfony\Component\HttpFoundation\StreamedResponse;

class DiagnosticsController extends Controller
{
    public function index(FleetDiagnostics $diagnostics): View
    {
        return view('diagnostics.index', ['report' => $diagnostics->report()]);
    }

    public function export(FleetDiagnostics $diagnostics): StreamedResponse
    {
        return response()->streamDownload(function () use ($diagnostics): void {
            echo json_encode($diagnostics->sanitized(), JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
        }, 'rtdesk-diagnostics.json', [
            'Cache-Control' => 'no-store, private',
            'Content-Type' => 'application/json',
        ]);
    }
}
