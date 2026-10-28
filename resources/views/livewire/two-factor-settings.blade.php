<div>
    <div class="card">
        <div class="card-header d-flex align-items-center justify-content-between">
            <h4 class="header-title">Two-Factor Authentication</h4>
            @if ($enabled)
                <span class="badge bg-success-subtle text-success"><i class="rd-dot"></i>Enabled</span>
            @else
                <span class="badge bg-secondary-subtle text-secondary">Disabled</span>
            @endif
        </div>
        <div class="card-body">

            {{-- One-time recovery codes (shown right after enable / regenerate) --}}
            @if (! empty($recoveryCodes))
                <div class="alert alert-warning">
                    {{-- Not .rd-empty-title: that component hard-sets --rd-ink and
                         would drop this heading out of the alert's own colour. --}}
                    <p class="fw-semibold mb-1"><i class="ri-key-2-line me-1"></i>Save your recovery codes</p>
                    <p class="mb-2 fs-13">Each code works once. Store them somewhere safe — they're the only way in if you lose your authenticator. <strong>They won't be shown again.</strong></p>
                    <div class="row row-cols-2 g-1 mb-2" id="recovery-codes">
                        @foreach ($recoveryCodes as $code)
                            <div class="col"><span class="rd-codechip">{{ $code }}</span></div>
                        @endforeach
                    </div>
                    {{-- Copy / Download / "I've saved them" need ~276px side by side and the
                         alert offers ~266px at 390px, so the row wraps rather than squeezing
                         the labels. ms-auto on the last one still pushes it right, on
                         whichever line it lands. --}}
                    <div class="d-flex flex-wrap gap-2">
                        <button type="button" class="btn btn-sm btn-light"
                                onclick="rdCopy(Array.from(document.querySelectorAll('#recovery-codes span')).map(e=>e.textContent.trim()).join('\n'), this)">
                            <i class="ri-file-copy-line me-1"></i>Copy
                        </button>
                        <button type="button" class="btn btn-sm btn-light"
                                onclick="(function(){var t=Array.from(document.querySelectorAll('#recovery-codes span')).map(e=>e.textContent.trim()).join('\n');var b=new Blob([t],{type:'text/plain'});var a=document.createElement('a');a.href=URL.createObjectURL(b);a.download='rtdesk-recovery-codes.txt';a.click();})()">
                            <i class="ri-download-2-line me-1"></i>Download
                        </button>
                        <button type="button" class="btn btn-sm btn-primary ms-auto" wire:click="dismissRecoveryCodes">
                            I've saved them
                        </button>
                    </div>
                </div>
            @endif

            @if ($enabled)
                {{-- Enabled state: status + recovery count + disable/regenerate --}}
                @if (empty($recoveryCodes))
                    <p class="text-muted mb-3">
                        Two-factor authentication is protecting your account
                        @if ($confirmedAt)since {{ $confirmedAt->format('Y-m-d') }}@endif.
                        You have <strong>{{ $remaining }}</strong> recovery {{ Str::plural('code', $remaining) }} remaining.
                        @if ($remaining <= 2)
                            <span class="badge bg-warning-subtle text-warning ms-1">Running low — regenerate soon</span>
                        @endif
                    </p>

                    @if ($required)
                        <div class="alert alert-info py-2 fs-13"><i class="ri-lock-line me-1"></i>Your account requires two-factor authentication, so it can't be turned off.</div>
                    @endif

                    <div class="rd-inset">
                        <label class="form-label">Account password</label>
                        <input type="password" class="form-control @error('disablePassword') is-invalid @enderror"
                               wire:model="disablePassword" autocomplete="current-password" style="max-width:320px;">
                        @error('disablePassword') <div class="invalid-feedback d-block">{{ $message }}</div> @enderror
                        {{-- "Regenerate recovery codes" alone is ~180px; with "Disable 2FA"
                             beside it the pair overruns the ~266px inside the inset at 390px. --}}
                        <div class="d-flex flex-wrap gap-2 mt-2">
                            <button type="button" class="btn btn-outline-light" wire:click="regenerateRecoveryCodes">
                                <i class="ri-refresh-line me-1"></i>Regenerate recovery codes
                            </button>
                            @unless ($required)
                                <button type="button" class="btn btn-outline-danger" wire:click="disable">
                                    <i class="ri-shield-cross-line me-1"></i>Disable 2FA
                                </button>
                            @endunless
                        </div>
                        <div class="form-text">Re-enter your password to regenerate codes or disable 2FA.</div>
                    </div>
                @endif

            @elseif ($settingUp)
                {{-- Wizard: scan QR + confirm code --}}
                <p class="text-muted">Scan this QR code with an authenticator app (Google Authenticator, 1Password, Authy…), then enter the 6-digit code it shows.</p>

                <div class="row">
                    <div class="col-md-5 text-center mb-3">
                        <div class="d-inline-block bg-white rounded p-2">{!! $qrSvg !!}</div>
                    </div>
                    <div class="col-md-7">
                        <label class="form-label fs-13 text-muted mb-1">Can't scan? Enter this key manually:</label>
                        <div class="input-group input-group-sm mb-3">
                            <input type="text" class="form-control rd-mono" readonly value="{{ $secret }}">
                            <button class="btn btn-light" type="button" onclick="rdCopyPrevious(this)"><i class="ri-file-copy-line"></i></button>
                        </div>

                        <form wire:submit="confirmSetup">
                            <label class="form-label">Verification code</label>
                            <input type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6"
                                   class="form-control @error('confirmCode') is-invalid @enderror"
                                   wire:model="confirmCode" placeholder="123456" style="max-width:180px;">
                            @error('confirmCode') <div class="invalid-feedback d-block">{{ $message }}</div> @enderror
                            <div class="d-flex gap-2 mt-3">
                                <button type="submit" class="btn btn-primary"><i class="ri-check-line me-1"></i>Verify &amp; enable</button>
                                <button type="button" class="btn btn-outline-light" wire:click="cancelSetup">Cancel</button>
                            </div>
                        </form>
                    </div>
                </div>

            @else
                {{-- Off, not yet setting up --}}
                <p class="text-muted">Add a second step to your console sign-in. After entering your password you'll be asked for a code from your authenticator app.</p>
                @if ($required)
                    <div class="alert alert-warning py-2 fs-13"><i class="ri-error-warning-line me-1"></i>Two-factor authentication is required for your account.</div>
                @endif
                <button type="button" class="btn btn-primary" wire:click="startSetup">
                    <i class="ri-shield-check-line me-1"></i>Enable two-factor authentication
                </button>
            @endif
        </div>
    </div>
</div>
